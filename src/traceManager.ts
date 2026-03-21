import * as vscode from 'vscode';
import * as path from 'path';
import { TracePoint, TraceTree, MAX_DEPTH, HIGHLIGHT_TO_TAG } from './types';
import { generateIsomorphicUUID } from './utils/uuid';
import { FileStorageManager } from './storage/FileStorageManager';

export interface ITraceDocument {
    lineCount: number;
    offsetAt(position: vscode.Position): number;
    positionAt(offset: number): vscode.Position;
    lineAt(line: number): { range: { end: vscode.Position } };
    getText(range?: vscode.Range): string;
}

export interface Token {
    text: string;
    offset: number;
    type: 'code' | 'string' | 'comment';
}

export class TraceManager implements vscode.Disposable {
    private static readonly VALIDATION_BUDGET_MS = 15;

    private trees: TraceTree[] = [];
    private activeTreeId: string | null = null;
    private activeGroupId: string | null = null;

    // Fast-path lookup maps
    private traceIndex: Map<string, Set<TracePoint>> = new Map();
    private traceIdMap: Map<string, TracePoint> = new Map();
    private parentIdMap: Map<string, string | null> = new Map();

    private readonly storageKey = 'tracenotes.traces';
    private readonly activeGroupKey = 'tracenotes.activeGroupId';
    private readonly activeTreeKey = 'tracenotes.activeTreeId';

    // File-based storage manager (atomic writes via vscode.workspace.fs)
    private readonly fileStorage: FileStorageManager;

    // Debounce / Batching
    private validationDebounceTimer: NodeJS.Timeout | undefined;
    private persistenceDebounceTimer: NodeJS.Timeout | undefined;
    private validationCts: vscode.CancellationTokenSource | undefined;
    private treeValidationCts: vscode.CancellationTokenSource | undefined;
    private pendingValidationDocs: Map<string, { uri: vscode.Uri; version: number }> = new Map();

    // Initialization readiness
    private _readyPromise: Promise<void>;

    // Dirty flag: true when in-memory state has not yet been flushed to disk
    private isDirty: boolean = false;

    private _onDidChangeTraces = new vscode.EventEmitter<{ focusId?: string } | void>();
    public readonly onDidChangeTraces = this._onDidChangeTraces.event;

