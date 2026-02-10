import * as vscode from 'vscode';
import { TracePoint } from './types';

/**
 * Manages the collection of TracePoints.
 * Persists state to workspaceState to survive accidental reloads.
 */
export class TraceManager {
    private traces: TracePoint[] = [];
    private readonly storageKey = 'mindstack.traces';

    constructor(private context: vscode.ExtensionContext) {
        this.restore();
    }

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

    add(trace: TracePoint): void {
        this.traces.push(trace);
        this.persist();
    }

    remove(id: string): void {
        this.traces = this.traces.filter(t => t.id !== id);
        this.persist();
    }

    reorder(orderedIds: string[]): void {
        const map = new Map(this.traces.map(t => [t.id, t]));
        const reordered: TracePoint[] = [];
        for (const id of orderedIds) {
            const t = map.get(id);
            if (t) { reordered.push(t); }
        }
        this.traces = reordered;
        this.persist();
    }

    updateNote(id: string, note: string): void {
        const trace = this.traces.find(t => t.id === id);
        if (trace) {
            trace.note = note;
            this.persist();
        }
    }

    getAll(): TracePoint[] {
        return [...this.traces];
    }

    clear(): void {
        this.traces = [];
        this.persist();
    }
}
