import * as vscode from 'vscode';
import { TracePoint, TraceTree, MAX_DEPTH } from './types';

export class TraceManager {
    private static readonly SEARCH_RADIUS = 5000;
    private static readonly MAX_REGEX_LENGTH = 2000;
    // How many milliseconds we allow for validation/recovery per tick
    private static readonly VALIDATION_BUDGET_MS = 15;

    private trees: TraceTree[] = [];
    private activeTreeId: string | null = null;

    private activeGroupId: string | null = null;

    // Fast-path lookup for handleTextDocumentChange
    // Maps filePath -> list of traces in that file (from ALL trees or just active? 
    // Plan: Just ACTIVE tree for now to keep things simple and performant, 
    // but the optimized strategy allows us to index ALL trees if we wanted global awareness later.)
    // For now, let's index the ACTIVE tree's traces to solve the immediate bottleneck.
    private traceIndex: Map<string, TracePoint[]> = new Map();

    private activeTraceFiles: Set<string> = new Set();

    private readonly storageKey = 'tracenotes.traces';
    private readonly activeGroupKey = 'tracenotes.activeGroupId';
    private readonly activeTreeKey = 'tracenotes.activeTreeId';

    // Debounce / Batching
    private validationDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    private persistenceDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingValidationDocs: Map<string, vscode.TextDocument> = new Map();
    private _onDidChangeTraces = new vscode.EventEmitter<void>();
    public readonly onDidChangeTraces = this._onDidChangeTraces.event;

