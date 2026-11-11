// Regression tests for docs/anchoring-cli-review.md (A1–A10). Each case names its item.
import { beforeEach, expect, it, vi } from 'vitest';

const mockVscode: any = vi.hoisted(() => {
    const files: Record<string, string> = {};
    const uri = (p: string) => ({ fsPath: p, toString: () => p });
    return {
        __files: files,
        __reads: { count: 0 },
        Uri: { file: uri, joinPath: (base: any, ...s: string[]) => uri([base.fsPath, ...s].join('/')) },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
            findFiles: async () => Object.keys(files).map(uri),
            fs: { readFile: async (u: any) => { mockVscode.__reads.count++; return Buffer.from(files[u.fsPath] ?? ''); }, createDirectory: async () => {}, writeFile: async () => {} },
            getConfiguration: () => ({ get: () => 'utf8' }),
            textDocuments: [] as any[],
            onDidCloseTextDocument: () => ({ dispose: () => {} }),
            onDidChangeTextDocument: () => ({ dispose: () => {} }),
        },
        Range: class { constructor(public start: any, public end: any) {} },
        Position: class { constructor(public line: number, public character: number) {} },
        EventEmitter: class { fire() {} event = () => {} },
        window: { createOutputChannel: () => ({ appendLine() {}, warn() {}, error() {}, info() {} }), showErrorMessage: () => {} },
        CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { this.token.isCancellationRequested = true; } dispose() {} },
    };
});
vi.mock('vscode', () => mockVscode);

import { TraceManager, AMBIGUOUS_DUPLICATE } from './traceManager';

const files: Record<string, string> = mockVscode.__files;
const ctx = { subscriptions: [], globalStorageUri: mockVscode.Uri.file('/tmp'), workspaceState: { get: () => ({}), update: async () => {} }, globalState: { get: () => ({}), update: async () => {} } } as any;
const m = new TraceManager(ctx) as any;
m.persist = () => {};
m.persistPositions = () => {};

const uri = mockVscode.Uri.file('/workspace/a.c');
const textDoc = (text: string) => ({ getText: () => text });
const filler = (n: number, tag: string, indent = '        ') =>
    Array.from({ length: n }, (_, i) => `${indent}${tag}_call_${i}(ctx, ${tag}_arg${i % 7});`).join('\n');
/** Same-file search with ambiguity detection, as recoverTracePoints' Level 1 runs it. */
const search = (text: string, stored: string, preferred: number) => m.searchInText(text, stored, preferred, undefined, true);

/** A document good enough for validateDocumentTraces. */
function liveDoc(text: string, p: string): any {
    const starts = [0];
    for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { starts.push(i + 1); } }
    const offsetAt = (pos: any) => starts[Math.min(pos.line, starts.length - 1)] + pos.character;
    return {
        uri: mockVscode.Uri.file(p), version: 1, lineCount: starts.length, offsetAt,
        positionAt: (o: number) => { let l = starts.length - 1; while (starts[l] > o) { l--; } return new mockVscode.Position(l, o - starts[l]); },
        getText: (r?: any) => r ? text.substring(offsetAt(r.start), offsetAt(r.end)) : text,
    };
}

beforeEach(() => {
    for (const k of Object.keys(files)) { delete files[k]; }
    mockVscode.__reads.count = 0;
});

it('A1: Tier B measures distance in one coordinate space and keeps the copy at preferredOffset', () => {
    const stored = 'if (ready) {\n    start_engine(unit);\n}';
    const ind = '                        ';
    const block = `${ind}if (ready) {\n${ind}        start_engine(unit);\n${ind}}`;
    for (const gap of [100, 130, 160]) {
        const text = filler(150, 'aa', ind) + '\n' + block + '\n' + filler(gap, 'bb', ind) + '\n' + block + '\n' + filler(50, 'cc', ind);
        const first = text.indexOf(block) + ind.length;
        const r = search(text, stored, first);
        expect(r, `gap ${gap}`).not.toBe(AMBIGUOUS_DUPLICATE);
        expect(r[0], `gap ${gap}`).toBe(first);
    }
});

