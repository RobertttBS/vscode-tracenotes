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
    private static readonly SEARCH_RADIUS = 5000;
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
     * 3-Tier Optimized Recovery Logic
     * Tier 1: Exact Match (Radius Bound)
     * Tier 2: Token-based Sliding Window (Elastic Radius Bound)
     * Tier 3: Workspace-wide fallback for identical file extensions (Cross-file)
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
        const radius = TraceManager.SEARCH_RADIUS;

        // --- Standard Bounds for Tiers 1 & 2 ---
        const searchStart = Math.max(0, lastKnownStart - radius);
        const searchEnd = Math.min(fullText.length, lastKnownStart + radius + cleanContent.length);
        const searchArea = fullText.slice(searchStart, searchEnd);

        // ==========================================
        // TIER 1: Exact Match in Radius (Fastest)
        // ==========================================
        let bestExactStart = -1;
        let bestExactDistance = Infinity;
        let currentIdx = searchArea.indexOf(cleanContent);
        while (currentIdx >= 0) {
            const absoluteStart = searchStart + currentIdx;
            const dist = Math.abs(absoluteStart - lastKnownStart);
            if (dist < bestExactDistance) {
                bestExactDistance = dist;
                bestExactStart = absoluteStart;
            }
            currentIdx = searchArea.indexOf(cleanContent, currentIdx + 1);
        }

        if (bestExactStart >= 0) {
            return { offset: [bestExactStart, bestExactStart + cleanContent.length], uri: originalUri };
        }

        // ==========================================
        // TIER 2: Token Extraction & Sliding Window
        // ==========================================
        // Elastic Boundary restricts the ultimate fallback to SEARCH_RADIUS * 2
        const elasticRadius = radius * 2;
        const elasticStart = Math.max(0, lastKnownStart - elasticRadius);
        const elasticEnd = Math.min(fullText.length, lastKnownStart + elasticRadius + cleanContent.length);
        const elasticArea = fullText.slice(elasticStart, elasticEnd);

        const tier2Offset = this.slidingWindowTokenSearch(elasticArea, elasticStart, cleanContent);
        
        if (tier2Offset) {
            // FIX: Use the expanded bounding validation instead of strict string equality
            const validatedOffset = this.fuzzyValidateBounds(fullText, tier2Offset, cleanContent);
            if (validatedOffset) {
                return { offset: validatedOffset, uri: originalUri };
            } else {
                console.warn('Tier 2 found a token match, but boundary validation failed. Moving to Tier 3.');
            }
        }

        // ==========================================
        // TIER 3: Cross-File Workspace Search
        // ==========================================
        return await this.searchAcrossWorkspace(originalUri, cleanContent, token);
    }

    /**
     * Tier 3 Helper: Searches all files in the workspace using VS Code's native ripgrep API.
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

        // Phase 1: Native Exact Match Search (Lightning Fast)
        let exactMatchUri: vscode.Uri | null = null;
        let exactMatchOffset: [number, number] | null = null;

        // @ts-ignore: findTextInFiles is a proposed/newer API
        await vscode.workspace.findTextInFiles(
            { pattern: cleanContent, isLiteral: true },
            { include: searchPattern },
            (result: any) => {
                // We only care about cross-file matches
                if (result.uri.fsPath !== originalUri.fsPath && !exactMatchUri) {
                    exactMatchUri = result.uri;
                    // Note: findTextInFiles gives us line/character positions. 
                    // We will resolve the exact absolute offset later if needed, 
                    // but for a true exact match, we can just flag it here.
                }
            },
            token
        );

        // If ripgrep found an exact match, read just that one file to get the absolute offset
        if (exactMatchUri) {
            const bytes = await vscode.workspace.fs.readFile(exactMatchUri);
            const text = this.decodeFileContent(exactMatchUri, bytes);
            const exactIdx = text.indexOf(cleanContent);
            if (exactIdx >= 0) {
                return { offset: [exactIdx, exactIdx + cleanContent.length], uri: exactMatchUri };
            }
        }

        // Phase 2: Anchor Word Pre-filter via Ripgrep
        // We only want to fuzzy search files that contain our most unique tokens.
        if (cleanContent.length <= 20) {
            return null; // Content too small to safely fuzzy match across the workspace
        }

        const anchorWords = this.extractAnchorWords(cleanContent, 5);
        if (anchorWords.length === 0) return null;

        // Create a regex pattern: (WordA|WordB|WordC)
        const regexPattern = `(${anchorWords.map(w => this.escapeRegExp(w)).join('|')})`;
        const candidateUris = new Set<string>();

        // @ts-ignore: findTextInFiles is a proposed/newer API
        await vscode.workspace.findTextInFiles(
            { pattern: regexPattern, isRegExp: true, isCaseSensitive: true },
            { include: searchPattern },
            (result: any) => {
                if (result.uri.fsPath !== originalUri.fsPath) {
                    candidateUris.add(result.uri.toString());
                }
            },
            token
        );

        // Phase 3: Run the heavy fuzzy search ONLY on the candidate files
        for (const uriString of candidateUris) {
            if (token?.isCancellationRequested) return null;
            
            const uri = vscode.Uri.parse(uriString);
            
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = this.decodeFileContent(uri, bytes); 
                
                // Verify our 40% threshold manually now that the file is in memory
                let matches = 0;
                for (const word of anchorWords) {
                    if (text.includes(word)) matches++;
                }
                
                const requiredMatches = Math.max(1, Math.ceil(anchorWords.length * 0.4));
                if (matches < requiredMatches) continue;

                // Run the expensive sliding window algorithm
                const offset = this.slidingWindowTokenSearch(text, 0, cleanContent);
                if (offset) {
                    const expandedOffset = this.fuzzyValidateBounds(text, offset, cleanContent);
                    if (expandedOffset) return { offset: expandedOffset, uri };
                }
            } catch (err) {
                // Silent fail for individual file read errors
                console.warn(`Failed to process candidate file ${uri.fsPath}`, err);
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
        cleanContent: string
    ): [number, number] | null {
        const buffer = Math.max(100, Math.floor(cleanContent.length * 0.5));
        const searchStart = Math.max(0, tokenBounds[0] - buffer);
        const searchEnd = Math.min(fullText.length, tokenBounds[1] + buffer);
        const localArea = fullText.substring(searchStart, searchEnd);

        const targetTokens = this.tokenize(cleanContent).filter(t => t.type !== 'comment');
        if (targetTokens.length === 0) return tokenBounds;

        const searchTokens = this.tokenize(localArea).filter(t => t.type !== 'comment');
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

        // Acceptance threshold: 40% maximum mutation
        const maxAllowedDistance = Math.max(2, Math.floor(T * 0.4));
        
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
     * Sliding Window Resolution (O(N) Two-Pointer)
     * Finds the minimal window that hits the maximum target tokens.
     * Both left and right pointers traverse sourceTokens exactly once.
     */
    private slidingWindowTokenSearch(elasticArea: string, elasticStart: number, cleanContent: string): [number, number] | null {
        const targetTokens = this.tokenize(cleanContent).map(t => t.text);
        if (targetTokens.length === 0) return null;

        const sourceTokens = this.tokenize(elasticArea);
        if (sourceTokens.length === 0) return null;

        // Build target frequency map
        const targetFreq = new Map<string, number>();
        for (const t of targetTokens) {
            targetFreq.set(t, (targetFreq.get(t) || 0) + 1);
        }
        const totalTargets = targetTokens.length;

        // State: single window tracked by windowFreq
        const windowFreq = new Map<string, number>();
        let matches = 0;
        let left = 0;

        let maxMatches = 0;
        let minWindowLength = Infinity;
        let bestWindow: [number, number] | null = null;

        // Dynamic window size: large enough to allow insertions, bounded to prevent massive overlap
        const maxWindowSize = Math.min(targetTokens.length * 2 + 10, sourceTokens.length);

        // --- Expand Phase: iterate right pointer ---
        for (let right = 0; right < sourceTokens.length; right++) {
            const rightToken = sourceTokens[right].text;
            const rightTarget = targetFreq.get(rightToken) || 0;

            // Add right token to window
            if (rightTarget > 0) {
                const cur = windowFreq.get(rightToken) || 0;
                windowFreq.set(rightToken, cur + 1);
                // Only count as a useful match if we haven't exceeded the target need
                if (cur < rightTarget) {
                    matches++;
                }
            }

            // --- Shrink Phase: advance left pointer ---
            // Shrink if window exceeds max size
            while (right - left + 1 > maxWindowSize) {
                const leftToken = sourceTokens[left].text;
                const leftTarget = targetFreq.get(leftToken) || 0;
                if (leftTarget > 0) {
                    const cur = windowFreq.get(leftToken)!;
                    windowFreq.set(leftToken, cur - 1);
                    if (cur <= leftTarget) {
                        matches--;
                    }
                }
                left++;
            }

            // Shrink further to discard useless/surplus tokens from left
            while (left < right) {
                const leftToken = sourceTokens[left].text;
                const leftTarget = targetFreq.get(leftToken) || 0;
                if (leftTarget === 0) {
                    // Not a target token at all — discard
                    left++;
                } else {
                    const cur = windowFreq.get(leftToken)!;
                    if (cur > leftTarget) {
                        // Surplus — we have more than needed, safe to discard
                        windowFreq.set(leftToken, cur - 1);
                        left++;
                    } else {
                        break; // This token is critically needed, stop shrinking
                    }
                }
            }

            // --- Capture Best State ---
            if (matches / totalTargets > 0.3) {
                const startToken = sourceTokens[left];
                const endToken = sourceTokens[right];
                const charLength = (endToken.offset + endToken.text.length) - startToken.offset;

                // Tie-breaking: most matches wins; on tie, shortest character span wins
                if (matches > maxMatches || (matches === maxMatches && charLength < minWindowLength)) {
                    maxMatches = matches;
                    minWindowLength = charLength;
                    bestWindow = [
                        elasticStart + startToken.offset,
                        elasticStart + endToken.offset + endToken.text.length
                    ];
                }
            }
        }

        return bestWindow;
    }

    private extractAnchorWords(content: string, limit: number): string[] {
        // Extract tokens 3+ characters long
        const tokens = this.tokenize(content)
            .filter(t => t.type === 'code' && t.text.length >= 3)
            .map(t => t.text);
            
        // Get unique tokens
        const uniqueTokens = Array.from(new Set(tokens));
        
        // Sort by length descending, as longer words are more likely to be unique globally
        uniqueTokens.sort((a, b) => b.length - a.length);
        
        return uniqueTokens.slice(0, limit);
    }

    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    }

    private findLongestCommonSubstring(line: string, searchArea: string, minLength: number = 5): string {
        if (searchArea.includes(line)) return line;
        
        // Extract the longest consecutive match that still meets minLength requirement
        for (let len = line.length - 1; len >= minLength; len--) {
            for (let i = 0; i <= line.length - len; i++) {
                const sub = line.substr(i, len);
                if (searchArea.includes(sub)) {
                    return sub;
                }
            }
        }
        return '';
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
        if (encoding === 'utf8bom') {
            encoding = 'utf-8';
        }
        try {
            return new TextDecoder(encoding).decode(bytes);
        } catch {
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