    constructor(private context: vscode.ExtensionContext) {
        this.fileStorage = new FileStorageManager(context);

        // Initialize async; default state is set synchronously so the manager
        // is usable immediately while file I/O completes in the background.
        this.initializeDefaults();

        // Store the promise so commands can await readiness before mutating data.
        this._readyPromise = this.initialize().catch(err => {
            console.error('TraceNotes: Fatal error during initialization', err);
            vscode.window.showErrorMessage('TraceNotes failed to load your data. Check the Output panel (TraceNotes Storage) for details.');
        });

        // Cleanup validation queue when documents are closed to avoid memory leaks
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.pendingValidationDocs.delete(doc.uri.toString());
            })
        );
    }

    /**
     * Resolves once initialization from disk is complete.
     * Commands that mutate or read persisted data should await this first
     * to prevent the initialization race condition.
     */
    public async ensureReady(): Promise<void> {
        await this._readyPromise;
    }

    /** * IMPORTANT: Clean up all resources when the extension deactivates 
     * or the manager is destroyed to prevent memory leaks.
     */
    public dispose(): void {
        this._onDidChangeTraces.dispose();

        if (this.validationCts) {
            this.validationCts.cancel();
            this.validationCts.dispose();
        }
        if (this.treeValidationCts) {
            this.treeValidationCts.cancel();
            this.treeValidationCts.dispose();
        }
        if (this.validationDebounceTimer) {
            clearTimeout(this.validationDebounceTimer);
        }
        if (this.persistenceDebounceTimer) {
            clearTimeout(this.persistenceDebounceTimer);
        }

        this.pendingValidationDocs.clear();
        this.traceIndex.clear();
        this.traceIdMap.clear();
        this.parentIdMap.clear();
    }

    // ── Persistence ──────────────────────────────────────────────

    /** Sets up a safe empty default so the manager is usable before file I/O finishes. */
    private initializeDefaults(): void {
        this.trees = [{
            id: 'default',
            name: 'Default Trace',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            traces: []
        }];
        this.activeTreeId = this.trees[0].id;
        this.activeGroupId = null;
        this.rebuildTraceIndex();
    }

    /**
     * Async initialization: loads trees from the JSON file on disk.
     * If no file exists yet, migrates from workspaceState (one-time migration).
     * After loading, updates all derived state and fires a change event so the
     * UI re-renders with the restored data.
     */
    private async initialize(): Promise<void> {
        let loaded = await this.fileStorage.load();

        if (loaded === null) {
            // ── One-time migration from workspaceState ──────────────
            const saved = this.context.workspaceState.get<any>(this.storageKey);
            if (saved && Array.isArray(saved)) {
                const isNewFormat = saved.length > 0 && 'traces' in saved[0];
                if (isNewFormat) {
                    loaded = saved as TraceTree[];
                } else {
                    // Legacy flat-array format → wrap in a default tree
                    loaded = [{
                        id: 'default',
                        name: 'Default Trace',
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        traces: saved,
                    }];
                }
                // Persist migrated data to file immediately
                await this.fileStorage.save(loaded);
                // Clear old workspaceState entry to free space
                await this.context.workspaceState.update(this.storageKey, undefined);
            }
        }

        if (loaded && loaded.length > 0) {
            this.trees = loaded;
        }
        // else: keep the defaults from initializeDefaults()

        // Restore active tree selection
        const savedTreeId = this.context.workspaceState.get<string | null>(this.activeTreeKey);
        this.activeTreeId = (savedTreeId && this.trees.some(t => t.id === savedTreeId))
            ? savedTreeId
            : this.trees[0].id;

        // Rebuild index before resolving activeGroupId
        this.rebuildTraceIndex();

        const savedGroupId = this.context.workspaceState.get<string | null>(this.activeGroupKey);
        this.activeGroupId = (savedGroupId && this.findTraceById(savedGroupId)) ? savedGroupId : null;

        // Notify UI that restored data is ready
        this._onDidChangeTraces.fire();
    }

    private persist(): void {
        const active = this.getActiveTree();
        if (active) {
            active.updatedAt = Date.now();
        }

        // Mark in-memory state as unsaved
        this.isDirty = true;

        if (this.persistenceDebounceTimer) {
            clearTimeout(this.persistenceDebounceTimer);
        }

        this.persistenceDebounceTimer = setTimeout(() => {
            this.persistenceDebounceTimer = undefined;
            this.flush().catch(err => {
                console.error('TraceNotes: Background save failed', err);
                vscode.window.showWarningMessage('TraceNotes: Failed to save your data. Check the Output panel for details.');
            });
        }, 2000);
    }

    /**
     * Forces an immediate save, bypassing the debounce timer.
     * Must be called during the extension's `deactivate` lifecycle event
     * to prevent data loss when VS Code closes while a debounced save is pending.
     */
    public async flush(): Promise<void> {
        // Cancel any pending debounced save — we're doing it now.
        if (this.persistenceDebounceTimer) {
            clearTimeout(this.persistenceDebounceTimer);
            this.persistenceDebounceTimer = undefined;
        }

        if (!this.isDirty) {
            return; // Nothing new to write
        }

        this.isDirty = false; // Optimistically clear before the async write
        try {
            await this.fileStorage.save(this.trees);
        } catch (err) {
            this.isDirty = true; // Revert on failure so the next flush retries
            throw err;
        }
    }

    private persistActiveGroup(): void {
        this.context.workspaceState.update(this.activeGroupKey, this.activeGroupId ?? undefined);
    }

    private persistActiveTree(): void {
        this.context.workspaceState.update(this.activeTreeKey, this.activeTreeId ?? undefined);
    }

    // ── Tree helpers ─────────────────────────────────────────────

    private getActiveTree(): TraceTree | undefined {
        return this.trees.find(t => t.id === this.activeTreeId);
    }

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
            this.activeGroupId = null;
            this.persistActiveTree();
            this.persistActiveGroup();
            this.rebuildTraceIndex();
            this._onDidChangeTraces.fire();

            this.validateActiveTreeBackground();
        }
    }

    private async validateActiveTreeBackground(): Promise<void> {
        if (this.treeValidationCts) {
            this.treeValidationCts.cancel();
            this.treeValidationCts.dispose();
        }

        const cts = new vscode.CancellationTokenSource();
        this.treeValidationCts = cts;
        const token = cts.token;

        const traces = this.getAllFlat();
        let stateChanged = false;

        for (const trace of traces) {
            if (token.isCancellationRequested) {
                return;
            }

            const originalOffset = trace.rangeOffset ? [...trace.rangeOffset] : null;
            const originalOrphaned = trace.orphaned;
            const originalHighlight = trace.highlight;
            const originalLineRange = trace.lineRange ? [...trace.lineRange] : null;

            await this.validateAndRecover(trace, true, token);

            if (token.isCancellationRequested) {
                return;
            }

            const offsetChanged = (!originalOffset && !!trace.rangeOffset) || 
                                  (!!originalOffset && !!trace.rangeOffset && (originalOffset[0] !== trace.rangeOffset[0] || originalOffset[1] !== trace.rangeOffset[1]));
            const orphanedChanged = originalOrphaned !== trace.orphaned;
            const highlightChanged = originalHighlight !== trace.highlight;
            const lineRangeChanged = (!originalLineRange && !!trace.lineRange) || 
                                     (!!originalLineRange && !!trace.lineRange && (originalLineRange[0] !== trace.lineRange[0] || originalLineRange[1] !== trace.lineRange[1]));

            if (offsetChanged || orphanedChanged || highlightChanged || lineRangeChanged) {
                stateChanged = true;
            }

            // Yield to event loop to avoid freezing UI
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (!token.isCancellationRequested && stateChanged) {
            this.persist();
            this._onDidChangeTraces.fire();
        }

        if (this.treeValidationCts === cts) {
            this.treeValidationCts = undefined;
        }
    }

    public deleteTree(id: string): void {
        const idx = this.trees.findIndex(t => t.id === id);
        if (idx === -1) { return; }

        if (this.trees.length <= 1) {
            this.trees[0].name = 'Default Trace';
            this.trees[0].traces = [];
            this.activeTreeId = this.trees[0].id;
            this.activeGroupId = null;
        } else {
            this.trees.splice(idx, 1);
            if (this.activeTreeId === id) {
                const newActive = this.trees[Math.max(0, idx - 1)];
                this.activeTreeId = newActive.id;
                this.activeGroupId = null;
            }
        }

        this.persistActiveTree();
        this.persistActiveGroup();
        this.persist();
        this.rebuildTraceIndex();
        this._onDidChangeTraces.fire();
    }

    public findTraceById(id: string): TracePoint | undefined {
        return this.traceIdMap.get(id);
    }

    private findParentList(id: string): TracePoint[] | undefined {
        const parentId = this.parentIdMap.get(id);
        if (parentId === undefined) { return undefined; }
        if (parentId === null) {
            return this.getActiveRootTraces();
        }
        const parent = this.traceIdMap.get(parentId);
        return parent ? parent.children : undefined;
    }

    private getDepth(id: string): number {
        if (!this.traceIdMap.has(id)) { return -1; }
        let d = 0;
        let curr = id;
        while (true) {
            const parentId = this.parentIdMap.get(curr);
            if (parentId === undefined) { return -1; }
            if (parentId === null) { return d; }
            curr = parentId;
            d++;
        }
    }

    private removeFromTree(id: string): boolean {
        if (!this.traceIdMap.has(id)) { return false; }

        const parentList = this.findParentList(id);
        if (!parentList) { return false; }

        const idx = parentList.findIndex(t => t.id === id);
        if (idx >= 0) {
            parentList.splice(idx, 1);
            return true;
        }
        return false;
    }

    public moveToChild(traceId: string, targetId: string): void {
        const trace = this.findTraceById(traceId);
        if (!trace) return;

        if (this.isDescendant(traceId, targetId)) {
            vscode.window.showErrorMessage("TraceNotes: Cannot move a trace into its own descendant.");
            this._onDidChangeTraces.fire();
            return;
        }

        const targetDepth = this.getDepth(targetId);
        if (targetDepth >= MAX_DEPTH - 1) {
            vscode.window.showErrorMessage("TraceNotes: Maximum trace depth reached.");
            this._onDidChangeTraces.fire();
            return;
        }

        this.removeFromTree(traceId);

        const target = this.findTraceById(targetId);
        if (target) {
            if (!target.children) { target.children = []; }
            target.children.unshift(trace); // Insert at the top for better UX
            this.parentIdMap.set(traceId, targetId);
        }

        this.persist();
        this._onDidChangeTraces.fire();
    }

    public moveToParent(traceId: string): void {
        const trace = this.findTraceById(traceId);
        if (!trace) return;

        const currentParentId = this.findParentTraceId(traceId);
        if (currentParentId === null) {
            this._onDidChangeTraces.fire();
            return; // Already at root
        }

        const grandParentId = this.findParentTraceId(currentParentId);
        
        // 1. Resolve target location FIRST
        let targetArray: TracePoint[] | undefined;
        if (grandParentId === null) {
            const activeTree = this.getActiveTree();
            if (!activeTree) {
                vscode.window.showErrorMessage("TraceNotes: Failed to find active tree.");
                return; // Abort before mutating
            }
            targetArray = activeTree.traces;
        } else {
            const grandParent = this.findTraceById(grandParentId);
            if (!grandParent) return; // Abort
            if (!grandParent.children) grandParent.children = [];
            targetArray = grandParent.children;
        }

        // Find the index of the original parent to place the trace right after it
        const currentParentIndex = targetArray.findIndex(t => t.id === currentParentId);

        // 2. Safely perform the move
        this.removeFromTree(traceId);
        
        if (currentParentIndex >= 0) {
            targetArray.splice(currentParentIndex + 1, 0, trace);
        } else {
            targetArray.push(trace);
        }

        this.parentIdMap.set(traceId, grandParentId);

        this.persist();
        this._onDidChangeTraces.fire();
    }

    public isDescendant(ancestorId: string, descendantId: string): boolean {
        let curr: string | null = descendantId;
        while (curr !== null) {
            if (curr === ancestorId) { return true; }
            curr = this.findParentTraceId(curr);
        }
        return false;
    }

    private addTraceToIndex(trace: TracePoint, parentId: string | null): void {
        try {
            const uriStr = trace.filePath ? vscode.Uri.file(trace.filePath).toString() : 'orphaned://trace';
            
            let set = this.traceIndex.get(uriStr);
            if (!set) {
                set = new Set();
                this.traceIndex.set(uriStr, set);
            }
            set.add(trace);
        } catch (e) {
            console.warn(`Failed to index trace ${trace.id} with path ${trace.filePath}:`, e);
        }
        
        this.traceIdMap.set(trace.id, trace);
        this.parentIdMap.set(trace.id, parentId);

        if (trace.children) {
            for (const child of trace.children) {
                this.addTraceToIndex(child, trace.id);
            }
        }
    }

    private removeTraceFromIndex(id: string): void {
        const trace = this.traceIdMap.get(id);
        if (!trace) return;

        const uriStr = vscode.Uri.file(trace.filePath).toString();
        const set = this.traceIndex.get(uriStr);
        if (set) {
            set.delete(trace);
            if (set.size === 0) {
                this.traceIndex.delete(uriStr);
            }
        }

        this.traceIdMap.delete(id);
        this.parentIdMap.delete(id);

        if (trace.children) {
            for (const child of trace.children) {
                this.removeTraceFromIndex(child.id);
            }
        }
    }

    // ── Public: CRUD ─────────────────────────────────────────────

    public add(trace: TracePoint): void {
        const target = this.getActiveChildren();
        target.push(trace);

        this.addTraceToIndex(trace, this.activeGroupId);

        this.persist();
        this._onDidChangeTraces.fire();
    }

    public remove(id: string): void {
        this.removeFromTree(id);

        if (this.activeGroupId && !this.findTraceById(this.activeGroupId)) {
            this.activeGroupId = null;
            this.persistActiveGroup();
        }

        this.removeTraceFromIndex(id);
        this.persist();
        this._onDidChangeTraces.fire();
    }

    public reorder(orderedIds: string[]): void {
        const children = this.getActiveChildren();
        const map = new Map(children.map(t => [t.id, t]));
        const reordered: TracePoint[] = [];
        for (const id of orderedIds) {
            const t = map.get(id);
            if (t) { reordered.push(t); }
        }
        children.length = 0;
        children.push(...reordered);
        this.persist();
        this._onDidChangeTraces.fire();
    }

    public updateNote(id: string, note: string): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.note = note;
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    public updateHighlight(id: string, highlight: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.highlight = highlight;
            this.persist();
            this._onDidChangeTraces.fire();
        }
    }

    public addEmptyTrace(): string {
        const newTrace: TracePoint = {
            id: generateIsomorphicUUID(),
            filePath: '',
            rangeOffset: [0, 0],
            lineRange: [0, 0],
            content: '',
            lang: 'plaintext',
            note: '',
            timestamp: Date.now(),
            orphaned: false,
        };

        // Add to the store WITHOUT firing the generic event
        const target = this.getActiveChildren();
        target.push(newTrace);
        this.addTraceToIndex(newTrace, this.activeGroupId);
        this.persist();

        // Fire with the focusId so listeners can scroll to the new card
        this._onDidChangeTraces.fire({ focusId: newTrace.id });
        return newTrace.id;
    }

    public relocateTrace(id: string, document: vscode.TextDocument, selection: vscode.Selection): void {
        const trace = this.findTraceById(id);
        if (!trace) { return; }

        const oldFilePath = trace.filePath;
        const newFilePath = document.uri.fsPath;
        const isDifferentFile = oldFilePath !== newFilePath;

        const text = document.getText(selection);
        const lines = text.split(/\r?\n/);
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

        trace.filePath = newFilePath;
        trace.rangeOffset = [
            document.offsetAt(selection.start),
            document.offsetAt(selection.end)
        ];
        trace.lineRange = [selection.start.line, selection.end.line];
        trace.content = cleanContent;
        trace.lang = document.languageId;
        trace.orphaned = false;

        if (isDifferentFile) {
            const oldUriStr = vscode.Uri.file(oldFilePath).toString();
            const oldIndexList = this.traceIndex.get(oldUriStr);
            if (oldIndexList) {
                oldIndexList.delete(trace);
                if (oldIndexList.size === 0) {
                    this.traceIndex.delete(oldUriStr);
                }
            }

            const newUriStr = document.uri.toString();
            let newIndexList = this.traceIndex.get(newUriStr);
            if (!newIndexList) {
                newIndexList = new Set();
                this.traceIndex.set(newUriStr, newIndexList);
            }
            newIndexList.add(trace);
        }

        this.persist();
        this._onDidChangeTraces.fire();
    }

    public getAll(): TracePoint[] {
        return [...this.getActiveRootTraces()];
    }

    public getWorkspaceSyncPayload(): any {
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

    public getAllFlat(list: TracePoint[] = this.getActiveRootTraces()): TracePoint[] {
        const result: TracePoint[] = [];
        const stack = [...list].reverse(); // Push reversed roots to map correctly

        while (stack.length > 0) {
            const current = stack.pop()!; // O(1) extract from back
            result.push(current);

            if (current.children?.length) {
                // Reverse children before pushing to preserve depth-first stack order
                stack.push(...[...current.children].reverse());
            }
        }
        return result;
    }

    public clear(): void {
        const activeTree = this.getActiveTree();
        if (activeTree) {
            activeTree.traces = [];
        }
        this.activeGroupId = null;

        this.traceIndex.clear();
        this.persist();
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
    }

    public clearActiveChildren(): void {
        const children = this.getActiveChildren();
        const idsToRemove = children.map(c => c.id);
        children.length = 0;

        for (const id of idsToRemove) {
            this.removeTraceFromIndex(id);
        }

        this.persist();
        this._onDidChangeTraces.fire();
    }

    // ── Public: Navigation ───────────────────────────────────────

    public enterGroup(id: string): boolean {
        const depth = this.getDepth(id);
        if (depth < 0 || depth >= MAX_DEPTH - 1) { return false; }
        const trace = this.findTraceById(id);
        if (!trace) { return false; }

        if (!trace.children) { trace.children = []; }
        this.activeGroupId = id;
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
        return true;
    }

    public exitGroup(): string | null {
        if (this.activeGroupId === null) { return null; }
        const parentId = this.findParentTraceId(this.activeGroupId);
        this.activeGroupId = parentId;
        this.persistActiveGroup();
        this._onDidChangeTraces.fire();
        return this.activeGroupId;
    }

    private findParentTraceId(id: string): string | null {
        return this.parentIdMap.get(id) ?? null;
    }

    public getActiveGroupId(): string | null {
        return this.activeGroupId;
    }

    public getActiveDepth(): number {
        if (this.activeGroupId === null) { return 0; }
        const depth = this.getDepth(this.activeGroupId);
        return depth >= 0 ? depth + 1 : 0;
    }

    public getActiveBreadcrumb(): string {
        if (this.activeGroupId === null) { return ''; }
        const segments: number[] = [];
        let currentId: string | null = this.activeGroupId;
        while (currentId !== null) {
            const parentList = this.findParentList(currentId);
            if (parentList) {
                const idx = parentList.findIndex(t => t.id === currentId);
                segments.unshift(idx + 1);
            }
            currentId = this.findParentTraceId(currentId);
        }
        return segments.join('/') + '/';
    }

    public getActiveChildren(): TracePoint[] {
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

    public handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const document = event.document;
        const docUriStr = document.uri.toString();

        // Fast-path lookup
        if (!this.traceIndex.has(docUriStr)) {
            return;
        }

        const tracesInFile = this.traceIndex.get(docUriStr);
        if (!tracesInFile || tracesInFile.size === 0) return;

        let needsValidation = Array.from(tracesInFile).some(t => t.orphaned);

        const sortedChanges = [...event.contentChanges].sort(
            (a, b) => b.rangeOffset - a.rangeOffset,
        );

        for (const change of sortedChanges) {
            const changeStart = change.rangeOffset;
            const changeEnd = changeStart + change.rangeLength;
            const delta = change.text.length - change.rangeLength;

            for (const trace of tracesInFile) {
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

        if (needsValidation) {
            this.pendingValidationDocs.set(docUriStr, { uri: document.uri, version: document.version });

            if (this.validationDebounceTimer) {
                clearTimeout(this.validationDebounceTimer);
            }

            if (this.validationCts) {
                this.validationCts.cancel();
                this.validationCts.dispose();
                this.validationCts = undefined;
            }

            this.validationDebounceTimer = setTimeout(() => {
                this.validationCts = new vscode.CancellationTokenSource();
                this.processValidationQueue(this.validationCts.token);
            }, 500);
        }
    }

    private async processValidationQueue(token: vscode.CancellationToken): Promise<void> {
        if (token.isCancellationRequested) return;

        // End condition: Cleanup Token Source cleanly
        if (this.pendingValidationDocs.size === 0) {
            if (this.validationCts) {
                this.validationCts.dispose();
                this.validationCts = undefined;
            }
            return;
        }

        const startTime = Date.now();
        let stateChanged = false;

        for (const [uri, docData] of this.pendingValidationDocs) {
            if (token.isCancellationRequested) return;

            if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
                if (this.validationDebounceTimer) { clearTimeout(this.validationDebounceTimer); }
                this.validationDebounceTimer = setTimeout(() => {
                    this.processValidationQueue(token);
                }, 0);
                break;
            }

            this.pendingValidationDocs.delete(uri);

            const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri);
            if (!document || document.version !== docData.version) continue;

            const tracesInFile = this.traceIndex.get(document.uri.toString());
            if (tracesInFile) {
                for (const trace of tracesInFile) {
                    if (token.isCancellationRequested) return;

                    if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
                        this.pendingValidationDocs.set(uri, { uri: document.uri, version: document.version });
                        break;
                    }

                    if (!trace.rangeOffset) continue;

                    const [startOffset, endOffset] = trace.rangeOffset;

                    if (startOffset < 0 || endOffset > document.getText().length) {
                        if (!trace.orphaned) {
                            trace.orphaned = true;
                            stateChanged = true;
                        }
                        continue;
                    }

                    const startPos = document.positionAt(startOffset);
                    const endPos = document.positionAt(endOffset);

                    const newStartLine = startPos.line;
                    const newEndLine = endPos.line;

                    if (!trace.lineRange || trace.lineRange[0] !== newStartLine || trace.lineRange[1] !== newEndLine) {
                        trace.lineRange = [newStartLine, newEndLine];
                        stateChanged = true;
                    }

                    const currentContent = document.getText(new vscode.Range(startPos, endPos));

                    if (!this.contentMatches(currentContent, trace.content)) {
                        const recovered = await this.recoverTracePoints(document, trace.content, startOffset, document.uri, token);
                        if (token.isCancellationRequested) return;

                        if (recovered) {
                            trace.rangeOffset = recovered.offset;
                            if (recovered.uri.fsPath !== document.uri.fsPath) {
                                trace.filePath = recovered.uri.fsPath;
                                const targetDoc = await this.getDocAdapter(recovered.uri, false);
                                if (targetDoc.docAdapter) {
                                    const rStart = targetDoc.docAdapter.positionAt(recovered.offset[0]);
                                    const rEnd = targetDoc.docAdapter.positionAt(recovered.offset[1]);
                                    trace.lineRange = [rStart.line, rEnd.line];
                                }
                            } else {
                                const rStart = document.positionAt(recovered.offset[0]);
                                const rEnd = document.positionAt(recovered.offset[1]);
                                trace.lineRange = [rStart.line, rEnd.line];
                            }
                            if (trace.orphaned) {
                                trace.orphaned = false;
                            }
                            stateChanged = true;
                        } else {
                            if (!trace.orphaned) {
                                trace.orphaned = true;
                                stateChanged = true;
                            }
                        }
                    } else if (trace.orphaned) {
                        trace.orphaned = false;
                        stateChanged = true;
                    }
                }
            }
        }

        if (stateChanged) {
            this.persist();
            this._onDidChangeTraces.fire();
        }

        // Final catch-all for clean ending inside the loop if it finishes
        if (this.pendingValidationDocs.size === 0 && this.validationCts && !token.isCancellationRequested) {
            this.validationCts.dispose();
            this.validationCts = undefined;
        }
    }

    private ensureOffsets(document: vscode.TextDocument, traces: TracePoint[]): void {
        for (const t of traces) {
            if (!t.rangeOffset || t.rangeOffset.length !== 2) {
                if (t.lineRange) {
                    try {
                        const startLine = t.lineRange[0];
                        const endLine = t.lineRange[1];
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

    /**
     * 2-Level Recovery Logic
     * Level 1: Search entire current file (exact → normalized → token fuzzy)
     * Level 2: Cross-workspace search via stable findFiles API
     */
    private async recoverTracePoints(
        document: ITraceDocument,
        storedContent: string,
        lastKnownStart: number,
        originalUri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<{ offset: [number, number], uri: vscode.Uri } | null> {
        const fullText = document.getText();
        const cleanContent = storedContent.trim();
        if (cleanContent.length === 0) return null;

        // Level 1: search the current file with no radius restriction
        const sameFileResult = this.searchInText(fullText, cleanContent, lastKnownStart);
        if (sameFileResult) {
            return { offset: sameFileResult, uri: originalUri };
        }

        // Level 2: cross-workspace search
        return await this.searchAcrossWorkspace(originalUri, cleanContent, token);
    }

    /**
     * Searches text for cleanContent using three strategies in order:
     * A) Exact full-text indexOf (fastest, picks match closest to preferredOffset)
     * B) Whitespace-normalized indexOf (handles spacing differences)
     * C) Anchor-then-Sellers: find positions of distinctive tokens, run Sellers' DP per candidate
     */
    private searchInText(
        fullText: string,
        cleanContent: string,
        preferredOffset: number
    ): [number, number] | null {
        // Tier A: exact match across full text
        const exactResult = this.findClosestExact(fullText, cleanContent, preferredOffset);
        if (exactResult) return exactResult;

        // Tier B: whitespace-normalized match
        const normResult = this.findNormalized(fullText, cleanContent, preferredOffset);
        if (normResult) return normResult;

        // Tier C: anchor-then-Sellers
        return this.anchorThenSellers(fullText, cleanContent, preferredOffset);
    }

    /**
     * Full-text exact indexOf, returns the match closest to preferredOffset.
     */
    private findClosestExact(
        fullText: string,
        cleanContent: string,
        preferredOffset: number
    ): [number, number] | null {
        let best = -1;
        let bestDist = Infinity;
        let idx = fullText.indexOf(cleanContent);
        while (idx >= 0) {
            const dist = Math.abs(idx - preferredOffset);
            if (dist < bestDist) { bestDist = dist; best = idx; }
            idx = fullText.indexOf(cleanContent, idx + 1);
        }
        if (best >= 0) return [best, best + cleanContent.length];
        return null;
    }

    /**
     * Normalizes whitespace in both strings (collapse runs to single space),
     * searches with indexOf, then maps the normalized position back to the
     * original text offset via a forward character scan.
     */
    private findNormalized(
        fullText: string,
        cleanContent: string,
        preferredOffset: number
    ): [number, number] | null {
        const ZW_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g;
        const normContent = cleanContent.replace(ZW_RE, '').replace(/\s+/g, ' ');
        const normText = fullText.replace(ZW_RE, '').replace(/\s+/g, ' ');

        let bestNormIdx = -1;
        let bestDist = Infinity;
        let idx = normText.indexOf(normContent);
        while (idx >= 0) {
            const dist = Math.abs(idx - preferredOffset);
            if (dist < bestDist) { bestDist = dist; bestNormIdx = idx; }
            idx = normText.indexOf(normContent, idx + 1);
        }
        if (bestNormIdx < 0) return null;

        // Map normalized index back to original text offset.
        // Both strings collapse whitespace runs and strip zero-width chars identically.
        const isSkippable = (ch: string) => /[\s\u200B\u200C\u200D\u2060\uFEFF]/.test(ch);
        const isWS = (ch: string) => /\s/.test(ch);
        let origPos = 0;
        let normPos = 0;
        while (normPos < bestNormIdx && origPos < fullText.length) {
            if (isSkippable(fullText[origPos])) {
                if (isWS(fullText[origPos])) {
                    // skip the whole whitespace run in original
                    while (origPos < fullText.length && isWS(fullText[origPos])) origPos++;
                    normPos++; // one space in normalized
                } else {
                    // zero-width char: skip in original, no normPos advance (was stripped)
                    origPos++;
                }
            } else {
                origPos++;
                normPos++;
            }
        }
        const origStart = origPos;

        // Walk forward to find end: match normContent.length chars in normalized space
        let endNormPos = bestNormIdx;
        let endOrigPos = origPos;
        const normEnd = bestNormIdx + normContent.length;
        while (endNormPos < normEnd && endOrigPos < fullText.length) {
            if (isSkippable(fullText[endOrigPos])) {
                if (isWS(fullText[endOrigPos])) {
                    while (endOrigPos < fullText.length && isWS(fullText[endOrigPos])) endOrigPos++;
                    endNormPos++;
                } else {
                    endOrigPos++;
                }
            } else {
                endOrigPos++;
                endNormPos++;
            }
        }

        return [origStart, endOrigPos];
    }

    /**
     * Level 2: Searches all workspace files with the same extension.
     * Uses the stable vscode.workspace.findFiles API (not the proposed findTextInFiles).
     * Pre-filters by anchor words, then applies the same searchInText strategy per file.
     */
    private async searchAcrossWorkspace(
        originalUri: vscode.Uri,
        cleanContent: string,
        token?: vscode.CancellationToken
    ): Promise<{ offset: [number, number], uri: vscode.Uri } | null> {
        const fsPath = originalUri.fsPath;
        const extIndex = fsPath.lastIndexOf('.');
        if (extIndex === -1) return null;

        const ext = fsPath.substring(extIndex);
        const searchPattern = `**/*${ext}`;

        if (cleanContent.length < 5) return null; // too short to cross-file match safely

        const anchorWords = this.extractAnchorWords(cleanContent, 5);
        if (anchorWords.length === 0) return null;
        const lowerAnchorWords = anchorWords.map(w => w.toLowerCase());

        const allFiles = await vscode.workspace.findFiles(searchPattern, null, undefined, token);

        for (const fileUri of allFiles) {
            if (token?.isCancellationRequested) return null;
            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const text = this.decodeFileContent(fileUri, bytes);

                // Pre-filter: at least 40% of anchor words must be present
                const lowerText = text.toLowerCase();
                const matchCount = lowerAnchorWords.filter(w => lowerText.includes(w)).length;
                const required = Math.max(1, Math.ceil(anchorWords.length * 0.4));
                if (matchCount < required) continue;

                const found = this.searchInText(text, cleanContent, 0);
                if (found) return { offset: found, uri: fileUri };
            } catch {
                // skip unreadable files silently
            }
        }

        return null;
    }

    /**
     * Replaces validateAndExpandTokenBounds using Sellers' Algorithm (O(N * T)).
     * Finds the substring in the local area that minimizes the Levenshtein distance
     * to the target tokens.
     */
    private fuzzyValidateBounds(
        fullText: string,
        tokenBounds: [number, number],
        cleanContent: string,
        precomputedTargetTokens?: { text: string; offset: number; type: string }[]
    ): [number, number] | null {
        const buffer = Math.max(100, Math.floor(cleanContent.length * 0.5));
        let searchStart = Math.max(0, tokenBounds[0] - buffer);
        let searchEnd = Math.min(fullText.length, tokenBounds[1] + buffer);

        // Guard: cap the search window so S * T stays within ~200k DP ops.
        // avgCharsPerToken ≈ 6 is conservative across C/JS/Python/TS.
        const T_est = (precomputedTargetTokens ?? []).length || Math.max(1, Math.floor(cleanContent.length / 6));
        const MAX_DP_OPS = 200_000;
        const AVG_CHARS_PER_TOKEN = 6;
        const budgetChars = Math.floor(MAX_DP_OPS / T_est) * AVG_CHARS_PER_TOKEN;
        if (searchEnd - searchStart > budgetChars) {
            const mid = Math.floor((searchStart + searchEnd) / 2);
            const half = Math.floor(budgetChars / 2);
            searchStart = Math.max(0, mid - half);
            searchEnd = Math.min(fullText.length, mid + half);
        }

        const localArea = fullText.substring(searchStart, searchEnd);

        const targetTokens = precomputedTargetTokens ?? this.tokenize(cleanContent)
            .filter(t => t.type !== 'comment')
            .map(t => ({ ...t, text: t.text.toLowerCase() }));
        if (targetTokens.length === 0) return tokenBounds;

        const searchTokens = this.tokenize(localArea)
            .filter(t => t.type !== 'comment')
            .map(t => ({ ...t, text: t.text.toLowerCase() }));
        if (searchTokens.length === 0) return null;

        const T = targetTokens.length;
        const S = searchTokens.length;

        // dp[i] represents the current column in our DP matrix
        // We track both the edit distance (cost) and where this match started (startIdx)
        let dp: { cost: number; startIdx: number }[] = Array.from({ length: T + 1 }, (_, i) => ({
            cost: i,        // Cost of deleting i target tokens
            startIdx: 0     // Will be consumed as previousDiagonal at j=1 → match starts at search[0]
        }));

        let bestDistance = Infinity;
        let bestEndIdx = -1;
        let bestStartIdx = -1;

        // O(N * T) Single-pass Dynamic Programming
        for (let j = 1; j <= S; j++) {
            const currentSearchToken = searchTokens[j - 1].text;
            let previousDiagonal = dp[0];

            // A match can start at the current search token with 0 cost
            // startIdx is j (not j-1) because this dp[0] will be consumed as previousDiagonal
            // at column j+1, where a diagonal match corresponds to search token j (0-indexed).
            dp[0] = { cost: 0, startIdx: j }; 

            for (let i = 1; i <= T; i++) {
                const temp = dp[i];
                
                if (targetTokens[i - 1].text === currentSearchToken) {
                    // Match: inherit cost and start index from the diagonal
                    dp[i] = { ...previousDiagonal };
                } else {
                    // Mismatch: find the cheapest operation
                    const subCost = previousDiagonal.cost + 1; // Substitution
                    const insCost = dp[i].cost + 1;            // Insertion
                    const delCost = dp[i - 1].cost + 1;        // Deletion

                    let minCost = Math.min(subCost, insCost, delCost);
                    let inheritedStartIdx = 0;

                    if (minCost === subCost) inheritedStartIdx = previousDiagonal.startIdx;
                    else if (minCost === insCost) inheritedStartIdx = dp[i].startIdx;
                    else inheritedStartIdx = dp[i - 1].startIdx;

                    dp[i] = { cost: minCost, startIdx: inheritedStartIdx };
                }
                previousDiagonal = temp;
            }

            // Check if the current end position provides a better full-target match
            if (dp[T].cost < bestDistance) {
                bestDistance = dp[T].cost;
                bestEndIdx = j - 1; // 0-indexed token array
                bestStartIdx = dp[T].startIdx; // Already 0-indexed
            }
        }

        // Acceptance threshold: strict for short content, lenient for long content
        // Short content (≤10 tokens): 0 tolerance — must be exact (Tier 1 already failed)
        // Medium content (≤18 tokens): allow at most 1 edit
        // Long content: 40% edit distance
        const maxAllowedDistance = T <= 10 ? 0 : T <= 18 ? 1 : Math.max(2, Math.floor(T * 0.4));
        
        if (bestDistance <= maxAllowedDistance && bestStartIdx >= 0 && bestEndIdx >= 0) {
            // Map token indices back to absolute text offsets
            const absoluteStart = searchTokens[bestStartIdx].offset + searchStart;
            const endToken = searchTokens[bestEndIdx];
            const absoluteEnd = endToken.offset + endToken.text.length + searchStart;
            
            return [absoluteStart, absoluteEnd];
        }

        return null;
    }

    /**
     * Regex-based Lexer
     * Strips // comments, /* *\/ comments, and string literals.
     * Extracts identifiers, keywords, AND numeric literals.
     */
    private tokenize(text: string): Token[] {
        const tokenRegex = /(\/\*[\s\S]*?\*\/)|(\/\/[^\r\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|([a-zA-Z_$][a-zA-Z0-9_$]*|#\w+|::|->|[*&]|\b\d+\b|[{}()\[\];,.=+\-*/<>!?:|~^%])/g;
        const tokens: Token[] = [];
        let match;
        
        while ((match = tokenRegex.exec(text)) !== null) {
            if (match[1] || match[2]) {
                tokens.push({ text: match[0], offset: match.index, type: 'comment' });
            } else if (match[3]) {
                tokens.push({ text: match[0], offset: match.index, type: 'string' });
            } else if (match[4]) {
                tokens.push({ text: match[4], offset: match.index, type: 'code' });
            }
        }
        
        return tokens;
    }

    /**
     * Anchor-Then-Sellers (Tier C)
     *
     * 1. Extract the 3 most distinctive tokens from cleanContent as anchors.
     * 2. Find every occurrence of each anchor in fullText.
     * 3. For each occurrence, run fuzzyValidateBounds on a window centered there.
     * 4. Return the first result that passes the Sellers' threshold, preferring
     *    candidates closest to preferredOffset.
     *
     * Falls back to a full-text Sellers' pass when no anchor words are present
     * or none are found in the file.
     */
    private anchorThenSellers(fullText: string, cleanContent: string, preferredOffset: number): [number, number] | null {
        // Tokenize cleanContent once — reuse for both anchor extraction and Sellers' DP
        const allTokens = this.tokenize(cleanContent);
        const anchors = this.extractAnchorWordsFromTokens(allTokens, 3);
        const targetTokens = allTokens
            .filter(t => t.type !== 'comment')
            .map(t => ({ ...t, text: t.text.toLowerCase() }));

        // Collect candidate center positions from all anchor occurrences
        const candidates: number[] = [];
        if (anchors.length > 0) {
            const lowerText = fullText.toLowerCase();
            for (const anchor of anchors) {
                const lowerAnchor = anchor.toLowerCase();
                let idx = lowerText.indexOf(lowerAnchor);
                while (idx >= 0) {
                    candidates.push(idx);
                    idx = lowerText.indexOf(lowerAnchor, idx + 1);
                }
            }
        }

        if (candidates.length === 0) {
            // No anchor hits — run Sellers' over the full text
            return this.fuzzyValidateBounds(fullText, [0, fullText.length], cleanContent, targetTokens);
        }

        // Sort by proximity to preferredOffset so the most-likely hit is tried first
        candidates.sort((a, b) => Math.abs(a - preferredOffset) - Math.abs(b - preferredOffset));

        // Deduplicate: skip positions within cleanContent.length of an already-queued one
        const deduped: number[] = [];
        for (const pos of candidates) {
            if (!deduped.some(p => Math.abs(p - pos) < cleanContent.length)) {
                deduped.push(pos);
            }
        }

        // For each anchor position, validate a window centered around it
        const half = cleanContent.length;
        for (const center of deduped) {
            const result = this.fuzzyValidateBounds(fullText, [center - half, center + half], cleanContent, targetTokens);
            if (result) return result;
        }

        return null;
    }

    private static readonly ANCHOR_FORBIDDEN = new Set(['void', 'int', 'char', 'long', 'float', 'double', 'short', 'signed', 'unsigned', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'default', 'const', 'static', 'extern', 'volatile', 'register', 'typedef', 'struct', 'union', 'enum', 'inline', 'restrict', 'alignas', 'alignof', 'atomic', 'bool', 'complex', 'generic', 'imaginary', 'noreturn', 'static_assert', 'thread_local', 'public', 'private', 'protected', 'class', 'interface', 'namespace', 'using', 'function', 'async', 'await', 'export', 'import', 'from', 'as', 'any', 'any', 'number', 'string', 'boolean', 'symbol', 'undefined', 'null', 'true', 'false', 'let', 'var', 'const', 'new', 'this', 'throw', 'try', 'catch', 'finally', 'super', 'extends', 'implements', 'module', 'package', 'type', 'declare', 'abstract', 'readonly', 'keyof', 'typeof', 'in', 'of', 'instanceof']);

    private extractAnchorWordsFromTokens(tokens: Token[], limit: number): string[] {
        const forbidden = TraceManager.ANCHOR_FORBIDDEN;
        const texts = tokens
            .filter(t => t.type === 'code' && t.text.length >= 3 && !forbidden.has(t.text))
            .map(t => t.text);

        // If code tokens yield no anchors, fall back to identifiers inside comments.
        // This recovers cases like `else { // !trace.rangeOffset` where the comment
        // contains the only distinctive text.
        if (texts.length === 0) {
            for (const token of tokens) {
                if (token.type !== 'comment') continue;
                const words = token.text.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) ?? [];
                for (const word of words) {
                    if (word.length >= 3 && !forbidden.has(word)) texts.push(word);
                }
            }
        }

        const unique = Array.from(new Set(texts));
        unique.sort((a, b) => b.length - a.length);
        return unique.slice(0, limit);
    }

    private extractAnchorWords(content: string, limit: number): string[] {
        return this.extractAnchorWordsFromTokens(this.tokenize(content), limit);
    }


    private contentMatches(docContent: string, storedContent: string): boolean {
        const normDoc = docContent.replace(/\s+/g, ' ').trim();
        const normStored = storedContent.replace(/\s+/g, ' ').trim();
        return normDoc === normStored;
    }

    private rebuildTraceIndex(): void {
        this.traceIndex.clear();
        this.traceIdMap.clear();
        this.parentIdMap.clear();

        const activeTree = this.getActiveTree();
        if (activeTree) {
            for (const t of activeTree.traces) {
                this.addTraceToIndex(t, null);
            }
        }
    }

    public getTracesForFile(filePath: string): TracePoint[] {
        const set = this.traceIndex.get(vscode.Uri.file(filePath).toString());
        return set ? Array.from(set) : [];
    }

    // ── Import Logic ─────────────────────────────────────────────

    public async importTraceTree(markdown: string, treeName?: string): Promise<void> {
        try {
            const importedTraces = await this.parseMarkdown(markdown);

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
        const lines = markdown.split(/\r?\n/);
        const rootTraces: TracePoint[] = [];
        const stack: { trace: TracePoint, depth: number }[] = [];

        /** Reverse map: Markdown tag → highlight colour (derived from the shared HIGHLIGHT_TO_TAG) */
        const TAG_TO_HIGHLIGHT = Object.fromEntries(
            Object.entries(HIGHLIGHT_TO_TAG).map(([colour, tag]) => [tag, colour as TracePoint['highlight']])
        ) as Record<string, TracePoint['highlight']>;

        let currentTrace: (Partial<TracePoint> & { _tempDepth: number }) | null = null;
        let currentContent: string[] = [];
        let capturingContent = false;

        // Captures optional %%Tag%% immediately after the number+dot
        const headerRegex = /^(#+)\s+\d+\.\s+(?:%%([^%]+)%%\s+)?(.*)/;
        const codeBlockStartRegex = /^```(\w*)\s+(\d+|\?):(\d+|\?):(.+)$/;

        const flushCurrentTrace = async () => {
            if (!currentTrace) return;

            if (capturingContent) {
                currentTrace.content = currentContent.join('\n');
                currentContent = [];
                capturingContent = false;
            } else if (currentTrace.content === undefined) {
                // Headings without code blocks get empty content
                currentTrace.content = '';
                currentTrace.lang = 'plaintext';
                currentTrace.filePath = '';
                currentTrace.lineRange = [0, 0];
            }

            const validated = await this.validateAndRecover(currentTrace as TracePoint);
            if (validated) {
                const trace = validated;
                while (stack.length > 0 && stack[stack.length - 1].depth >= currentTrace._tempDepth) {
                    stack.pop();
                }

                if (stack.length > 0) {
                    const parent = stack[stack.length - 1].trace;
                    if (!parent.children) parent.children = [];
                    parent.children.push(trace);
                } else {
                    rootTraces.push(trace);
                }

                stack.push({ trace, depth: currentTrace._tempDepth });
            }
            currentTrace = null;
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!capturingContent && line.trim().startsWith('---')) {
                continue;
            }

            if (line.startsWith('```')) {
                if (!capturingContent) {
                    const match = line.match(codeBlockStartRegex);
                    if (match && currentTrace) {
                        capturingContent = true;
                        currentTrace.lang = match[1];
                        const startLine = match[2] === '?' ? 0 : parseInt(match[2]) - 1;
                        const endLine = match[3] === '?' ? 0 : parseInt(match[3]) - 1;
                        const filePath = match[4].trim();
                        if (path.isAbsolute(filePath)) {
                            currentTrace.filePath = filePath;
                        } else {
                            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                            if (workspaceFolder) {
                                currentTrace.filePath = vscode.Uri.joinPath(workspaceFolder.uri, filePath).fsPath;
                            } else {
                                currentTrace.filePath = filePath;
                            }
                        }
                        currentTrace.lineRange = [startLine, endLine];
                        continue;
                    }
                } else {
                    // Ending code block
                    await flushCurrentTrace();
                    continue;
                }
            }

            if (capturingContent) {
                currentContent.push(line);
                continue;
            }

            const headerMatch = line.match(headerRegex);
            if (headerMatch) {
                await flushCurrentTrace();

                const hashes    = headerMatch[1];
                const tag       = headerMatch[2]?.trim() ?? null;   // %%Tag%% content (may be undefined)
                const rawTitle  = headerMatch[3].trim();
                const depth     = hashes.length - 2;
                if (depth < 0) continue;

                let title = rawTitle;
                if (title.endsWith('(Orphaned)')) {
                    title = title.replace('(Orphaned)', '').trim();
                }

                // Restore highlight colour from %%Tag%% if present
                const highlight = (tag && TAG_TO_HIGHLIGHT[tag]) ? TAG_TO_HIGHLIGHT[tag] : null;

                currentTrace = {
                    id: generateIsomorphicUUID(),
                    note: title,
                    highlight,
                    orphaned: false,
                    children: [],
                    _tempDepth: depth,
                    timestamp: Date.now()
                } as any;
            } else if (currentTrace && line.trim().length > 0) {
                if (currentTrace.note && !currentTrace.note.endsWith('\n')) {
                    currentTrace.note += '\n';
                }
                currentTrace.note += line;
            }
        }

        await flushCurrentTrace();
        return rootTraces;
    }


    private decodeFileContent(uri: vscode.Uri, bytes: Uint8Array): string {
        const config = vscode.workspace.getConfiguration('files', uri);
        let encoding = config.get<string>('encoding', 'utf8');
        if (!encoding || encoding === 'utf8bom') {
            encoding = 'utf-8';
        }
        try {
            // TextDecoder supports many encodings like Big5, Shift_JIS, etc.
            return new TextDecoder(encoding).decode(bytes);
        } catch (err) {
            console.warn(`Failed to decode file ${uri.fsPath} with encoding ${encoding}, falling back to UTF-8`, err);
            return new TextDecoder('utf-8').decode(bytes);
        }
    }

    private async getDocAdapter(uri: vscode.Uri, background: boolean): Promise<{ docAdapter: ITraceDocument | undefined, newlyOpened: boolean }> {
        let docAdapter: ITraceDocument | undefined = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
        let newlyOpened = false;
        
        if (!docAdapter) {
            if (!background) {
                try {
                    docAdapter = await vscode.workspace.openTextDocument(uri);
                    newlyOpened = true;
                } catch (e) {
                    return { docAdapter: undefined, newlyOpened };
                }
            } else {
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    
                    let fullText: string = "";
                    try {
                        fullText = this.decodeFileContent(uri, bytes);
                    } catch (e) {
                        try {
                            docAdapter = await vscode.workspace.openTextDocument(uri);
                            newlyOpened = true;
                        } catch (e) {
                            return { docAdapter: undefined, newlyOpened };
                        }
                    }

                    if (!docAdapter) {
                        const lineOffsets: number[] = [0];
                        for (let i = 0; i < fullText.length; i++) {
                            if (fullText[i] === '\n') {
                                lineOffsets.push(i + 1);
                            }
                        }

                        docAdapter = {
                            lineCount: lineOffsets.length,
                            offsetAt: (pos: vscode.Position) => {
                                const line = Math.max(0, Math.min(pos.line, lineOffsets.length - 1));
                                return lineOffsets[line] + pos.character;
                            },
                            positionAt: (offset: number) => {
                                offset = Math.max(0, Math.min(offset, fullText.length));
                                let low = 0;
                                let high = lineOffsets.length - 1;
                                while(low <= high) {
                                    const mid = Math.floor((low + high) / 2);
                                    if(lineOffsets[mid] <= offset) low = mid + 1;
                                    else high = mid - 1;
                                }
                                const line = Math.max(0, low - 1);
                                return new vscode.Position(line, offset - lineOffsets[line]);
                            },
                            lineAt: (line: number) => {
                                line = Math.max(0, Math.min(line, lineOffsets.length - 1));
                                const start = lineOffsets[line];
                                let end = line + 1 < lineOffsets.length ? lineOffsets[line + 1] - 1 : fullText.length;
                                if (end > start && fullText[end - 1] === '\r') end--;
                                return { range: { end: new vscode.Position(line, end - start) } };
                            },
                            getText: function(range?: vscode.Range) {
                                if (!range) return fullText;
                                const start = this.offsetAt(range.start);
                                const end = this.offsetAt(range.end);
                                return fullText.substring(start, end);
                            }
                        };
                    }
                } catch (e) {
                    return { docAdapter: undefined, newlyOpened };
                }
            }
        }
        
        return { docAdapter, newlyOpened };
    }

    private async validateAndRecover(trace: TracePoint, background: boolean = false, token?: vscode.CancellationToken): Promise<TracePoint | null> {
        try {
            if (!trace.filePath) {
                // It's an empty trace/note, so it inherently doesn't have a file. It is not orphaned.
                trace.orphaned = false;
                return trace;
            }

            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(trace.filePath));
            } catch {
                console.warn('Trace validation skipped missing file:', trace.filePath);
                trace.orphaned = true;
                if (!trace.rangeOffset) { trace.rangeOffset = [0, 0]; }
                return trace;
            }


            const uri = vscode.Uri.file(trace.filePath);
            const res = await this.getDocAdapter(uri, background);
            const docAdapter = res.docAdapter;
            const newlyOpened = res.newlyOpened;
            
            if (!docAdapter) {
                trace.orphaned = true;
                if (!trace.rangeOffset) { trace.rangeOffset = [0, 0]; }
                return trace;
            }

            if (newlyOpened) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            if (trace.lineRange) {
                const [startLine, endLine] = trace.lineRange;
                if (startLine < docAdapter.lineCount) {
                    const startPos = new vscode.Position(startLine, 0);
                    const endLineObj = docAdapter.lineAt(Math.min(endLine, docAdapter.lineCount - 1));
                    const endPos = endLineObj.range.end;

                    const text = docAdapter.getText(new vscode.Range(startPos, endPos));

                    if (this.contentMatches(text, trace.content)) {
                        trace.rangeOffset = [docAdapter.offsetAt(startPos), docAdapter.offsetAt(endPos)];
                        trace.orphaned = false;
                        return trace;
                    }
                }
            }

            let estimatedOffset = 0;
            if (trace.lineRange && trace.lineRange[0] < docAdapter.lineCount) {
                estimatedOffset = docAdapter.offsetAt(new vscode.Position(trace.lineRange[0], 0));
            }

            const recoveredResult = await this.recoverTracePoints(docAdapter, trace.content, estimatedOffset, uri, token);
            if (recoveredResult) {
                const { offset: recoveredOffset, uri: newUri } = recoveredResult;
                
                if (newUri.fsPath !== uri.fsPath) {
                    trace.filePath = newUri.fsPath;
                    console.log(`Trace point migrated to new file: ${newUri.fsPath}`);
                }

                trace.rangeOffset = recoveredOffset;
                
                let targetDocAdapter = docAdapter;
                if (newUri.fsPath !== uri.fsPath) {
                    const res = await this.getDocAdapter(newUri, background);
                    if (res.docAdapter) {
                        targetDocAdapter = res.docAdapter;
                    }
                }

                const rStart = targetDocAdapter.positionAt(recoveredOffset[0]);
                const rEnd = targetDocAdapter.positionAt(recoveredOffset[1]);
                
                trace.lineRange = [rStart.line, rEnd.line];
                trace.orphaned = false;
                return trace;
            } else {
                trace.orphaned = true;
                if (!trace.rangeOffset) { trace.rangeOffset = [0, 0]; }
                return trace;
            }
        } catch (e) {
            console.warn('Trace import error:', e);
            trace.orphaned = true;
            if (!trace.rangeOffset) { trace.rangeOffset = [0, 0]; }
            return trace;
        }
    }
}