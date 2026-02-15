import * as vscode from 'vscode';
import { TracePoint, MAX_DEPTH } from './types';

const SEARCH_RADIUS = 5000;
const MAX_REGEX_LENGTH = 2000; 

/**
 * Manages the collection of TracePoints as a tree (up to 3 levels deep).
 * Persists both traces and activeGroupId to workspaceState to survive reloads.
 */
export class TraceManager {
    private traces: TracePoint[] = [];
    private activeGroupId: string | null = null;
    private readonly storageKey = 'tracenotes.traces';
    private readonly activeGroupKey = 'tracenotes.activeGroupId';

    // Debounce / Batching
    private validationDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    private pendingValidationDocs: Map<string, vscode.TextDocument> = new Map();
    private _onDidChangeTraces = new vscode.EventEmitter<void>();
    public readonly onDidChangeTraces = this._onDidChangeTraces.event;

    constructor(private context: vscode.ExtensionContext) {
        this.restore();
    }

    // ── Persistence ──────────────────────────────────────────────

    /** Restore traces and activeGroupId from workspaceState */
    private restore(): void {
        const saved = this.context.workspaceState.get<TracePoint[]>(this.storageKey);
        if (saved && Array.isArray(saved)) {
            this.traces = saved;
        }
        // Restore activeGroupId — validate it still exists in the tree
        const savedGroupId = this.context.workspaceState.get<string | null>(this.activeGroupKey);
        if (savedGroupId && this.findTraceById(savedGroupId)) {
            this.activeGroupId = savedGroupId;
        } else {
            this.activeGroupId = null;
        }
    }

    /** Persist current traces to workspaceState */
    private persist(): void {
        // Use undefined if array is empty to strictly remove the key from storage
        const data = this.traces.length > 0 ? this.traces : undefined;
        this.context.workspaceState.update(this.storageKey, data);
    }

    /** Persist activeGroupId to workspaceState */
    private persistActiveGroup(): void {
        // Use undefined if null to strictly remove the key from storage
        const data = this.activeGroupId !== null ? this.activeGroupId : undefined;
        this.context.workspaceState.update(this.activeGroupKey, data);
    }

    // ── Tree helpers ─────────────────────────────────────────────

    /** Recursively find a trace by id */
    findTraceById(id: string, list: TracePoint[] = this.traces): TracePoint | undefined {
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
    private findParentList(id: string, list: TracePoint[] = this.traces): TracePoint[] | undefined {
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
    private getDepth(id: string, list: TracePoint[] = this.traces, depth: number = 0): number {
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
        this.persist();
    }

    /** Recursively remove a trace by id from anywhere in the tree */
    remove(id: string): void {
        // If removing the active group itself, reset to root
        if (id === this.activeGroupId) {
            this.activeGroupId = null;
            this.persistActiveGroup();
        }
        this.removeFromTree(id, this.traces);
        this.persist();
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
    }

    /** Update the note of a trace (recursive search) */
    updateNote(id: string, note: string): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.note = note;
            this.persist();
        }
    }

    /** Update the highlight color of a trace */
    updateHighlight(id: string, highlight: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null): void {
        const trace = this.findTraceById(id);
        if (trace) {
            trace.highlight = highlight;
            this.persist();
        }
    }

    /** Return the full root-level tree (with nested children) */
    getAll(): TracePoint[] {
        return [...this.traces];
    }

    /** Recursively collect every TracePoint across all levels into a flat list */
    getAllFlat(list: TracePoint[] = this.traces): TracePoint[] {
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
        this.traces = [];
        this.activeGroupId = null;
        this.persist();
        this.persistActiveGroup();
    }

    /** Clear traces in the current active group (or root) */
    clearActiveChildren(): void {
        const children = this.getActiveChildren();
        children.length = 0; // Clear in-place
        this.persist();
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
        return true;
    }

    /** Go up one level. Returns the new activeGroupId (null = root). */
    exitGroup(): string | null {
        if (this.activeGroupId === null) { return null; }
        const parentId = this.findParentTraceId(this.activeGroupId);
        this.activeGroupId = parentId;
        this.persistActiveGroup();
        return this.activeGroupId;
    }

    /** Find the id of the trace whose children array contains the given id */
    private findParentTraceId(
        id: string,
        list: TracePoint[] = this.traces,
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
        if (this.activeGroupId === null) { return this.traces; }
        const group = this.findTraceById(this.activeGroupId);
        if (!group) {
            this.activeGroupId = null;
            this.persistActiveGroup();
            return this.traces;
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
        const tracesInFile = this.getAllFlat().filter(t => t.filePath === document.uri.fsPath);
        
        if (tracesInFile.length === 0) return;

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

        // Clone and clear the queue so incoming edits don't interfere
        const docsToProcess = new Map(this.pendingValidationDocs);
        this.pendingValidationDocs.clear();

        let stateChanged = false;

        for (const document of docsToProcess.values()) {
            const tracesInFile = this.getAllFlat().filter(t => t.filePath === document.uri.fsPath);
            
            // Re-run your validation logic per document
            for (const trace of tracesInFile) {
                if (!trace.rangeOffset) continue;

                const [startOffset, endOffset] = trace.rangeOffset;
                
                if (startOffset < 0 || endOffset > document.getText().length) {
                    trace.orphaned = true;
                    stateChanged = true;
                    continue;
                }

                const startPos = document.positionAt(startOffset);
                const endPos = document.positionAt(endOffset);
                trace.lineRange = [startPos.line, endPos.line];

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
                        trace.orphaned = true;
                    }
                    stateChanged = true;
                } else if (trace.orphaned) {
                    trace.orphaned = false;
                    stateChanged = true;
                }
            }
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
        
        const searchStart = Math.max(0, lastKnownStart - SEARCH_RADIUS);
        const searchEnd = Math.min(fullText.length, lastKnownStart + SEARCH_RADIUS + storedContent.length);
        const searchArea = fullText.slice(searchStart, searchEnd);

        let idx = searchArea.indexOf(storedContent);
        if (idx >= 0) {
            const absoluteStart = searchStart + idx;
            return [absoluteStart, absoluteStart + storedContent.length];
        }

        if (storedContent.length <= MAX_REGEX_LENGTH) {
            const escapedContent = storedContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flexibleRegexStr = escapedContent.replace(/\s+/g, '\\s+');
            
            try {
                const regex = new RegExp(flexibleRegexStr, 'g');
                const match = regex.exec(searchArea);
                
                if (match) {
                    // regex.exec 的好處是：match[0].length 就是它在「實際文件」中佔用的長度！
                    // 完美解決了您「無法映射回原始 offset」的困擾。
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
}
