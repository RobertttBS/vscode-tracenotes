import { describe, it, expect, vi } from 'vitest';

// --- MOCK VSCODE ---
// Minimal surface needed to construct TraceManager and run generateMarkdown /
// parseMarkdown without a real VS Code host.
vi.mock('vscode', () => {
    const join = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/');
    const Uri = {
        file: (p: string) => ({ fsPath: p, toString: () => p }),
        joinPath: (base: any, ...segs: string[]) => Uri.file(join(base.fsPath, ...segs)),
        parse: (p: string) => Uri.file(p),
    };
    return {
        Uri,
        workspace: {
            workspaceFolders: [{ uri: Uri.file('/workspace') }],
            asRelativePath: (p: string) => String(p).replace('/workspace/', ''),
            getConfiguration: () => ({ get: () => 'utf8' }),
            onDidCloseTextDocument: () => ({ dispose() {} }),
            onDidChangeTextDocument: () => ({ dispose() {} }),
            textDocuments: [],
            findFiles: async () => [],
            fs: {
                readFile: async () => new Uint8Array(),
                createDirectory: async () => {},
                writeFile: async () => {},
            },
        },
        window: {
            createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {}, show() {} }),
            showErrorMessage: () => {},
        },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
        Range: class { constructor(public start: any, public end: any) {} },
        Position: class { constructor(public line: number, public character: number) {} },
        CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() {} dispose() {} },
    };
});

import { generateMarkdown } from './exporter';
import { TraceManager } from './traceManager';
import { NOTE_BLOCK_START, NOTE_BLOCK_END, type TracePoint } from './types';

function makeTrace(partial: Partial<TracePoint>): TracePoint {
    return {
        id: Math.random().toString(36).slice(2),
        filePath: '',
        rangeOffset: [0, 0],
        content: '',
        lang: 'plaintext',
        note: '',
        timestamp: 0,
        ...partial,
    };
}

// parseMarkdown is private and otherwise runs each parsed trace through
// validateAndRecover (which touches the workspace). Stub recovery to a
// pass-through so the test exercises only the serialize/parse round-trip.
async function parse(md: string): Promise<TracePoint[]> {
    const ctx = {
        subscriptions: [],
        globalStorageUri: { fsPath: '/tmp' },
        workspaceState: { get: () => ({}), update: async () => {} },
        globalState: { get: () => ({}), update: async () => {} },
    } as any;
    const manager = new TraceManager(ctx);
    (manager as any).validateAndRecover = async (t: TracePoint) => t;
    return (manager as any).parseMarkdown(md);
}

describe('markdown note round-trip (method A)', () => {
    it('preserves note headings, blank lines and rules verbatim', async () => {
        const note = '# Title\n\nfirst paragraph\n\n## Section\n- item one\n- item two\n\n---\n\nclosing line';
        const md = generateMarkdown([makeTrace({ note })]);

        expect(md).toContain(NOTE_BLOCK_START);
        expect(md).toContain(NOTE_BLOCK_END);

        const parsed = await parse(md);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe(note);
    });

    it('keeps the trace tree hierarchy across the round-trip', async () => {
        const traces = [
            makeTrace({
                note: 'root note\nsecond line',
                highlight: 'blue',
                children: [
                    makeTrace({ note: 'child A\n\n## heading inside child' }),
                    makeTrace({ note: 'child B', children: [makeTrace({ note: 'grandchild' })] }),
                ],
            }),
        ];
        const parsed = await parse(generateMarkdown(traces));

        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe('root note\nsecond line');
        expect(parsed[0].highlight).toBe('blue');

        const children = parsed[0].children!;
        expect(children).toHaveLength(2);
        expect(children[0].note).toBe('child A\n\n## heading inside child');
        expect(children[1].note).toBe('child B');
        expect(children[1].children![0].note).toBe('grandchild');
    });

    it('still parses legacy un-fenced exports (title + body) for backward compatibility', async () => {
        const legacy = [
            '# Trace Result - 2024-01-01',
            '',
            '## 1. %%Note%% first line',
            '',
            'body line one',
            'body line two',
            '',
        ].join('\n');

        const parsed = await parse(legacy);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe('first line\nbody line one\nbody line two');
        expect(parsed[0].highlight).toBe('blue');
    });

    it('round-trips a note body that itself contains a closing fence delimiter', async () => {
        const note = 'before the delimiter\n<!-- /tracenote -->\nafter the delimiter';
        const parsed = await parse(generateMarkdown([makeTrace({ note })]));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe(note);
    });

    it('round-trips a note body that itself contains an opening fence delimiter', async () => {
        const note = 'before\n<!-- tracenote -->\nafter';
        const parsed = await parse(generateMarkdown([makeTrace({ note })]));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe(note);
    });

    it('keeps the accumulated body when a fenced note is never closed before EOF', async () => {
        const md = ['## 1. Title', '', NOTE_BLOCK_START, 'line one', 'line two'].join('\n');
        const parsed = await parse(md);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].note).toBe('line one\nline two');
    });

    it('derives a clean heading title by stripping the leading # from the first note line', async () => {
        const md = generateMarkdown([makeTrace({ note: '# Overview\nbody' })]);
        // The structural heading shows "Overview", not "# Overview".
        expect(md).toContain('## 1. Overview');
        // ...but the note itself round-trips with the leading # intact.
        expect((await parse(md))[0].note).toBe('# Overview\nbody');
    });
});
