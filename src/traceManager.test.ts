import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => import('./test/vscodeMock'));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri, Position, workspace, config, makeDoc } from './test/vscodeMock';
import { TraceManager } from './traceManager';
import { resolveProjectId } from './storage/projectId';
import { MAX_DEPTH, type TracePoint } from './types';

// ── Fixtures ─────────────────────────────────────────────────────

let tmp: string;
let managers: TraceManager[] = [];

/** One "folder" of the project: its own workspace root and per-folder storage. */
function makeContext(folder = 'ws') {
    const state = new Map<string, unknown>();
    return {
        subscriptions: [],
        globalStorageUri: Uri.file(path.join(tmp, 'global')),
        storageUri: Uri.file(path.join(tmp, `${folder}-storage`)),
        workspaceState: {
            get: (k: string) => state.get(k),
            update: async (k: string, v: unknown) => { state.set(k, v); },
        },
    } as any;
}

function openFolder(folder = 'ws') {
    const root = path.join(tmp, folder);
    fs.mkdirSync(root, { recursive: true });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: folder }];
    return root;
}

async function makeManager(ctx = makeContext()): Promise<TraceManager> {
    const m = new TraceManager(ctx);
    managers.push(m);
    await m.ensureReady();
    return m;
}

let seq = 0;
/** A file-less note card: validation never touches it, so tests stay deterministic. */
function note(name: string, extra: Partial<TracePoint> = {}): TracePoint {
    return {
        id: `${name}-${++seq}`, filePath: '', rangeOffset: [0, 0], lineRange: [0, 0],
        content: '', lang: 'plaintext', note: name, timestamp: 0, ...extra,
    };
}

const names = (list: TracePoint[]) => list.map(t => t.note);

/** traceIdMap / parentIdMap / traceIndex must mirror the active tree exactly after every mutation. */
function expectIndexConsistent(m: TraceManager) {
    const idMap: Map<string, TracePoint> = (m as any).traceIdMap;
    const parentMap: Map<string, string | null> = (m as any).parentIdMap;
    const fileIndex: Map<string, Set<TracePoint>> = (m as any).traceIndex;
    const expected = new Map<string, string | null>();
    const expectedFiles = new Map<string, Set<TracePoint>>();
    const walk = (list: TracePoint[], parent: string | null) => list.forEach(t => {
        expected.set(t.id, parent);
        expect(idMap.get(t.id)).toBe(t);
        const key = (m as any).fileIndexKey(t.filePath);
        if (!expectedFiles.has(key)) { expectedFiles.set(key, new Set()); }
        expectedFiles.get(key)!.add(t);
        walk(t.children ?? [], t.id);
    });
    walk(m.getAll(), null);
    expect(new Map(parentMap)).toEqual(expected);
    expect(new Set(idMap.keys())).toEqual(new Set(expected.keys()));
    expect(new Set(fileIndex.keys())).toEqual(new Set(expectedFiles.keys()));
    for (const [key, set] of expectedFiles) {
        expect([...fileIndex.get(key)!].every(t => set.has(t)) && fileIndex.get(key)!.size === set.size).toBe(true);
    }
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracenotes-test-'));
    config.projectId = 'test-project';
    openFolder();
});

