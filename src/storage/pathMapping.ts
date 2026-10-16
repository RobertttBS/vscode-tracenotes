import * as path from 'path';
import { TracePoint, TraceTree } from '../types';

function mapTraces(traces: TracePoint[], fn: (p: string) => string): TracePoint[] {
    return traces.map(t => ({
        ...t,
        filePath: t.filePath ? fn(t.filePath) : t.filePath,
        children: t.children && mapTraces(t.children, fn),
    }));
}

function mapTrees(trees: TraceTree[], fn: (p: string) => string): TraceTree[] {
    return trees.map(tree => ({ ...tree, traces: mapTraces(tree.traces, fn) }));
}

/** Copy of `trees` with in-workspace file paths made root-relative (posix separators). */
export function toShared(trees: TraceTree[], root: string): TraceTree[] {
    return mapTrees(trees, p => {
        const rel = path.relative(root, p);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return p; }
        return rel.split(path.sep).join('/');
    });
}

/** Inverse of `toShared`: resolves relative paths against this checkout's root; absolute paths pass through. */
export function fromShared(trees: TraceTree[], root: string): TraceTree[] {
    return mapTrees(trees, p => path.isAbsolute(p) ? p : path.join(root, p));
}
