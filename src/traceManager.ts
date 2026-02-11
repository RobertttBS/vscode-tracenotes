import * as vscode from 'vscode';
import { TracePoint } from './types';

const MAX_DEPTH = 3;

/**
 * Manages the collection of TracePoints as a tree (up to 3 levels deep).
 * Persists state to workspaceState to survive accidental reloads.
 * `activeGroupId` tracks the current insertion point (not persisted).
 */
export class TraceManager {
    private traces: TracePoint[] = [];
    private activeGroupId: string | null = null;
    private readonly storageKey = 'mindstack.traces';

    constructor(private context: vscode.ExtensionContext) {
        this.restore();
    }

    // ── Persistence ──────────────────────────────────────────────

    /** Restore traces from workspaceState */
    private restore(): void {
        const saved = this.context.workspaceState.get<TracePoint[]>(this.storageKey);
        if (saved && Array.isArray(saved)) {
            this.traces = saved;
        }
    }

    /** Persist current traces to workspaceState */
    private persist(): void {
        this.context.workspaceState.update(this.storageKey, this.traces);
    }

    // ── Tree helpers ─────────────────────────────────────────────

    /** Recursively find a trace by id */
    private findTrace(id: string, list: TracePoint[] = this.traces): TracePoint | undefined {
        for (const t of list) {
            if (t.id === id) { return t; }
            if (t.children?.length) {
                const found = this.findTrace(id, t.children);
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
        const trace = this.findTrace(id);
        if (trace) {
            trace.note = note;
            this.persist();
        }
    }

    /** Return the full root-level tree (with nested children) */
    getAll(): TracePoint[] {
        return [...this.traces];
    }

    /** Clear all traces and reset active group */
    clear(): void {
        this.traces = [];
        this.activeGroupId = null;
        this.persist();
    }

    // ── Public: Navigation ───────────────────────────────────────

    /** Drill into a trace's children. Returns false if id not found or depth exceeded. */
    enterGroup(id: string): boolean {
        const depth = this.getDepth(id);
        if (depth < 0 || depth >= MAX_DEPTH - 1) { return false; }
        const trace = this.findTrace(id);
        if (!trace) { return false; }
        // Ensure children array exists
        if (!trace.children) { trace.children = []; }
        this.activeGroupId = id;
        return true;
    }

    /** Go up one level. Returns the new activeGroupId (null = root). */
    exitGroup(): string | null {
        if (this.activeGroupId === null) { return null; }
        // Find the parent trace that contains activeGroupId
        // Walk the tree to find which trace's children array holds activeGroupId
        const parentId = this.findParentTraceId(this.activeGroupId);
        this.activeGroupId = parentId;
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
     * Return the children of the active group (or the root array).
     * Returns the *actual* backing array — mutations will be persisted.
     */
    getActiveChildren(): TracePoint[] {
        if (this.activeGroupId === null) { return this.traces; }
        const group = this.findTrace(this.activeGroupId);
        if (!group) {
            // Stale id — reset
            this.activeGroupId = null;
            return this.traces;
        }
        if (!group.children) { group.children = []; }
        return group.children;
    }
}
