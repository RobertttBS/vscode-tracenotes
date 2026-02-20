import * as vscode from 'vscode';
import { TracePoint, TraceTree, MAX_DEPTH } from './types';

export class TraceManager implements vscode.Disposable {
    private static readonly SEARCH_RADIUS = 5000;
    private static readonly MAX_REGEX_LENGTH = 2000;
    private static readonly VALIDATION_BUDGET_MS = 15;

    private trees: TraceTree[] = [];
    private activeTreeId: string | null = null;
    private activeGroupId: string | null = null;

    // Fast-path lookup maps
    private traceIndex: Map<string, TracePoint[]> = new Map();
    private traceIdMap: Map<string, TracePoint> = new Map();
    private parentIdMap: Map<string, string | null> = new Map();

    private readonly storageKey = 'tracenotes.traces';
    private readonly activeGroupKey = 'tracenotes.activeGroupId';
    private readonly activeTreeKey = 'tracenotes.activeTreeId';

    // Debounce / Batching
    private validationDebounceTimer: NodeJS.Timeout | undefined;
    private persistenceDebounceTimer: NodeJS.Timeout | undefined;
    private validationCts: vscode.CancellationTokenSource | undefined;
    private treeValidationCts: vscode.CancellationTokenSource | undefined;
    private pendingValidationDocs: Map<string, vscode.TextDocument> = new Map();

    private _onDidChangeTraces = new vscode.EventEmitter<void>();
    public readonly onDidChangeTraces = this._onDidChangeTraces.event;

