import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => import('../test/vscodeMock'));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, workspace, config, makeDoc } from '../test/vscodeMock';
import { TraceManager } from '../traceManager';
import type { TracePoint } from '../types';
import { handle } from './server';

const CODE = 'const a = 1;\nfunction target() { return 42; }\nconst z = 2;\n';
const SNIPPET = 'function target() { return 42; }';

let tmp: string;
let root: string;
let m: TraceManager;
/** Files openTextDocument can see (mirrored on disk, which validation stats); others throw like a deleted file. */
let files: Record<string, string>;

beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracenotes-bridge-'));
    root = path.join(tmp, 'ws');
    fs.mkdirSync(root);
    config.projectId = 'test-project';
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws' }];
    files = {};
    (workspace as any).openTextDocument = async (p: string) => {
        if (!(p in files)) { throw new Error(`ENOENT ${p}`); }
        return makeDoc(p, files[p]);
    };
    const state = new Map<string, unknown>();
    m = new TraceManager({
        subscriptions: [],
        globalStorageUri: Uri.file(path.join(tmp, 'global')),
        storageUri: Uri.file(path.join(tmp, 'storage')),
        workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    } as any);
    await m.ensureReady();
});

afterEach(() => {
    m.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function card(name: string, extra: Partial<TracePoint> = {}): TracePoint {
    return { id: `${name}-${++seq}`, filePath: '', rangeOffset: [0, 0], lineRange: [0, 0], content: '', lang: 'plaintext', note: name, timestamp: 0, ...extra };
}

/** A trace on SNIPPET in `file` (written with `text`). */
function codeCard(name: string, file: string, text = CODE): TracePoint {
    files[file] = text;
    fs.writeFileSync(file, text);
    const start = CODE.indexOf(SNIPPET);
    return card(name, { filePath: file, rangeOffset: [start, start + SNIPPET.length], lineRange: [1, 1], content: SNIPPET, lang: 'typescript' });
}

const run = (op: string, args: Record<string, string | undefined> = {}) => handle(m, op, args) as Promise<any>;
const activeName = () => m.getActiveTreeData()?.name;

describe('bridge handle()', () => {
    it('switches to the tree holding a trace id, from any active tree', async () => {
        const a = card('a');
        m.add(a);
        m.createTree('Other');
        await run('note', { id: a.id, text: 'renamed' });
        expect(activeName()).toBe('Default Trace');
        expect(m.findTraceById(a.id)!.note).toBe('renamed');
    });

    it('add rejects an anchor that is not in --tree, and changes nothing', async () => {
        const a = card('a');
        m.add(a);
        m.createTree('Other');
        await expect(run('add', { tree: 'Other', parent: a.id, markdown: '## x' })).rejects.toThrow(/not in tree "Other"/);
        expect(m.findTraceById(a.id)!.children ?? []).toEqual([]);
        expect(m.getTreesReadonly().find(t => t.name === 'Other')!.traces).toEqual([]);
    });

    it('add puts traces under --parent, or beside --after', async () => {
        const a = card('a');
        m.add(a);
        await run('add', { parent: a.id, markdown: '## child' });
        await run('add', { after: a.id, markdown: '## sibling' });
        expect(m.getAll().map(t => t.note)).toEqual(['a', 'sibling']);
        expect(m.findTraceById(a.id)!.children!.map(t => t.note)).toEqual(['child']);
        await expect(run('add', { parent: a.id, after: a.id, markdown: '## x' })).rejects.toThrow(/only one of/);
    });

    it('rm checks every id first: one unknown id removes nothing', async () => {
        const [a, b] = [card('a'), card('b')];
        m.add(a);
        m.add(b);
        await expect(run('rm', { id: `${a.id} nope` })).rejects.toThrow(/No trace with id nope/);
        expect(m.getAll()).toHaveLength(2);
    });

    it('rm skips a child already removed with its parent, across trees', async () => {
        const parent = card('p');
        m.add(parent);
        m.enterGroup(parent.id);
        const child = card('c');
        m.add(child);
        m.exitGroup();
        m.createTree('Other');
        const other = card('o');
        m.add(other);
        const res = await run('rm', { id: `${parent.id} ${child.id} ${other.id}` });
        expect(res.removed).toEqual([parent.id, other.id]);
        expect(m.getTreesReadonly().every(t => t.traces.length === 0)).toBe(true);
    });

    it('refresh checks every id first: a trace without code leaves the others untouched', async () => {
        const file = path.join(root, 'a.ts');
        const t = codeCard('t', file);
        const n = card('n');
        m.add(t);
        m.add(n);
        const before = { content: t.content, rangeOffset: [...t.rangeOffset], lineRange: [...t.lineRange!] };
        await expect(run('refresh', { id: `${t.id} ${n.id}`, lines: undefined })).rejects.toThrow(/has no code/);
        await expect(run('refresh', { id: t.id, lines: '1:99' })).rejects.toThrow(/outside/);
        expect(m.findTraceById(t.id)).toMatchObject(before); // validation may set orphaned: false

        const res = await run('refresh', { id: t.id, lines: '1:1' });
        expect(m.findTraceById(t.id)).toMatchObject({ content: 'const a = 1;', lineRange: [0, 0], rangeOffset: [0, 12] });
        expect(res.refreshed[0].at).toBe(`${file}:1-1`);
    });

    it('check warns about code that drifted, orphaned traces and unreadable files', async () => {
        const drifted = codeCard('drifted', path.join(root, 'a.ts'), CODE.replace('42', '43'));
        const orphan = codeCard('orphan', path.join(root, 'b.ts'), 'nothing like it\n');
        const gone = codeCard('gone', path.join(root, 'gone.ts'));
        delete files[gone.filePath];
        fs.rmSync(gone.filePath);
        const fine = codeCard('fine', path.join(root, 'c.ts'));
        [drifted, orphan, gone, fine].forEach(t => m.add(t));

        const { warnings } = await run('check');
        const about = (t: TracePoint) => warnings.filter((w: string) => w.startsWith(t.id));
        expect(about(drifted)).toEqual([expect.stringMatching(/code differs from the file/)]);
        expect(about(orphan)).toEqual([expect.stringMatching(/orphaned/)]);
        expect(about(gone)).toHaveLength(1);
        expect(about(fine)).toEqual([]);
    });

    it('create, rename and delete-tree address trees by name', async () => {
        const created = await run('create', { name: 'Flow', markdown: '## step one\n### step two' });
        expect(created.traces[0]).toMatchObject({ title: 'step one', children: [{ title: 'step two' }] });
        expect(activeName()).toBe('Flow');
        await run('rename', { tree: 'Flow', name: 'Login flow' });
        expect(m.getTreeList().map(t => t.name)).toContain('Login flow');
        await run('delete-tree', { tree: 'Login flow' });
        expect(m.getTreeList().map(t => t.name)).not.toContain('Login flow');
        await expect(run('delete-tree', { tree: 'Login flow' })).rejects.toThrow(/No trace tree/);
        await expect(run('bogus')).rejects.toThrow(/Unknown command/);
    });
});