it('A2: a long trace with one renamed identifier is recovered whole', () => {
    for (const n of [60, 100, 200]) {
        const body = Array.from({ length: n }, (_, i) => `    status_${i} = handle_step_${i}(device, buffer_${i}, length);`).join('\n');
        const stored = `int big_function(struct dev *device)\n{\n${body}\n    return 0;\n}`;
        const edited = stored.replace(`handle_step_${n >> 1}(`, 'process_step_x(');
        const text = filler(30, 'pre', '') + '\n' + edited + '\n' + filler(30, 'post', '');
        const start = text.indexOf('int big_function');
        expect(search(text, stored, start), `${n} lines`).toEqual([start, start + edited.length]);
    }
});

it('A3: a deleted block does not jump to a block that only shares its punctuation', async () => {
    const stored = 'if (ret < 0) {\n    dev_err(dev, "failed to init: %d\\n", ret);\n    return ret;\n}';
    const lookalike = 'if (err < 0) {\n    pr_warn(x, "other message", err);\n    return err;\n}';
    const text = filler(20, 'aa', '') + '\n/* traced block was here */\n' + filler(200, 'bb', '') + '\n' + lookalike + '\n' + filler(20, 'cc', '');
    expect(await m.recoverTracePoints(textDoc(text), stored, 500, uri)).toBeNull();
});

it('A3: a real edit of the same block is still recovered', () => {
    const stored = 'if (ret < 0) {\n    dev_err(dev, "failed to init: %d\\n", ret);\n    return ret;\n}';
    const edited = stored.replace('dev_err(dev,', 'dev_warn(dev,');
    const text = filler(20, 'aa', '') + '\n' + edited + '\n' + filler(20, 'cc', '');
    const start = text.indexOf('if (ret');
    expect(search(text, stored, start)).toEqual([start, start + edited.length]);
});

it('A5: a search window that starts inside a string literal still matches', () => {
    const body = Array.from({ length: 12 }, (_, i) => `    log_event("step ${i} done", value_${i});`).join('\n');
    const stored = `void report(void)\n{\n${body}\n}`;
    const edited = stored.replace('value_6', 'other_x');
    for (const pad of [0, 1, 2, 3]) {
        const text = `const char *banner = "${'x'.repeat(600 + pad * 150)}";\n` + edited + '\n' + filler(10, 'post', '');
        const start = text.indexOf('void report');
        expect(search(text, stored, start), `pad ${pad}`).toEqual([start, start + edited.length]);
    }
});

it('A6: common short anchors in a big file do not stall the search', () => {
    const body = Array.from({ length: 30 }, () => '    ret = fn(dev, buf, len);\n    if (ret) goto out;').join('\n');
    const stored = `int run(void)\n{\n${body}\n}`;
    const edited = stored.replace('goto out;', 'goto err;');
    const noise = Array.from({ length: 10000 }, (_, i) => `    ret = other_${i % 50}(dev, buf, len + ${i});`).join('\n');
    const text = noise + '\n' + edited + '\n' + noise;
    const start = text.indexOf('int run');
    expect(search(text, stored, start)).toEqual([start, start + edited.length]);
    // Cell updates, not wall time: ~190M before the budget (about 635 ms on this file).
    expect(m.dpOps).toBeLessThan(40_000_000);
});

it('A8: an already-orphaned trace does not rescan the workspace on every validation', async () => {
    files['/workspace/other.c'] = filler(50, 'zz', '');
    const p = '/workspace/a.c';
    const doc = liveDoc(filler(20, 'aa', ''), p);
    const trace = { id: 'o', filePath: p, rangeOffset: [0, 10], lineRange: [0, 0], content: 'totally_gone_function(alpha, beta);', note: '', lang: 'c', timestamp: 0 };
    m.traceIndex.set(p, new Set([trace]));
    try {
        await m.validateDocumentNow(doc);
        expect((trace as any).orphaned).toBe(true);
        const first = mockVscode.__reads.count;
        expect(first).toBeGreaterThan(0);
        await m.validateDocumentNow(doc);
        await m.validateDocumentNow(doc);
        expect(mockVscode.__reads.count).toBe(first);
    } finally {
        m.traceIndex.delete(p);
    }
});