    constructor(private context: vscode.ExtensionContext) {
        this.restore();

        // Cleanup validation queue when documents are closed to avoid memory leaks
        context.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.pendingValidationDocs.delete(doc.uri.toString());
            })
        );
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

    private restore(): void {
        const saved = this.context.workspaceState.get<any>(this.storageKey);

        if (saved && Array.isArray(saved)) {
            const isNewFormat = saved.length > 0 && 'traces' in saved[0];

            if (isNewFormat) {
                this.trees = saved;
            } else {
                const defaultTree: TraceTree = {
                    id: 'default',
                    name: 'Default Trace',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    traces: saved,
                };
                this.trees = [defaultTree];
                this.persist();
            }
        } else {
            this.trees = [{
                id: 'default',
                name: 'Default Trace',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                traces: []
            }];
        }

        const savedTreeId = this.context.workspaceState.get<string | null>(this.activeTreeKey);
        this.activeTreeId = (savedTreeId && this.trees.some(t => t.id === savedTreeId))
            ? savedTreeId
            : this.trees[0].id;

        const savedGroupId = this.context.workspaceState.get<string | null>(this.activeGroupKey);
        // Only restore if the group still exists in the map
        this.rebuildTraceIndex();
        this.activeGroupId = (savedGroupId && this.findTraceById(savedGroupId)) ? savedGroupId : null;
    }

    private persist(): void {
        const active = this.getActiveTree();
        if (active) {
            active.updatedAt = Date.now();
        }

        if (this.persistenceDebounceTimer) {
            clearTimeout(this.persistenceDebounceTimer);
        }

        this.persistenceDebounceTimer = setTimeout(() => {
            this.context.workspaceState.update(this.storageKey, this.trees);
            this.persistenceDebounceTimer = undefined;
        }, 2000);
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

            await this.validateAndRecover(trace);

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

    // ── Public: CRUD ─────────────────────────────────────────────

    public add(trace: TracePoint): void {
        const target = this.getActiveChildren();
        target.push(trace);

        const validUri = vscode.Uri.file(trace.filePath).toString();

        const existing = this.traceIndex.get(validUri) || [];
        existing.push(trace);
        this.traceIndex.set(validUri, existing);

        this.traceIdMap.set(trace.id, trace);
        this.parentIdMap.set(trace.id, this.activeGroupId);

        this.persist();
        this._onDidChangeTraces.fire();
    }

    public remove(id: string): void {
        this.removeFromTree(id);

        if (this.activeGroupId && !this.findTraceById(this.activeGroupId)) {
            this.activeGroupId = null;
            this.persistActiveGroup();
        }

        this.rebuildTraceIndex();
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

    public relocateTrace(id: string, document: vscode.TextDocument, selection: vscode.Selection): void {
        const trace = this.findTraceById(id);
        if (!trace) { return; }

        const oldFilePath = trace.filePath;
        const newFilePath = document.uri.fsPath;
        const isDifferentFile = oldFilePath !== newFilePath;

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
                const idx = oldIndexList.findIndex(t => t.id === id);
                if (idx !== -1) {
                    oldIndexList.splice(idx, 1);
                    if (oldIndexList.length === 0) {
                        this.traceIndex.delete(oldUriStr);
                    }
                }
            }

            const newUriStr = document.uri.toString();
            const newIndexList = this.traceIndex.get(newUriStr) || [];
            newIndexList.push(trace);
            this.traceIndex.set(newUriStr, newIndexList);
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
        for (const t of list) {
            result.push(t);
            if (t.children?.length) {
                result.push(...this.getAllFlat(t.children));
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
        children.length = 0;

        this.rebuildTraceIndex();
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
        if (!tracesInFile || tracesInFile.length === 0) return;

        let needsValidation = false;

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

        if (needsValidation) {
            this.pendingValidationDocs.set(docUriStr, document);

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

    private processValidationQueue(token: vscode.CancellationToken): void {
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

        const iterator = this.pendingValidationDocs.entries();
        let result = iterator.next();

        while (!result.done) {
            if (token.isCancellationRequested) return;

            const [uri, document] = result.value;

            if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
                if (this.validationDebounceTimer) { clearTimeout(this.validationDebounceTimer); }
                this.validationDebounceTimer = setTimeout(() => {
                    this.processValidationQueue(token);
                }, 0);
                break;
            }

            this.pendingValidationDocs.delete(uri);

            const tracesInFile = this.traceIndex.get(document.uri.toString());
            if (tracesInFile) {
                for (const trace of tracesInFile) {
                    if (token.isCancellationRequested) return;

                    if (Date.now() - startTime > TraceManager.VALIDATION_BUDGET_MS) {
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

                    const newStartLine = startPos.line;
                    const newEndLine = endPos.line;

                    if (!trace.lineRange || trace.lineRange[0] !== newStartLine || trace.lineRange[1] !== newEndLine) {
                        trace.lineRange = [newStartLine, newEndLine];
                        stateChanged = true;
                    }

                    const currentContent = document.getText(new vscode.Range(startPos, endPos));

                    if (!this.contentMatches(currentContent, trace.content)) {
                        const recovered = this.recoverTracePoints(document, trace.content, startOffset);
                        if (recovered) {
                            trace.rangeOffset = recovered;
                            const rStart = document.positionAt(recovered[0]);
                            const rEnd = document.positionAt(recovered[1]);
                            trace.lineRange = [rStart.line, rEnd.line];
                            trace.orphaned = false;
                        } else {
                            trace.highlight = 'red';
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

            const headIdx = searchArea.indexOf(headText);
            if (headIdx >= 0) {
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
        const normDoc = docContent.replace(/\s+/g, ' ').trim();
        const normStored = storedContent.replace(/\s+/g, ' ').trim();
        return normDoc === normStored;
    }

    private rebuildTraceIndex(): void {
        this.traceIndex.clear();
        this.traceIdMap.clear();
        this.parentIdMap.clear();

        const visit = (traces: TracePoint[], parentId: string | null) => {
            for (const t of traces) {
                const validUri = vscode.Uri.file(t.filePath).toString();

                const list = this.traceIndex.get(validUri) || [];
                list.push(t);
                this.traceIndex.set(validUri, list);

                this.traceIdMap.set(t.id, t);
                this.parentIdMap.set(t.id, parentId);

                if (t.children && t.children.length > 0) {
                    visit(t.children, t.id);
                }
            }
        };

        const activeTree = this.getActiveTree();
        if (activeTree) {
            visit(activeTree.traces, null);
        }
    }

    public getTracesForFile(filePath: string): TracePoint[] {
        return this.traceIndex.get(vscode.Uri.file(filePath).toString()) || [];
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
        const lines = markdown.split('\n');
        const rootTraces: TracePoint[] = [];
        const stack: { trace: TracePoint, depth: number }[] = [];

        let currentTrace: Partial<TracePoint> | null = null;
        let currentContent: string[] = [];
        let capturingContent = false;

        const headerRegex = /^(#+)\s+\d+\.\s+(.*)/;
        const codeBlockStartRegex = /^```(\w*)\s+(\d+|\?):(\d+|\?):(.+)$/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('```') && !capturingContent) {
                const match = line.match(codeBlockStartRegex);
                if (match && currentTrace) {
                    capturingContent = true;
                    currentTrace.lang = match[1];
                    const startLine = match[2] === '?' ? 0 : parseInt(match[2]) - 1;
                    const endLine = match[3] === '?' ? 0 : parseInt(match[3]) - 1;
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

                    const validated = await this.validateAndRecover(currentTrace as TracePoint);
                    if (validated) {
                        const trace = validated;

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

            const headerMatch = line.match(headerRegex);
            if (headerMatch) {
                const hashes = headerMatch[1];
                const rawTitle = headerMatch[2].trim();

                const depth = hashes.length - 2;
                if (depth < 0) continue;

                let title = rawTitle;
                let isOrphaned = false;
                if (title.endsWith('(Orphaned)')) {
                    title = title.replace('(Orphaned)', '').trim();
                }

                currentTrace = {
                    id: crypto.randomUUID(),
                    note: title,
                    orphaned: isOrphaned,
                    children: [],
                    _tempDepth: depth
                } as any;

            } else if (currentTrace && line.trim().length > 0 && !line.trim().startsWith('---')) {
                currentTrace.note += '\n' + line;
            }
        }

        return rootTraces;
    }

    private async validateAndRecover(trace: TracePoint): Promise<TracePoint | null> {
        try {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(trace.filePath));
            } catch {
                console.warn('Trace validation skipped missing file:', trace.filePath);
                trace.highlight = 'red';
                trace.orphaned = true;
                return null;
            }

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(trace.filePath));

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

            let estimatedOffset = 0;
            if (trace.lineRange && trace.lineRange[0] < doc.lineCount) {
                estimatedOffset = doc.offsetAt(new vscode.Position(trace.lineRange[0], 0));
            }

            const recovered = this.recoverTracePoints(doc, trace.content, estimatedOffset);
            if (recovered) {
                trace.rangeOffset = recovered;
                const rStart = doc.positionAt(recovered[0]);
                const rEnd = doc.positionAt(recovered[1]);
                trace.lineRange = [rStart.line, rEnd.line];
                trace.orphaned = false;
                return trace;
            } else {
                trace.highlight = 'red';
                trace.orphaned = true;
                return trace;
            }
        } catch (e) {
            console.warn('Trace import error:', e);
            trace.highlight = 'red';
            trace.orphaned = true;
            return trace;
        }
    }
}