    constructor(private context: vscode.ExtensionContext) {
        this.restore();

        // Cleanup validation queue when documents are closed to avoid memory leaks (holding TextDocument references)
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.pendingValidationDocs.delete(doc.uri.toString());
            })
        );
    }

    // ── Persistence ──────────────────────────────────────────────

    /** Restore traces and activeGroupId from workspaceState */
    private restore(): void {
        const saved = this.context.workspaceState.get<any>(this.storageKey);

        if (saved && Array.isArray(saved)) {
            // Check if it's the old format (TracePoint[]) or new format (TraceTree[])
            // Heuristic: Check if the first item has 'traces' property
            const isNewFormat = saved.length > 0 && 'traces' in saved[0];

            if (isNewFormat) {
                this.trees = saved;
            } else {
                // Migration: Wrap existing traces in a default tree
                const defaultTree: TraceTree = {
                    id: 'default',
                    name: 'Default Trace',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    traces: saved, // saved is TracePoint[]
                };
                this.trees = [defaultTree];

                // Persist immediately to lock in the new schema
                this.persist();
            }
        } else {
             // Initialize with a default empty tree if nothing exists
             this.trees = [{
                id: 'default',
                name: 'Default Trace',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                traces: []
            }];
        }

        // Restore activeTreeId
        const savedTreeId = this.context.workspaceState.get<string | null>(this.activeTreeKey);
        if (savedTreeId && this.trees.some(t => t.id === savedTreeId)) {
            this.activeTreeId = savedTreeId;
        } else {
            this.activeTreeId = this.trees[0].id;
        }

        // Restore activeGroupId — validate it still exists in the active tree
        const savedGroupId = this.context.workspaceState.get<string | null>(this.activeGroupKey);
        if (savedGroupId && this.findTraceById(savedGroupId)) {
            this.activeGroupId = savedGroupId;
        } else {
            this.activeGroupId = null;
        }


        // Initialize the fast-path set based on currently loaded trees
        this.rebuildTraceIndex();
    }

    /** Persist current traces to workspaceState (Debounced) */
    private persist(): void {
        // Update updatedTimestamp for the active tree
        const active = this.getActiveTree();
        if (active) {
            active.updatedAt = Date.now();
        }

        // Cancel existing timer
        if (this.persistenceDebounceTimer) {
            clearTimeout(this.persistenceDebounceTimer);
        }

        // Debounce for 2 seconds
        this.persistenceDebounceTimer = setTimeout(() => {
            this.context.workspaceState.update(this.storageKey, this.trees);
            this.persistenceDebounceTimer = undefined;
        }, 2000);
    }

    /** Persist activeGroupId to workspaceState */
    private persistActiveGroup(): void {
        const data = this.activeGroupId !== null ? this.activeGroupId : undefined;
        this.context.workspaceState.update(this.activeGroupKey, data);
    }
    
    /** Persist activeTreeId to workspaceState */
    private persistActiveTree(): void {
        const data = this.activeTreeId !== null ? this.activeTreeId : undefined;
        this.context.workspaceState.update(this.activeTreeKey, data);
    }

    // ── Tree helpers ─────────────────────────────────────────────

    private getActiveTree(): TraceTree | undefined {
        return this.trees.find(t => t.id === this.activeTreeId);
    }

    /** Get the root traces of the active tree */
    private getActiveRootTraces(): TracePoint[] {
        return this.getActiveTree()?.traces || [];
    }

    public getActiveTreeData(): { id: string; name: string } | undefined {
        const tree = this.getActiveTree();
        return tree ? { id: tree.id, name: tree.name } : undefined;
    }

    public renameActiveTree(name: string): void {
        const tree = this.getActiveTree();
        if (tree) {
            tree.name = name;
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    public getTreeList(): { id: string; name: string; active: boolean }[] {
        return this.trees.map(t => ({
            id: t.id,
            name: t.name,
            active: t.id === this.activeTreeId
        }));
    }

    public createTree(name: string): void {
        const newTree: TraceTree = {
            id: crypto.randomUUID(),
            name: name || 'Untitled Trace',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            traces: []
        };
        this.trees.push(newTree);
        this.activeTreeId = newTree.id;

        this.rebuildTraceIndex();
        this.persist();
        this.persistActiveTree();
        this._onDidChangeTraces.fire();
    }

    public switchTree(id: string): void {
        if (this.trees.some(t => t.id === id)) {
            this.activeTreeId = id;
            this.activeGroupId = null; // Reset group nav when switching trees
            this.persistActiveTree();
            this.persistActiveGroup();
            this.rebuildTraceIndex();
            this._onDidChangeTraces.fire();
        }
    }

    public deleteTree(id: string): void {
        const idx = this.trees.findIndex(t => t.id === id);
        if (idx === -1) { return; }

        // Prevent deleting the last tree? 
        // Or just let it happen and create a new default one?
        // Let's enforce keeping at least one.
        if (this.trees.length <= 1) {
            // If deleting the last one, just clear it and rename to Default
            this.trees[0].name = 'Default Trace';
            this.trees[0].traces = [];
            this.activeTreeId = this.trees[0].id;
            this.activeGroupId = null;
            this.persist();
            this.persistActiveTree();
            this.persistActiveGroup();
            this._onDidChangeTraces.fire();
            return;
        }

        this.trees.splice(idx, 1);

        // If we deleted the active tree, switch to another one
        if (this.activeTreeId === id) {
            // Try previous, or first
            const newActive = this.trees[Math.max(0, idx - 1)];
            this.activeTreeId = newActive.id;
            this.activeGroupId = null;
            this.persistActiveTree();
            this.persistActiveGroup();
        }

        this.persist();

        this.rebuildTraceIndex();
        this._onDidChangeTraces.fire();
    }

    /** Recursively find a trace by id */
    findTraceById(id: string, list: TracePoint[] = this.getActiveRootTraces()): TracePoint | undefined {
        for (const t of list) {
            if (t.id === id) { return t; }
            if (t.children?.length) {
                const found = this.findTraceById(id, t.children);
                if (found) { return found; }
            }
        }
        return undefined;
    }

    /** Return the parent array that contains the trace with the given id */
    private findParentList(id: string, list: TracePoint[] = this.getActiveRootTraces()): TracePoint[] | undefined {
        for (const t of list) {
            if (t.id === id) { return list; }
            if (t.children?.length) {
                const found = this.findParentList(id, t.children);
                if (found) { return found; }
            }
        }
        return undefined;
    }

    /** Return the depth of a trace (0 = root level) */
    private getDepth(id: string, list: TracePoint[] = this.getActiveRootTraces(), depth: number = 0): number {
        for (const t of list) {
            if (t.id === id) { return depth; }
            if (t.children?.length) {
                const found = this.getDepth(id, t.children, depth + 1);
                if (found >= 0) { return found; }
            }
        }
        return -1; // not found
    }

    /** Recursively remove a trace by id, returns true if found & removed */
    private removeFromTree(id: string, list: TracePoint[]): boolean {
        const idx = list.findIndex(t => t.id === id);
        if (idx >= 0) {
            list.splice(idx, 1);
            return true;
        }
        for (const t of list) {
            if (t.children?.length && this.removeFromTree(id, t.children)) {
                return true;
            }
        }
        return false;
    }

    // ── Public: CRUD ─────────────────────────────────────────────

    /** Add a trace to the current active group (or root) */
    add(trace: TracePoint): void {
        const target = this.getActiveChildren();
        target.push(trace);

        this.activeTraceFiles.add(trace.filePath);
        
        // Update index immediately for the new trace
        const existing = this.traceIndex.get(trace.filePath) || [];
        existing.push(trace);
        this.traceIndex.set(trace.filePath, existing);

        this.persist();
        this._onDidChangeTraces.fire();
    }

    /** Recursively remove a trace by id from anywhere in the tree */
    remove(id: string): void {
        this.removeFromTree(id, this.getActiveRootTraces());

        // Ensure activeGroupId is still valid (the removed trace might have been the group or its ancestor)
        if (this.activeGroupId && !this.findTraceById(this.activeGroupId)) {
            this.activeGroupId = null;
            this.persistActiveGroup();
        }

        this.rebuildTraceIndex(); // File paths might have been removed
        this.persist();
        this._onDidChangeTraces.fire();
    }

    /** Reorder traces within the current active group */
    reorder(orderedIds: string[]): void {
        const children = this.getActiveChildren();
        const map = new Map(children.map(t => [t.id, t]));
        const reordered: TracePoint[] = [];
        for (const id of orderedIds) {
            const t = map.get(id);
            if (t) { reordered.push(t); }
        }
        // Replace the contents of the array in-place
        children.length = 0;
        children.push(...reordered);
        this.persist();
        this._onDidChangeTraces.fire();
    }

    /** Update the note of a trace (recursive search) */
    updateNote(id: string, note: string): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.note = note;
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    /** Update the highlight color of a trace */
    updateHighlight(id: string, highlight: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.highlight = highlight;
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    /** Relocate a trace to a new file/range/content */
    relocateTrace(id: string, document: vscode.TextDocument, selection: vscode.Selection): void {
        const trace = this.findTraceById(id);
        if (!trace) { return; }

        const oldFilePath = trace.filePath;
        const newFilePath = document.uri.fsPath;
        const isDifferentFile = oldFilePath !== newFilePath;

        // Smart dedent logic (same as collector)
        const text = document.getText(selection);
        const lines = text.split('\n');
        const minIndent = lines.reduce((min, line) => {
            if (line.trim().length === 0) { return min; }
            const match = line.match(/^\s*/);
            const indent = match ? match[0].length : 0;
            return indent < min ? indent : min;
        }, Infinity);
        const effectiveIndent = minIndent === Infinity ? 0 : minIndent;
        const cleanContent = lines
            .map(line => (line.length >= effectiveIndent ? line.slice(effectiveIndent) : line))
            .join('\n');

        // Update trace fields
        trace.filePath = newFilePath;
        trace.rangeOffset = [
            document.offsetAt(selection.start),
            document.offsetAt(selection.end)
        ];
        trace.lineRange = [selection.start.line, selection.end.line];
        trace.content = cleanContent;
        trace.lang = document.languageId;
        // trace.updatedAt is not on TracePoint
        trace.orphaned = false;

        // Update Index if file changed
        if (isDifferentFile) {
            // Remove from old index
            const oldIndexList = this.traceIndex.get(oldFilePath);
            if (oldIndexList) {
                const idx = oldIndexList.findIndex(t => t.id === id);
                if (idx !== -1) {
                    oldIndexList.splice(idx, 1);
                    if (oldIndexList.length === 0) {
                        this.traceIndex.delete(oldFilePath);
                        this.activeTraceFiles.delete(oldFilePath);
                    }
                }
            }

            // Add to new index
            const newIndexList = this.traceIndex.get(newFilePath) || [];
            newIndexList.push(trace);
            this.traceIndex.set(newFilePath, newIndexList);
            this.activeTraceFiles.add(newFilePath);
        } else {
            // Same file: The object reference in the index is the same, so no need to update index list structure,
            // but we might want to resort if we cared about order in index (we don't strictly require it).
        }

        this.persist();
        this._onDidChangeTraces.fire();
    }

    /** Return the full root-level tree (with nested children) */
    getAll(): TracePoint[] {
        return [...this.getActiveRootTraces()];
    }



    public getWorkspaceSyncPayload(): {
        treeId: string;
        treeName: string;
        traces: TracePoint[];
        activeGroupId: string | null;
        activeDepth: number;
        breadcrumb: string;
        treeList: { id: string; name: string; active: boolean }[];
    } {
        const active = this.getActiveTree();
        const basicPayload = active 
            ? { treeId: active.id, treeName: active.name, traces: active.traces }
            : { treeId: '', treeName: 'No Active Trace', traces: [] };

        return {
            ...basicPayload,
            activeGroupId: this.activeGroupId,
            activeDepth: this.getActiveDepth(),
            breadcrumb: this.getActiveBreadcrumb(),
            treeList: this.getTreeList()
        };
    }

    /** Recursively collect every TracePoint across all levels into a flat list */
    getAllFlat(list: TracePoint[] = this.getActiveRootTraces()): TracePoint[] {
        const result: TracePoint[] = [];
        for (const t of list) {
            result.push(t);
            if (t.children?.length) {
                result.push(...this.getAllFlat(t.children));
            }
        }
        return result;
    }

    /** Clear all traces and reset active group */
    clear(): void {
        const activeTree = this.getActiveTree();
        if (activeTree) {
            activeTree.traces = [];
        }
        this.activeGroupId = null;

        this.activeTraceFiles.clear();
        this.traceIndex.clear();
        this.persist();
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
    }

    /** Clear traces in the current active group (or root) */
    clearActiveChildren(): void {
        const children = this.getActiveChildren();
        children.length = 0; // Clear in-place

        this.rebuildTraceIndex();
        this.persist();
        this._onDidChangeTraces.fire();
    }

    // ── Public: Navigation ───────────────────────────────────────

    /** Drill into a trace's children. Returns false if id not found or depth exceeded. */
    enterGroup(id: string): boolean {
        const depth = this.getDepth(id);
        if (depth < 0 || depth >= MAX_DEPTH - 1) { return false; }
        const trace = this.findTraceById(id);
        if (!trace) { return false; }
        // Ensure children array exists
        if (!trace.children) { trace.children = []; }
        this.activeGroupId = id;
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
        return true;
    }

    /** Go up one level. Returns the new activeGroupId (null = root). */
    exitGroup(): string | null {
        if (this.activeGroupId === null) { return null; }
        const parentId = this.findParentTraceId(this.activeGroupId);
        this.activeGroupId = parentId;
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
        return this.activeGroupId;
    }

    /** Find the id of the trace whose children array contains the given id */
    private findParentTraceId(
        id: string,
        list: TracePoint[] = this.getActiveRootTraces(),
    ): string | null {
        for (const t of list) {
            if (t.children?.some(c => c.id === id)) {
                return t.id;
            }
            if (t.children?.length) {
                const found = this.findParentTraceId(id, t.children);
                if (found !== null) { return found; }
            }
        }
        return null; // parent is root
    }

    getActiveGroupId(): string | null {
        return this.activeGroupId;
    }

    /** Return the depth of the active group (0 = root) */
    getActiveDepth(): number {
        if (this.activeGroupId === null) { return 0; }
        const depth = this.getDepth(this.activeGroupId);
        return depth >= 0 ? depth + 1 : 0; // +1 because we're inside the trace
    }

    getActiveBreadcrumb(): string {
        if (this.activeGroupId === null) { return ''; }
        const segments: number[] = [];
        let currentId: string | null = this.activeGroupId;
        while (currentId !== null) {
            const parentList = this.findParentList(currentId);
            if (parentList) {
                const idx = parentList.findIndex(t => t.id === currentId);
                segments.unshift(idx + 1); // 1-based
            }
            currentId = this.findParentTraceId(currentId);
        }
        return segments.join('/') + '/';
    }

    getActiveChildren(): TracePoint[] {
        if (this.activeGroupId === null) { return this.getActiveRootTraces(); }
        const group = this.findTraceById(this.activeGroupId);
        if (!group) {
            this.activeGroupId = null;
            this.persistActiveGroup();
            return this.getActiveRootTraces();
        }
        if (!group.children) { group.children = []; }
        return group.children;
    }

    // ── Synchronization ──────────────────────────────────────────

    /**
     * Handle text document changes SYNCHRONOUSLY to keep offsets accurate,
     * but debounce the heavy validation and disk persistence.
     */
    handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const document = event.document;
        // Important: check ALL trees?? No, probably just the active one for now?
        // Or should we support background updates for inactive trees?
        // For simplicity, let's stick to updating the ACTIVE tree only for now.
        // It's a limitation, but handling N trees in sync might be expensive.
        // ACTUALLY, if I switch back to a tree, I expect its offsets to be valid.
        // So I should update ALL trees. 
        // Let's stick to SINGLE ACTIVE TREE updating for this iteration to avoid performance issues
        // and because the user didn't explicitly ask for background sync of all trees.
        // WAIT, if I don't update them, they become orphaned immediately upon switch if edits happened.
        // That's bad.
        // 
        // Compromise: Update ALL trees in memory (fast offset math).
        
        // Fast-path: If the file is not in our set, return immediately (0ms cost)
        if (!this.activeTraceFiles.has(document.uri.fsPath)) {
            return;
        }
        
        // O(1) Retrieval from Index
        const tracesInFile = this.traceIndex.get(document.uri.fsPath);
        
        if (!tracesInFile || tracesInFile.length === 0) return;

        let needsValidation = false;

        // 1. SYNCHRONOUS OFFSET MATH (Correctly handles bottom-up VS Code changes)
        for (const change of event.contentChanges) {
            const changeStart = change.rangeOffset;
            const changeEnd = changeStart + change.rangeLength;
            const delta = change.text.length - change.rangeLength;

            for (const trace of tracesInFile) {
                if (trace.orphaned) continue;

                if (!trace.rangeOffset) { this.ensureOffsets(document, [trace]); }
                const [start, end] = trace.rangeOffset!;

                if (changeEnd <= start) {
                    trace.rangeOffset = [start + delta, end + delta];
                    needsValidation = true;
                } else if (changeStart >= end) {
                    continue;
                } else {
                    needsValidation = true;
                    if (changeStart >= start && changeEnd <= end) {
                        trace.rangeOffset = [start, end + delta];
                    }
                }
            }
        }

        // 2. QUEUE FOR VALIDATION
        if (needsValidation) {
            // Queue the document by its URI string
            this.pendingValidationDocs.set(document.uri.toString(), document);

            if (this.validationDebounceTimer) {
                clearTimeout(this.validationDebounceTimer);
            }
            this.validationDebounceTimer = setTimeout(() => {
                this.processValidationQueue();
            }, 500);
        }
    }

    private processValidationQueue(): void {
        if (this.pendingValidationDocs.size === 0) return;

        const startTime = Date.now();
        let stateChanged = false;

        // Clone and clear the queue map to iterate safely. 
        // If we yield, we might need to put things back?
        // Better strategy: Process one doc at a time, check budget. 
        // If budget exceeded, put remaining docs back into pendingValidationDocs and schedule another run.
        
        // We iterate the map directly. We can't easily "put back" into the front if we cleared it.
        // So let's NOT clear immediately. Iterate and remove handled ones.
        
        const iterator = this.pendingValidationDocs.entries();
        let result = iterator.next();

        while (!result.done) {
            const [uri, document] = result.value;
            
            // Check budget
            if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
                // Time's up for this tick. Schedule continuation.
                if (this.validationDebounceTimer) { clearTimeout(this.validationDebounceTimer); }
                this.validationDebounceTimer = setTimeout(() => {
                    this.processValidationQueue();
                }, 0); // Immediate (next tick)
                break;
            }

            // Remove current from queue as we process it
            this.pendingValidationDocs.delete(uri);
            
            // Process the document
            const tracesInFile = this.traceIndex.get(document.uri.fsPath);
            if (tracesInFile) {
                for (const trace of tracesInFile) {
                    // Check budget inside trace loop for documents with MANY traces
                     if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
                        // Put this doc back in queue! 
                        // We haven't finished this doc.
                        // Ideally we resume where we left off, but re-processing some traces is okay.
                        // Or we can just break and let the outer loop handle "re-queueing".
                        // Use pendingValidationDocs.set(uri, document) to ensure it stays.
                        this.pendingValidationDocs.set(uri, document);
                        break; 
                    }

                    if (!trace.rangeOffset) continue;

                    const [startOffset, endOffset] = trace.rangeOffset;
                    
                    if (startOffset < 0 || endOffset > document.getText().length) {
                        trace.orphaned = true;
                        stateChanged = true;
                        continue;
                    }

                    const startPos = document.positionAt(startOffset);
                    const endPos = document.positionAt(endOffset);
                    
                    // Update lineRange and check for changes
                    const newStartLine = startPos.line;
                    const newEndLine = endPos.line;
                    
                    if (!trace.lineRange || trace.lineRange[0] !== newStartLine || trace.lineRange[1] !== newEndLine) {
                        trace.lineRange = [newStartLine, newEndLine];
                        stateChanged = true;
                    }

                    const currentContent = document.getText(new vscode.Range(startPos, endPos));
                    
                    if (!this.contentMatches(currentContent, trace.content)) {
                        // RECOVERY: This is the expensive part (Regex)
                        const recovered = this.recoverTracePoints(document, trace.content, startOffset);
                        if (recovered) {
                            trace.rangeOffset = recovered;
                            const rStart = document.positionAt(recovered[0]);
                            const rEnd = document.positionAt(recovered[1]);
                            trace.lineRange = [rStart.line, rEnd.line];
                            trace.orphaned = false;
                        } else {
                            trace.orphaned = true;
                        }
                        stateChanged = true;
                    } else if (trace.orphaned) {
                        trace.orphaned = false;
                        stateChanged = true;
                    }
                }
            }

            result = iterator.next();
        }

        if (stateChanged) {
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    /**
     * Ensure traces have valid rangeOffset. 
     * Uses lineRange to calculate initial offsets if missing.
     */
    private ensureOffsets(document: vscode.TextDocument, traces: TracePoint[]): void {
        for (const t of traces) {
            // If rangeOffset is missing (migration) or obviously invalid
            if (!t.rangeOffset || t.rangeOffset.length !== 2) {
                if (t.lineRange) {
                    // Best effort migration
                    try {
                        const startLine = t.lineRange[0];
                        const endLine = t.lineRange[1];
                        // Validate lines
                        if (startLine < document.lineCount) {
                            const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
                            const endOffsetLine = Math.min(endLine, document.lineCount - 1);
                            const endLineText = document.lineAt(endOffsetLine).text;
                            const endOffset = document.offsetAt(new vscode.Position(endOffsetLine, endLineText.length));
                            t.rangeOffset = [startOffset, endOffset];
                        } else {
                            t.rangeOffset = [0, 0];
                            t.orphaned = true;
                        }
                    } catch {
                        t.rangeOffset = [0, 0];
                        t.orphaned = true;
                    }
                } else {
                    t.rangeOffset = [0, 0];
                    t.orphaned = true;
                }
            }
        }
    }

    private recoverTracePoints(
        document: vscode.TextDocument, 
        storedContent: string, 
        lastKnownStart: number
    ): [number, number] | null {
        const fullText = document.getText();
        
        const searchStart = Math.max(0, lastKnownStart - TraceManager.SEARCH_RADIUS);
        const searchEnd = Math.min(fullText.length, lastKnownStart + TraceManager.SEARCH_RADIUS + storedContent.length);
        const searchArea = fullText.slice(searchStart, searchEnd);

        let idx = searchArea.indexOf(storedContent);
        if (idx >= 0) {
            const absoluteStart = searchStart + idx;
            return [absoluteStart, absoluteStart + storedContent.length];
        }

        if (storedContent.length <= TraceManager.MAX_REGEX_LENGTH) {
            const escapedContent = storedContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flexibleRegexStr = escapedContent.replace(/\s+/g, '\\s+');
            
            try {
                const regex = new RegExp(flexibleRegexStr, 'g');
                const match = regex.exec(searchArea);
                
                if (match) {
                    const absoluteStart = searchStart + match.index;
                    const absoluteEnd = absoluteStart + match[0].length;
                    return [absoluteStart, absoluteEnd];
                }
            } catch (e) {
                console.warn('Trace recovery regex compilation failed', e);
            }
        }

        const minAnchorLength = 20;
        const contentLines = storedContent.trim().split('\n');
        
        if (contentLines.length >= 3 && storedContent.length > minAnchorLength * 2) {
            const headText = contentLines[0].trim();
            const tailText = contentLines[contentLines.length - 1].trim();
            
            // 在 searchArea 尋找頭部
            const headIdx = searchArea.indexOf(headText);
            if (headIdx >= 0) {
                // 從頭部往後尋找尾部 (限制在合理的長度範圍內)
                const expectedTailPos = headIdx + storedContent.length;
                const searchTailStart = Math.max(headIdx, expectedTailPos - 500);
                const searchTailEnd = Math.min(searchArea.length, expectedTailPos + 500);
                
                const tailSearchArea = searchArea.slice(searchTailStart, searchTailEnd);
                const tailIdxInSlice = tailSearchArea.indexOf(tailText);
                
                if (tailIdxInSlice >= 0) {
                    const absoluteStart = searchStart + headIdx;
                    const absoluteEnd = searchStart + searchTailStart + tailIdxInSlice + tailText.length;
                    return [absoluteStart, absoluteEnd];
                }
            }
        }

        idx = fullText.indexOf(storedContent);
        if (idx >= 0) {
            return [idx, idx + storedContent.length];
        }

        return null;
    }

    private contentMatches(docContent: string, storedContent: string): boolean {
        // Normalize both by collapsing all whitespace to a single space or empty
        const normDoc = docContent.replace(/\s+/g, ' ').trim();
        const normStored = storedContent.replace(/\s+/g, ' ').trim();
        return normDoc === normStored;
    }


    /**
     * Rebuilds the fast-path Index (Map<filePath, TracePoint[]>).
     * Should be called whenever traces are added, removed, or trees are switched/deleted.
     */
    private rebuildTraceIndex(): void {
        this.activeTraceFiles.clear();
        this.traceIndex.clear();
        
        const visit = (traces: TracePoint[]) => {
            for (const t of traces) {
                this.activeTraceFiles.add(t.filePath);
                
                const list = this.traceIndex.get(t.filePath) || [];
                list.push(t);
                this.traceIndex.set(t.filePath, list);

                if (t.children && t.children.length > 0) {
                    visit(t.children);
                }
            }
        };

        // Only index the ACTIVE tree to keep things simple for now. 
        // If the user switches trees, we rebuild the index.
        const activeTree = this.getActiveTree();
        if (activeTree) {
            visit(activeTree.traces);
        }
    }

    /** Public Accessor for efficient extensions usage */
    public getTracesForFile(filePath: string): TracePoint[] {
        return this.traceIndex.get(filePath) || [];
    }

    // ── Import Logic ─────────────────────────────────────────────

    public async importTraceTree(markdown: string, treeName?: string): Promise<void> {
        try {
            const importedTraces = await this.parseMarkdown(markdown);
            
            // Create a new tree for the imported traces
            const finalTreeName = treeName || `Imported Trace ${new Date().toLocaleString()}`;
            const newTree: TraceTree = {
                id: crypto.randomUUID(),
                name: finalTreeName,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                traces: importedTraces
            };

            this.trees.push(newTree);
            this.activeTreeId = newTree.id;
            this.rebuildTraceIndex();
            this.persist();
            this.persistActiveTree();
            this._onDidChangeTraces.fire();
        } catch (error) {
            console.error('Failed to import trace tree:', error);
            throw error;
        }
    }

    private async parseMarkdown(markdown: string): Promise<TracePoint[]> {
        const lines = markdown.split('\n');
        const rootTraces: TracePoint[] = [];
        const stack: { trace: TracePoint, depth: number }[] = [];

        let currentTrace: Partial<TracePoint> | null = null;
        let currentContent: string[] = [];
        let capturingContent = false;

        // RegExp to match headers: ## 1. Title (Orphaned)
        const headerRegex = /^(#+)\s+\d+\.\s+(.*)/;
        
        // RegExp to match code block start: ```language startLine:endLine:filePath
        const codeBlockStartRegex = /^```(\w*)\s+(\d+|\?):(\d+|\?):(.+)$/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('```') && !capturingContent) {
                // Check if it's the start of a trace content block
                const match = line.match(codeBlockStartRegex);
                if (match && currentTrace) {
                    capturingContent = true;
                    currentTrace.lang = match[1];
                    const startLine = match[2] === '?' ? 0 : parseInt(match[2]) - 1;
                    const endLine = match[3] === '?' ? 0 : parseInt(match[3]) - 1;
                    // filePath is match[4], but we might need to validation/normalization
                    // For now, assume absolute path from export
                    const filePath = match[4].trim(); 
                    currentTrace.filePath = filePath;
                    currentTrace.lineRange = [startLine, endLine];
                }
                continue;
            }

            if (line.startsWith('```') && capturingContent) {
                capturingContent = false;
                if (currentTrace) {
                    currentTrace.content = currentContent.join('\n');
                    currentContent = [];
                    
                    // Validate and Recover
                    const validated = await this.validateAndRecover(currentTrace as TracePoint);
                    if (validated) {
                        const trace = validated;
                        
                        // Determine parent based on depth
                        // Header depth: # = h1 (File title), ## = h2 (Root trace), ### = h3 (Child)
                        // In export: Root = ## (depth 0), Child = ### (depth 1)
                        // currentTrace.depth is derived from header length
                        // Let's rely on the stack
                        
                        // If stack is empty, push to root
                        while (stack.length > 0 && stack[stack.length - 1].depth >= (currentTrace as any)._tempDepth) {
                            stack.pop();
                        }
                        
                        if (stack.length > 0) {
                            const parent = stack[stack.length - 1].trace;
                            if (!parent.children) parent.children = [];
                            parent.children.push(trace);
                        } else {
                            rootTraces.push(trace);
                        }
                        
                        stack.push({ trace, depth: (currentTrace as any)._tempDepth });
                    }
                    
                    currentTrace = null;
                }
                continue;
            }

            if (capturingContent) {
                currentContent.push(line);
                continue;
            }

            // Check for new trace header
            const headerMatch = line.match(headerRegex);
            if (headerMatch) {
                const hashes = headerMatch[1];
                const rawTitle = headerMatch[2].trim();
                
                // depth 0 is ## (length 2)
                const depth = hashes.length - 2;
                if (depth < 0) continue; // Skip document title #

                // Clean title (remove Orphaned tag)
                let title = rawTitle;
                let isOrphaned = false;
                if (title.endsWith('(Orphaned)')) {
                    title = title.replace('(Orphaned)', '').trim();
                }
                // Also check if orphaned was in the note/title in a different way? 
                // Export format: `${title} ${t.orphaned ? '(Orphaned)' : ''}`
                
                currentTrace = {
                    id: crypto.randomUUID(),
                    note: title,
                    orphaned: isOrphaned,
                    children: [],
                    _tempDepth: depth // Helper for stack management
                } as any;
                
            } else if (currentTrace && line.trim().length > 0 && !line.trim().startsWith('---')) {
                // Append to note if it's not a separator
                 currentTrace.note += '\n' + line;
            }
        }
        
        return rootTraces;
    }

    private async validateAndRecover(trace: TracePoint): Promise<TracePoint | null> {
        try {
            // Check if file exists
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(trace.filePath));
            } catch {
                console.warn('Trace import skipped missing file:', trace.filePath);
                return null;
            }

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(trace.filePath));
            
            // 1. Check exact match at coordinates
            if (trace.lineRange) {
                const [startLine, endLine] = trace.lineRange;
                if (startLine < doc.lineCount) {
                     const startPos = new vscode.Position(startLine, 0);
                     const endLineObj = doc.lineAt(Math.min(endLine, doc.lineCount - 1));
                     const endPos = endLineObj.range.end;
                     
                     const text = doc.getText(new vscode.Range(startPos, endPos));
                     
                     if (this.contentMatches(text, trace.content)) {
                         trace.rangeOffset = [doc.offsetAt(startPos), doc.offsetAt(endPos)];
                         trace.orphaned = false;
                         return trace;
                     }
                }
            }
            
            // 2. Mismatch or invalid coords -> Recover
            let estimatedOffset = 0;
            if (trace.lineRange && trace.lineRange[0] < doc.lineCount) {
                estimatedOffset = doc.offsetAt(new vscode.Position(trace.lineRange[0], 0));
            }

            const recovered = this.recoverTracePoints(doc, trace.content, estimatedOffset);
            if (recovered) {
                // SUCCESS: Update locations
                trace.rangeOffset = recovered;
                const rStart = doc.positionAt(recovered[0]);
                const rEnd = doc.positionAt(recovered[1]);
                trace.lineRange = [rStart.line, rEnd.line];
                trace.orphaned = false;
                return trace;
            } else {
                // FAILURE: 
                // If original lineRange is within the file, use it and mark Red.
                if (trace.lineRange && trace.lineRange[0] < doc.lineCount) {
                    const startLine = trace.lineRange[0];
                    const endLine = trace.lineRange[1]; // tolerant of endLine > doc.lineCount

                    const effectiveEndLine = Math.min(endLine, doc.lineCount - 1);
                    const startPos = new vscode.Position(startLine, 0);
                    const endLineObj = doc.lineAt(effectiveEndLine);
                    const endPos = endLineObj.range.end;

                    trace.rangeOffset = [doc.offsetAt(startPos), doc.offsetAt(endPos)];
                    trace.orphaned = false; // Logic: It is broken
                    trace.highlight = 'red'; // Logic: Visual cue

                    return trace;
                } else {
                    // Invalid range or file skipped -> Drop
                    trace.orphaned = true;
                    return null;
                }
            }
        } catch (e) {
            console.warn('Trace import error:', e);
            return null;
        }
    }
}