afterEach(() => {
    managers.forEach(m => m.dispose());
    managers = [];
    workspace.textDocuments = [];
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── CRUD ─────────────────────────────────────────────────────────

describe('TraceManager CRUD', () => {
    it('adds, edits and reorders cards at the root', async () => {
        const m = await makeManager();
        const [a, b, c] = [note('a'), note('b'), note('c')];
        [a, b, c].forEach(t => m.add(t));
        expect(names(m.getAll())).toEqual(['a', 'b', 'c']);

        m.updateNote(b.id, 'b2');
        m.updateHighlight(b.id, 'red');
        expect(m.findTraceById(b.id)).toMatchObject({ note: 'b2', highlight: 'red' });

        m.reorder([c.id, a.id, b.id]);
        expect(names(m.getAll())).toEqual(['c', 'a', 'b2']);
        expectIndexConsistent(m);
    });

    it('addEmptyTrace adds a blank card and reports it via focusId', async () => {
        const m = await makeManager();
        const events: unknown[] = [];
        m.onDidChangeTraces(e => events.push(e));
        const id = m.addEmptyTrace();
        expect(m.findTraceById(id)).toMatchObject({ filePath: '', content: '', note: '' });
        expect(events).toContainEqual({ focusId: id });
        expectIndexConsistent(m);
    });

    it('remove drops the card with its subtree; undoRemove restores it in place', async () => {
        const m = await makeManager();
        const [a, b, c, child] = [note('a'), note('b'), note('c'), note('child')];
        [a, b, c].forEach(t => m.add(t));
        m.enterGroup(b.id);
        m.add(child);
        m.jumpToGroup(null);

        m.remove(b.id);
        expect(names(m.getAll())).toEqual(['a', 'c']);
        expect(m.findTraceById(child.id)).toBeUndefined();
        expectIndexConsistent(m);

        expect(m.undoRemove()).toBe(b.id);
        expect(names(m.getAll())).toEqual(['a', 'b', 'c']);
        expect(m.findTraceById(child.id)).toBeDefined();
        expectIndexConsistent(m);
        expect(m.undoRemove()).toBeNull();
    });

    it('removing the group you are inside returns the cursor to the root', async () => {
        const m = await makeManager();
        const g = note('g');
        m.add(g);
        m.enterGroup(g.id);
        m.remove(g.id);
        expect(m.getActiveGroupId()).toBeNull();
        expectIndexConsistent(m);
    });

    it('clear empties the active tree and every index', async () => {
        const m = await makeManager();
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const [g, child] = [note('g'), note('child', { filePath: file })];
        m.add(g);
        m.enterGroup(g.id);
        m.add(child);

        m.clear();
        expect(m.getAll()).toEqual([]);
        expect(m.getActiveGroupId()).toBeNull();
        expect(m.findTraceById(g.id)).toBeUndefined();
        expect(m.findTraceById(child.id)).toBeUndefined();
        expect(m.getTracesForFile(file)).toEqual([]);
        expectIndexConsistent(m);
    });

    it('undoRemove falls back to the tree root when the original parent is gone', async () => {
        const m = await makeManager();
        const [g, child] = [note('g'), note('child')];
        m.add(g);
        m.enterGroup(g.id);
        m.add(child);
        m.remove(child.id);
        m.clear(); // g is gone and has no undo entry of its own

        m.add(note('other'));
        expect(m.undoRemove()).toBe(child.id);
        expect(names(m.getAll())).toEqual(['other', 'child']);
        expect(m.getActiveGroupId()).toBeNull();
        expectIndexConsistent(m);
    });

    it('undoRemove switches back to the tree the card was removed from', async () => {
        const m = await makeManager();
        const first = m.getActiveTreeData()!.id;
        const a = note('a');
        m.add(a);
        m.remove(a.id);
        m.createTree('Second');

        expect(m.undoRemove()).toBe(a.id);
        expect(m.getActiveTreeData()!.id).toBe(first);
        expect(names(m.getAll())).toEqual(['a']);
        expectIndexConsistent(m);
    });

    it('undoRemove skips entries whose tree was deleted', async () => {
        const m = await makeManager();
        const first = m.getActiveTreeData()!.id;
        const a = note('a');
        m.add(a);
        m.remove(a.id);
        m.createTree('Second');
        m.deleteTree(first);

        expect(m.undoRemove()).toBeNull();
        expect(m.getActiveTreeData()!.name).toBe('Second');
        expect(m.getAll()).toEqual([]);
    });
});

// ── Groups & nesting ─────────────────────────────────────────────

describe('TraceManager groups', () => {
    it('adds into the entered group and tracks depth / breadcrumb', async () => {
        const m = await makeManager();
        const [a, b, inner] = [note('a'), note('b'), note('inner')];
        m.add(a);
        m.add(b);
        expect(m.enterGroup(b.id)).toBe(true);
        m.add(inner);

        expect(m.getActiveDepth()).toBe(1);
        expect(m.getActiveBreadcrumb()).toBe('2/');
        expect(names(m.getActiveChildren())).toEqual(['inner']);
        expect(m.getParentGroupId(inner.id)).toBe(b.id);

        expect(m.exitGroup()).toBeNull();
        expect(m.getActiveDepth()).toBe(0);
        expectIndexConsistent(m);
    });

    it('moveToChild nests at the top of the target; moveToParent puts it right after its old parent', async () => {
        const m = await makeManager();
        const [a, b, c, x] = [note('a'), note('b'), note('c'), note('x')];
        [a, b, c].forEach(t => m.add(t));
        m.enterGroup(a.id);
        m.add(x);
        m.jumpToGroup(null);

        m.moveToChild(c.id, a.id);
        expect(names(m.findTraceById(a.id)!.children!)).toEqual(['c', 'x']);
        expectIndexConsistent(m);

        m.moveToParent(c.id);
        expect(names(m.getAll())).toEqual(['a', 'c', 'b']);
        expectIndexConsistent(m);
    });

    it('refuses to move a card into its own descendant', async () => {
        const m = await makeManager();
        const [a, b] = [note('a'), note('b')];
        m.add(a);
        m.enterGroup(a.id);
        m.add(b);
        m.jumpToGroup(null);

        m.moveToChild(a.id, b.id);
        expect(m.getParentGroupId(b.id)).toBe(a.id);
        expect(names(m.getAll())).toEqual(['a']);
        expectIndexConsistent(m);
    });

    it(`caps nesting at MAX_DEPTH (${MAX_DEPTH})`, async () => {
        const m = await makeManager();
        const chain: TracePoint[] = [];
        for (let d = 0; d < MAX_DEPTH; d++) {
            const t = note(`d${d}`);
            m.add(t);
            chain.push(t);
            if (d < MAX_DEPTH - 1) { expect(m.enterGroup(t.id)).toBe(true); }
        }
        const deepest = chain[MAX_DEPTH - 1];
        expect(m.getActiveDepth()).toBe(MAX_DEPTH - 1);
        expect(m.enterGroup(deepest.id)).toBe(false);

        m.jumpToGroup(null);
        const loose = note('loose');
        m.add(loose);
        m.moveToChild(loose.id, deepest.id);
        expect(m.getParentGroupId(loose.id)).toBeNull();
        expectIndexConsistent(m);
    });

    it('importTraces nests parsed Markdown under a parent and enforces MAX_DEPTH', async () => {
        const m = await makeManager();
        const parent = note('parent');
        m.add(parent);
        const added = await m.importTraces('## A\n\n### B\n\n## C\n', parent.id);
        expect(names(added)).toEqual(['A', 'C']);
        expect(names(m.findTraceById(parent.id)!.children!)).toEqual(['A', 'C']);
        expect(names(added[0].children!)).toEqual(['B']);
        expectIndexConsistent(m);

        const [anchor, tail] = [added[0], added[1]];
        await m.importTraces('## Before\n', null, { id: anchor.id, after: false });
        await m.importTraces('## After\n', null, { id: anchor.id, after: true });
        expect(names(m.findTraceById(parent.id)!.children!)).toEqual(['Before', 'A', 'After', tail.note]);
        expectIndexConsistent(m);

        const tooDeep = Array.from({ length: MAX_DEPTH + 1 }, (_, d) => `${'#'.repeat(d + 2)} L${d}`).join('\n\n');
        await expect(m.importTraces(tooDeep, null)).rejects.toThrow(/maximum nesting depth/);
    });
});

// ── Trees ────────────────────────────────────────────────────────

describe('TraceManager trees', () => {
    it('createTree / switchTree keep each tree\'s cards separate', async () => {
        const m = await makeManager();
        const first = m.getActiveTreeData()!.id;
        m.add(note('in-first'));

        m.createTree('Second');
        expect(m.getActiveTreeData()!.name).toBe('Second');
        expect(m.getAll()).toEqual([]);
        m.add(note('in-second'));

        m.switchTree(first);
        expect(names(m.getAll())).toEqual(['in-first']);
        expect(m.getTreeList().map(t => t.name)).toEqual(['Default Trace', 'Second']);
        expectIndexConsistent(m);
    });

    it('deleting the last tree resets it to an empty default instead of removing it', async () => {
        const m = await makeManager();
        m.add(note('a'));
        m.deleteTree(m.getActiveTreeData()!.id);
        expect(m.getTreeList()).toHaveLength(1);
        expect(m.getActiveTreeData()!.name).toBe('Default Trace');
        expect(m.getAll()).toEqual([]);
        expectIndexConsistent(m);
    });

    it('importAllTrees gives a colliding tree a fresh id instead of overwriting', async () => {
        const m = await makeManager();
        const original = m.getActiveTreeData()!;
        m.add(note('mine'));
        const incoming = { id: original.id, name: 'Incoming', createdAt: 0, updatedAt: 0, traces: [note('theirs')] };

        await m.importAllTrees([incoming]);
        const list = m.getTreeList();
        expect(list).toHaveLength(2);
        expect(list[1].id).not.toBe(original.id);
        expect(m.getActiveTreeData()!.id).toBe(list[1].id);
        expect(names(m.getAll())).toEqual(['theirs']);
        m.switchTree(original.id);
        expect(names(m.getAll())).toEqual(['mine']);
        expectIndexConsistent(m);
    });

    it('deleting the active tree activates its left neighbour', async () => {
        const m = await makeManager();
        const first = m.getActiveTreeData()!.id;
        m.createTree('Second');
        m.deleteTree(m.getActiveTreeData()!.id);
        expect(m.getActiveTreeData()!.id).toBe(first);
        expectIndexConsistent(m);
    });
});

// ── Edits & anchoring ────────────────────────────────────────────

describe('TraceManager anchoring', () => {
    const CODE = 'const a = 1;\nfunction target() { return 42; }\nconst z = 2;\n';
    const SNIPPET = 'function target() { return 42; }';

    async function managerWithTrace(file: string) {
        const m = await makeManager();
        const start = CODE.indexOf(SNIPPET);
        const t = note('t', { filePath: file, rangeOffset: [start, start + SNIPPET.length], lineRange: [1, 1], content: SNIPPET });
        m.add(t);
        return { m, t, start };
    }

    it('shifts offsets and lines when text is inserted above the trace', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t, start } = await managerWithTrace(file);
        const inserted = '// header\n';
        m.handleTextDocumentChange({
            document: makeDoc(file, inserted + CODE, 2),
            contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: inserted }],
        } as any);
        expect(t.rangeOffset).toEqual([start + inserted.length, start + inserted.length + SNIPPET.length]);
        expect(t.lineRange).toEqual([2, 2]);
    });

    it('leaves the trace alone when text changes below it', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t, start } = await managerWithTrace(file);
        m.handleTextDocumentChange({
            document: makeDoc(file, CODE + 'extra\n', 2),
            contentChanges: [{ rangeOffset: CODE.length, rangeLength: 0, text: 'extra\n' }],
        } as any);
        expect(t.rangeOffset).toEqual([start, start + SNIPPET.length]);
    });

    it('applies several changes in one event: grows a trace edited inside, shifts the one after', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t, start } = await managerWithTrace(file);
        const first = note('first', { filePath: file, rangeOffset: [0, 12], lineRange: [0, 0], content: 'const a = 1;' });
        m.add(first);
        // Offsets are against the pre-edit text, as VS Code reports them.
        const zAt = CODE.indexOf('const z');
        const after = 'const abc = 1;\nY' + SNIPPET + '\n// x\nconst z = 2;\n';
        m.handleTextDocumentChange({
            document: makeDoc(file, after, 2),
            contentChanges: [
                { rangeOffset: 6, rangeLength: 1, text: 'abc' },  // inside `first`: +2
                { rangeOffset: zAt, rangeLength: 0, text: '// x\n' }, // below both
                { rangeOffset: start, rangeLength: 0, text: 'Y' },  // right at t's start: +1
            ],
        } as any);
        expect(first.rangeOffset).toEqual([0, 14]);
        expect(after.slice(...first.rangeOffset)).toBe('const abc = 1;');
        expect(t.rangeOffset).toEqual([start + 3, start + 3 + SNIPPET.length]);
        expect(after.slice(...t.rangeOffset)).toBe(SNIPPET);
        expect(t.lineRange).toEqual([1, 1]);
    });

    it('re-anchors a trace whose code moved, and orphans one whose code is gone', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t } = await managerWithTrace(file);

        const moved = '\n\n\n// lots of new lines\n' + CODE;
        await m.validateDocumentNow(makeDoc(file, moved, 2));
        expect(t.orphaned).toBeFalsy();
        expect(moved.slice(t.rangeOffset[0], t.rangeOffset[1])).toBe(SNIPPET);
        expect(t.lineRange).toEqual([5, 5]);

        await m.validateDocumentNow(makeDoc(file, 'nothing to see here\n', 3));
        expect(t.orphaned).toBe(true);
    });

    it('a delete crossing the trace start leaves offsets for validation; validation orphans it (too little left to fuzzy-match)', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t, start } = await managerWithTrace(file);
        const cut = start + 'function'.length; // deletes `const a = 1;\nfunction`
        const after = CODE.slice(cut);
        m.handleTextDocumentChange({
            document: makeDoc(file, after, 2),
            contentChanges: [{ rangeOffset: 0, rangeLength: cut, text: '' }],
        } as any);
        expect(t.rangeOffset).toEqual([start, start + SNIPPET.length]); // not shifted or shrunk blindly
        fs.writeFileSync(file, after);
        await m.validateDocumentNow(makeDoc(file, after, 2));
        expect(t.orphaned).toBe(true);
    });

    it('a delete swallowing the whole trace orphans it on validation', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const { m, t, start } = await managerWithTrace(file);
        const after = CODE.slice(0, start - 1) + CODE.slice(start + SNIPPET.length + 1);
        m.handleTextDocumentChange({
            document: makeDoc(file, after, 2),
            contentChanges: [{ rangeOffset: start - 1, rangeLength: SNIPPET.length + 2, text: '' }],
        } as any);
        fs.writeFileSync(file, after);
        await m.validateDocumentNow(makeDoc(file, after, 2));
        expect(t.orphaned).toBe(true);
    });

    it('getTracesForFile follows relocateTrace to the new file', async () => {
        const root = workspace.workspaceFolders![0].uri.fsPath;
        const [a, b] = [path.join(root, 'a.ts'), path.join(root, 'b.ts')];
        const { m, t } = await managerWithTrace(a);
        const doc = makeDoc(b, 'let moved = true;\n');
        m.relocateTrace(t.id, doc, { start: new Position(0, 0), end: new Position(0, 17) } as any);
        expect(m.getTracesForFile(a)).toEqual([]);
        expect(m.getTracesForFile(b)).toEqual([t]);
        expect(t).toMatchObject({ filePath: b, content: 'let moved = true;', rangeOffset: [0, 17] });
        expectIndexConsistent(m);

        // A file-less note card leaves the shared note bucket when it gets code attached.
        const n = note('n');
        m.add(n);
        m.relocateTrace(n.id, doc, { start: new Position(0, 0), end: new Position(0, 3) } as any);
        expect(m.getTracesForFile(b)).toEqual([t, n]);
        expectIndexConsistent(m);
    });
});