it('A9: a validation cancelled mid-document is queued again and its changes are published', async () => {
    const p = '/workspace/q.c';
    const doc = liveDoc('line0\nline1', p);
    mockVscode.workspace.textDocuments.push(doc);
    const cts = new mockVscode.CancellationTokenSource();
    const realValidate = m.validateDocumentTraces;
    let published = 0;
    m.persistPositions = () => { published++; };
    // Stand-in for "an edit in another file cancelled us while awaiting a workspace search".
    m.validateDocumentTraces = async () => { cts.cancel(); return { changed: true }; };
    m.pendingValidationDocs.set(p, { uri: doc.uri, version: 1 });
    try {
        await m.processValidationQueue(cts.token);
        expect(m.pendingValidationDocs.has(p)).toBe(true);
        expect(published).toBe(1);
    } finally {
        m.validateDocumentTraces = realValidate;
        m.persistPositions = () => {};
        m.pendingValidationDocs.delete(p);
        mockVscode.workspace.textDocuments.length = 0;
    }
});

it('A10: content found in two other files is ambiguous, in one file it relocates', async () => {
    const stored = 'int unique_helper(struct dev *d)\n{\n    return d->state + compute_bias(d);\n}';
    files['/workspace/b.c'] = filler(5, 'bb', '') + '\n' + stored + '\n';
    const gone = textDoc(filler(20, 'aa', ''));
    const one = await m.recoverTracePoints(gone, stored, 0, uri);
    expect(one?.uri.fsPath).toBe('/workspace/b.c');
    files['/workspace/vendor/b_copy.c'] = stored + '\n';
    expect(await m.recoverTracePoints(gone, stored, 0, uri)).toBeNull();
});

it('A10: the stale on-disk copy of the file being validated is not a cross-file hit', async () => {
    const stored = 'int unique_helper(struct dev *d)\n{\n    return d->state + compute_bias(d);\n}';
    files['/workspace/a.c'] = stored; // disk still has it; the editor buffer does not
    expect(await m.recoverTracePoints(textDoc(filler(20, 'aa', '')), stored, 0, uri)).toBeNull();
});

// Follow-up review of the fixes above: anchors sit away from the content's start.
const ANCHOR_LINE = 'commit_transaction_alpha(release_resources_beta, notify_listeners_gamma);';
const plain = (n: number) => Array.from({ length: n }, () => 'a = a + b;').join('\n');
const tailAnchored = `${plain(60)}\n${ANCHOR_LINE}\n${plain(3)}`;
const editFirst = (s: string) => s.replace('a = a + b;', 'a = a - b;');

it('R1: a stray anchor word just before the trace does not hide the real match', () => {
    const edited = editFirst(tailAnchored);
    const text = filler(20, 'pre', '') + '\ncommit_transaction_alpha; release_resources_beta; notify_listeners_gamma;\n' + edited + '\n' + filler(20, 'post', '');
    const start = text.indexOf(edited);
    expect(search(text, tailAnchored, start)).toEqual([start, start + edited.length]);
});

it('R1: an unmoved trace wins over an equal copy even when its anchors are far from its start', () => {
    const edited = editFirst(tailAnchored);
    const text = filler(20, 'pre', '') + '\n' + edited + '\n' + filler(4, 'mid', '') + '\n' + edited + '\n' + filler(20, 'post', '');
    const start = text.lastIndexOf(edited);
    expect(search(text, tailAnchored, start)).toEqual([start, start + edited.length]);
});

it('R2: short lines under deep indentation are matched whole, anchor first or last', () => {
    const ind = ' '.repeat(32);
    for (const stored of [`${ANCHOR_LINE}\n${plain(9)}`, `${plain(9)}\n${ANCHOR_LINE}`]) {
        const edited = editFirst(stored);
        const inFile = edited.split('\n').map(l => ind + l).join('\n');
        const text = filler(20, 'pre', ind) + '\n' + inFile + '\n' + filler(20, 'post', ind);
        const start = text.indexOf(inFile) + ind.length;
        expect(search(text, stored, start), stored.slice(0, 10)).toEqual([start, start + inFile.length - ind.length]);
    }
});
