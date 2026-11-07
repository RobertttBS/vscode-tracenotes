import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => import('../test/vscodeMock'));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, workspace, config, makeDoc } from '../test/vscodeMock';
import { TraceManager } from '../traceManager';
import type { TracePoint } from '../types';
import { handle, syncAgentSkills } from './server';

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
    (workspace as any).openTextDocument = async (arg: string | Uri) => {
        const p = typeof arg === 'string' ? arg : arg.fsPath; // the importer passes a Uri
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
        expect(activeName()).toBe('Other'); // a rejected add doesn't switch trees either
        expect(m.getTreesReadonly().find(t => t.name === 'Default Trace')!.traces[0].children ?? []).toEqual([]);
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

    it('add replies with the first line of code read, the tag and the workspace root', async () => {
        const file = path.join(root, 'a.ts');
        files[file] = CODE;
        fs.writeFileSync(file, CODE);
        const res = await run('add', { markdown: '## %%Important%% 0. step\n```ts 2:2:a.ts\n```' });
        expect(res.workspace).toEqual([root]);
        expect(res.added[0]).toMatchObject({ title: 'step', tag: 'Important', code: SNIPPET });
    });

    it('add --dry-run parses and reads code but adds nothing', async () => {
        const file = path.join(root, 'a.ts');
        files[file] = CODE;
        fs.writeFileSync(file, CODE);
        const res = await run('add', { dryRun: 'true', markdown: '## step\n```ts 1:1:a.ts\n```' });
        expect(res.wouldAdd[0]).toMatchObject({ title: 'step', code: 'const a = 1;' });
        expect(m.getAll()).toEqual([]);
    });

    it('add --dry-run rejects what a real add would, without switching trees', async () => {
        const a = card('a');
        m.add(a);
        m.createTree('Other');
        const dry = (args: Record<string, string>) => run('add', { dryRun: 'true', markdown: '## x', ...args });
        await expect(dry({ parent: a.id, after: a.id })).rejects.toThrow(/only one of/);
        await expect(dry({ parent: 'nope' })).rejects.toThrow(/No trace with id nope/);
        await expect(dry({ tree: 'Other', parent: a.id })).rejects.toThrow(/not in tree "Other"/);
        const deep = Array.from({ length: 10 }, (_, i) => `${'#'.repeat(i + 2)} d${i}`).join('\n');
        await expect(dry({ parent: a.id, markdown: deep })).rejects.toThrow(/maximum nesting depth/);
        await dry({ parent: a.id });
        expect(activeName()).toBe('Other');
    });

    it('title replaces only the first line; note and title drop a leading number', async () => {
        const a = card('a', { note: 'old\nbody one\nbody two' });
        m.add(a);
        await run('title', { id: a.id, text: '4. new' });
        expect(m.findTraceById(a.id)!.note).toBe('new\nbody one\nbody two');
        await run('note', { id: a.id, text: '0. whole\nnote' });
        expect(m.findTraceById(a.id)!.note).toBe('whole\nnote');
        await run('note', { id: a.id, text: '1.\nSecond line' }); // never pulls line 2 up into the title
        expect(m.findTraceById(a.id)!.note).toBe('\nSecond line');
        await expect(run('title', { id: a.id, text: '   ' })).rejects.toThrow(/Missing title/);
        await expect(run('title', { id: a.id, text: '3. ' })).rejects.toThrow(/Missing title/);
        expect(m.findTraceById(a.id)!.note).toBe('\nSecond line');
    });

    it('show --id returns one trace with its children', async () => {
        await run('create', { name: 'T', markdown: '## %%Tip%% one\n### two\n## three' });
        const one = m.getAll()[0];
        const res = await run('show', { id: one.id });
        expect(res).toMatchObject({ id: one.id, note: 'one', tag: 'Tip', children: [{ note: 'two' }] });
        m.createTree('Other');
        await run('show', { id: one.id }); // read-only: the user's active tree stays put
        expect(activeName()).toBe('Other');
        await expect(run('show', { id: one.id, tree: 'Other' })).rejects.toThrow(/not in tree "Other"/);
    });

    it('move reorders, reparents and rejects moving into a descendant', async () => {
        await run('create', { name: 'T', markdown: '## a\n### a1\n## b\n## c' });
        const [a, b, c] = m.getAll();
        const a1 = a.children![0];
        await run('move', { id: c.id, before: a.id });
        expect(m.getAll().map(t => t.note)).toEqual(['c', 'a', 'b']);
        await run('move', { id: b.id, parent: a.id });
        expect(m.findTraceById(a.id)!.children!.map(t => t.note)).toEqual(['a1', 'b']);
        await run('move', { id: a1.id, root: 'true' });
        expect(m.getAll().map(t => t.note)).toEqual(['c', 'a', 'a1']);
        await expect(run('move', { id: a.id, parent: b.id })).rejects.toThrow(/descendant/);
        await expect(run('move', { id: a.id })).rejects.toThrow(/exactly one/);
        expect(m.getParentGroupId(b.id)).toBe(a.id);
    });

    it('find searches titles, notes and code across trees without switching trees', async () => {
        const file = path.join(root, 'a.ts');
        await run('create', { name: 'One', markdown: '## Login entry\nchecks the PASSWORD hash\n### child' });
        const login = m.getAll()[0];
        m.createTree('Two');
        const t = codeCard('target fn', file);
        m.add(t);
        m.switchTree(m.getTreeList().find(x => x.name === 'One')!.id);

        const byNote = await run('find', { text: 'password' });
        expect(byNote.matches).toEqual([expect.objectContaining({ id: login.id, tree: 'One', title: 'Login entry', match: 'note: checks the PASSWORD hash' })]);
        expect(byNote.matches[0].children).toBeUndefined();
        const child = await run('find', { text: 'child' });
        expect(child.matches[0]).toMatchObject({ parent: login.id, match: 'note: child' });
        const byCode = await run('find', { text: 'return 42' });
        expect(byCode.matches).toEqual([expect.objectContaining({ id: t.id, tree: 'Two', match: `code: ${SNIPPET}` })]);
        expect((await run('find', { text: 'login', tree: 'Two' })).count).toBe(0);
        expect(activeName()).toBe('One');
        await expect(run('find', {})).rejects.toThrow(/Give search text/);
    });

    it('find --file matches the file, and with lines only overlapping traces', async () => {
        const file = path.join(root, 'a.ts');
        const t = codeCard('target fn', file); // line 2 (1-based)
        m.add(t);
        m.add(card('note only'));
        const ids = async (f: string, text?: string) => (await run('find', { file: f, text })).matches.map((x: any) => x.id);
        expect(await ids('a.ts')).toEqual([t.id]);
        expect(await ids(file)).toEqual([t.id]);
        expect(await ids('a.ts:2')).toEqual([t.id]);
        expect(await ids('a.ts:1-3')).toEqual([t.id]);
        expect(await ids('a.ts:3-9')).toEqual([]);
        expect(await ids('a.ts:1')).toEqual([]);
        expect(await ids('b.ts')).toEqual([]);
        expect(await ids('a.ts', 'target')).toEqual([t.id]);
        expect(await ids('a.ts', 'nope')).toEqual([]);
        await expect(run('find', { file: 'a.ts:5-2' })).rejects.toThrow(/Bad line range/);
    });

    it('find matches all words in any order, by tag, and under a folder', async () => {
        fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
        const inDir = codeCard('auth check', path.join(root, 'src', 'auth', 'x.ts'));
        const outside = codeCard('other', path.join(root, 'srcx.ts')); // shares the "src" prefix, not the folder
        await run('create', { name: 'T', markdown: '## %%Todo%% verify hash\nthe password is checked\n## %%Tip%% hash only' });
        [inDir, outside].forEach(t => m.add(t));
        const titles = async (args: Record<string, string>) => (await run('find', args)).matches.map((x: any) => x.title);

        expect(await titles({ text: 'password hash' })).toEqual(['verify hash']); // words split across lines
        expect((await run('find', { text: 'checked password' })).matches[0].match).toBe('note: the password is checked');
        expect(await titles({ text: 'password nope' })).toEqual([]);
        expect(await titles({ tag: 'todo' })).toEqual(['verify hash']);
        expect(await titles({ tag: 'Tip', text: 'hash' })).toEqual(['hash only']);
        await expect(run('find', { tag: 'Urgent' })).rejects.toThrow(/Unknown tag "Urgent". Tags: .*Todo/);
        expect(await titles({ file: 'src' })).toEqual(['auth check']);
        expect(await titles({ file: 'src/auth/' })).toEqual(['auth check']);
        await expect(run('find', { file: 'src:3' })).rejects.toThrow(/is a folder/);
    });

    it('find speaks the panel search syntax: phrases, OR, NOT and -word', async () => {
        await run('create', { name: 'T', markdown: '## bcrypt login\nhash the password\n## argon2 login\n## legacy md5 login' });
        const titles = async (text: string) => (await run('find', { text })).matches.map((x: any) => x.title);
        expect(await titles('"hash the"')).toEqual(['bcrypt login']);
        expect(await titles('"the hash"')).toEqual([]);
        expect(await titles('bcrypt OR argon2')).toEqual(['bcrypt login', 'argon2 login']);
        expect(await titles('login -legacy')).toEqual(['bcrypt login', 'argon2 login']);
        expect(await titles('login NOT (bcrypt OR argon2)')).toEqual(['legacy md5 login']);
        await expect(run('find', { text: '-login' })).rejects.toThrow(/nothing to look for/);
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

describe('syncAgentSkills()', () => {
    it('writes skills only for agents whose config dir exists, and refreshes stale ones', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-home-'));
        try {
            fs.mkdirSync(path.join(home, '.claude'));
            fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
            const skill = (dir: string) => path.join(home, dir, 'skills', 'tracenotes', 'SKILL.md');

            syncAgentSkills('/ext', home);
            const fresh = fs.readFileSync(skill('.claude'), 'utf8');
            expect(fresh).toContain('name: tracenotes');
            expect(fs.readFileSync(skill(path.join('.gemini', 'config')), 'utf8')).toBe(fresh);
            expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
            expect(fs.existsSync(path.join(home, '.cursor'))).toBe(false);

            fs.writeFileSync(skill('.claude'), 'old version');
            syncAgentSkills('/ext', home);
            expect(fs.readFileSync(skill('.claude'), 'utf8')).toBe(fresh);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