// ── Persistence ──────────────────────────────────────────────────

describe('TraceManager persistence', () => {
    it('round-trips trees, nesting and the tree/group cursor through disk', async () => {
        const ctx = makeContext();
        const m1 = await makeManager(ctx);
        const [a, b] = [note('a'), note('b')];
        m1.add(a);
        m1.enterGroup(a.id);
        m1.add(b);
        m1.createTree('Second');
        m1.add(note('s'));
        m1.switchTree(m1.getTreeList()[0].id);
        // switchTree kicks off validation without awaiting it; settle it so it can't race the save.
        await m1.validateActiveTreeBackground();
        m1.enterGroup(a.id);
        await m1.flush();

        const m2 = await makeManager(ctx); // same folder → simulates a window reload
        expect(m2.getAllTrees()).toEqual(m1.getAllTrees());
        expect(m2.getActiveTreeData()).toEqual(m1.getActiveTreeData());
        expect(m2.getActiveGroupId()).toBe(a.id);
        expectIndexConsistent(m2);
    });

    it('shares trees across folders of one project, with paths relative to each folder', async () => {
        const rootA = workspace.workspaceFolders![0].uri.fsPath;
        const m1 = await makeManager(makeContext('ws'));
        m1.add(note('t', { filePath: path.join(rootA, 'src', 'x.ts') }));
        await m1.flush();

        const rootB = openFolder('other-checkout');
        const m2 = await makeManager(makeContext('other-checkout'));
        expect(m2.getAll()[0].filePath).toBe(path.join(rootB, 'src', 'x.ts'));
    });

    it('falls back to the backup when the main file is corrupt', async () => {
        const ctx = makeContext();
        const m1 = await makeManager(ctx);
        m1.add(note('first'));
        await m1.flush();
        m1.add(note('second'));
        await m1.flush(); // rotates the 'first'-only file into the backup

        const dir = path.join(tmp, 'global', 'projects');
        const [hash] = fs.readdirSync(dir);
        fs.writeFileSync(path.join(dir, hash, 'tracenotes.data.json'), '{ not json');

        const m2 = await makeManager(ctx);
        expect(names(m2.getAll())).toEqual(['first']);
    });

    it('an edit shift rewrites only this folder\'s positions file, not the shared trees file', async () => {
        const file = path.join(workspace.workspaceFolders![0].uri.fsPath, 'a.ts');
        const m = await makeManager();
        const t = note('t', { filePath: file, rangeOffset: [0, 12], lineRange: [0, 0], content: 'const a = 1;' });
        m.add(t);
        await m.flush();
        const dir = path.join(tmp, 'global', 'projects');
        const dataFile = path.join(dir, fs.readdirSync(dir)[0], 'tracenotes.data.json');
        const sharedBefore = fs.readFileSync(dataFile, 'utf8');

        m.handleTextDocumentChange({
            document: makeDoc(file, '\nconst a = 1;\n', 2),
            contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: '\n' }],
        } as any);
        await m.flush();
        expect(fs.readFileSync(dataFile, 'utf8')).toBe(sharedBefore);
        const positions = fs.readFileSync(path.join(tmp, 'ws-storage', 'tracenotes.positions.json'), 'utf8');
        expect(positions).toContain(t.id);
        expect(positions).toMatch(/\[\s*1,\s*13\s*\]/);
    });

    it('flush writes nothing when nothing changed', async () => {
        const m = await makeManager();
        await m.flush();
        expect(fs.existsSync(path.join(tmp, 'global', 'projects'))).toBe(true); // dir is created on load
        const [hash] = fs.readdirSync(path.join(tmp, 'global', 'projects'));
        expect(fs.existsSync(path.join(tmp, 'global', 'projects', hash, 'tracenotes.data.json'))).toBe(false);
    });

    it('migrates a legacy flat array from workspaceState into a default tree, then clears it', async () => {
        const ctx = makeContext();
        await ctx.workspaceState.update('tracenotes.traces', [note('old')]);
        const m = await makeManager(ctx);
        expect(m.getActiveTreeData()!.name).toBe('Default Trace');
        expect(names(m.getAll())).toEqual(['old']);
        expect(ctx.workspaceState.get('tracenotes.traces')).toBeUndefined();
        expectIndexConsistent(m);

        const m2 = await makeManager(ctx); // now read back from the shared file
        expect(names(m2.getAll())).toEqual(['old']);
    });

    it('folds this folder\'s pre-sharing data file into the shared file and renames it .migrated', async () => {
        const legacyDir = path.join(tmp, 'ws-storage');
        fs.mkdirSync(legacyDir, { recursive: true });
        const legacy = [{ id: 'legacy', name: 'Legacy', createdAt: 0, updatedAt: 0, traces: [note('kept')] }];
        fs.writeFileSync(path.join(legacyDir, 'tracenotes.data.json'), JSON.stringify(legacy));

        const m = await makeManager();
        expect(m.getTreeList().map(t => t.name)).toContain('Legacy');
        expect(fs.existsSync(path.join(legacyDir, 'tracenotes.data.json'))).toBe(false);
        expect(fs.existsSync(path.join(legacyDir, 'tracenotes.data.json.migrated'))).toBe(true);

        const m2 = await makeManager(); // migration is one-time; the tree now comes from the shared file
        expect(m2.getTreeList().filter(t => t.name === 'Legacy')).toHaveLength(1);
    });

    async function twoProjects() {
        config.projectId = 'p2';
        const other = await makeManager(makeContext('p2-window'));
        other.add(note('theirs'));
        await other.flush();
        config.projectId = 'test-project';
        const m = await makeManager();
        m.add(note('mine'));
        config.projectId = 'p2';
        return m;
    }
    const allNames = (m: TraceManager) => m.getAllTrees().flatMap(t => names(t.traces));

    it('switchProject without merge loads only the new project\'s traces', async () => {
        const m = await twoProjects();
        await m.switchProject(false);
        expect(allNames(m)).toEqual(['theirs']);
        expectIndexConsistent(m);
    });

    it('switchProject with merge carries this window\'s traces into the new project and saves them', async () => {
        const m = await twoProjects();
        await m.switchProject(true);
        expect(allNames(m).sort()).toEqual(['mine', 'theirs']);
        expectIndexConsistent(m);
        const reloaded = await makeManager(makeContext('p2-window'));
        expect(allNames(reloaded).sort()).toEqual(['mine', 'theirs']);
    });

    it('reloadFromDisk picks up another window\'s save and keeps this window\'s group cursor', async () => {
        const m1 = await makeManager(makeContext('ws'));
        const group = note('group');
        m1.add(group);
        m1.enterGroup(group.id);
        await m1.flush();

        const m2 = await makeManager(makeContext('ws2'));
        m2.add(note('from-other-window'));
        await m2.flush();

        await (m1 as any).reloadFromDisk();
        expect(names(m1.getAllTrees()[0].traces)).toEqual(['group', 'from-other-window']);
        expect(m1.getActiveGroupId()).toBe(group.id);
        expectIndexConsistent(m1);
    });

    it('reloadFromDisk does not drop this window\'s unsaved changes', async () => {
        const m1 = await makeManager(makeContext('ws'));
        const m2 = await makeManager(makeContext('ws2'));
        m2.add(note('theirs'));
        await m2.flush();
        m1.add(note('mine')); // dirty, save still debounced

        await (m1 as any).reloadFromDisk();
        expect(names(m1.getAll())).toEqual(['mine']);
    });

    it('reads the git origin through a worktree\'s .git file and commondir', async () => {
        delete config.projectId;
        const main = path.join(tmp, 'main', '.git');
        const wtGit = path.join(main, 'worktrees', 'wt');
        fs.mkdirSync(wtGit, { recursive: true });
        fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
        fs.writeFileSync(path.join(main, 'config'), '[remote "origin"]\n\turl = git@github.com:me/proj.git\n');
        const root = workspace.workspaceFolders![0].uri.fsPath;
        fs.writeFileSync(path.join(root, '.git'), `gitdir: ${wtGit}\n`);
        expect(await resolveProjectId(Uri.file(root) as any)).toEqual({ id: 'github.com/me/proj', source: 'git origin' });

        // Submodule: the gitdir holds config itself, no commondir.
        const sub = path.join(tmp, 'super', '.git', 'modules', 'sub');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, 'config'), '[remote "origin"]\n\turl = https://github.com/me/sub.git\n');
        fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.relative(root, sub)}\n`);
        expect(await resolveProjectId(Uri.file(root) as any)).toEqual({ id: 'github.com/me/sub', source: 'git origin' });
    });
});
