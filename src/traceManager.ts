import * as vscode from 'vscode';
import { TracePoint, MAX_DEPTH } from './types';

/**
 * Manages the collection of TracePoints as a tree (up to 3 levels deep).
 * Persists both traces and activeGroupId to workspaceState to survive reloads.
 */
export class TraceManager {
    private traces: TracePoint[] = [];
    private activeGroupId: string | null = null;
    private readonly storageKey = 'mindstack.traces';
    private readonly activeGroupKey = 'mindstack.activeGroupId';

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
        // Find the parent trace that contains activeGroupId
        // Walk the tree to find which trace's children array holds activeGroupId
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

    /**
     * Build a breadcrumb string for the active group, e.g. "1 / 2".
     * Each segment is the 1-based index of the ancestor trace within its parent list.
     */
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

    /**
     * Return the children of the active group (or the root array).
     * Returns the *actual* backing array — mutations will be persisted.
     */
    getActiveChildren(): TracePoint[] {
        if (this.activeGroupId === null) { return this.traces; }
        const group = this.findTraceById(this.activeGroupId);
        if (!group) {
            // Stale id — reset
            this.activeGroupId = null;
            this.persistActiveGroup();
            return this.traces;
        }
        if (!group.children) { group.children = []; }
        return group.children;
    }
}
