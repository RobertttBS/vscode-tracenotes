import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { TraceManager } from '../traceManager';
import { HIGHLIGHT_TO_TAG, MAX_DEPTH, TracePoint, TraceTree } from '../types';
import { SearchNode, collectHighlightTargets, matchTrace as matchQuery, parseQuery } from '../webview/utils/search';
import { colorCommand } from './colors';
import { GUIDE } from './guide';
import { BIN_DIR, RUN_DIR, SHIM_PATH, WindowEntry, entryFile, removeEntry, shimPath, sweepStale, writeAtomic } from './registry';

/**
 * Lets external AI agents (Claude Code, Codex, Cursor, …) edit trace trees through the
 * `~/.tracenotes/bin/tracenotes` CLI. Each window listens on its own local
 * socket and registers it in `~/.tracenotes/run/`; the CLI picks the window by cwd.
 * Every mutation goes through TraceManager.
 */
export function startBridge(context: vscode.ExtensionContext, traceManager: TraceManager): void {
    const host = editorHost();
    // Registered first: the command must exist even if the socket setup fails.
    context.subscriptions.push(vscode.commands.registerCommand('tracenotes.setupAgents', () => setupAgents(context.extensionPath)));
    try {
        fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
        sweepStale();
        installShim(context.extensionPath, SHIM_PATH);
        installShim(context.extensionPath, shimPath(host), host);
    } catch (err) {
        console.error('TraceNotes: AI bridge setup failed', err);
        return;
    }

    const token = crypto.randomBytes(16).toString('hex');
    const socket = process.platform === 'win32'
        ? `\\\\.\\pipe\\tracenotes-${process.pid}-${token.slice(0, 8)}`
        : path.join(RUN_DIR, `${process.pid}.sock`);
    const entry = (): WindowEntry => ({
        pid: process.pid,
        socket,
        token,
        folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
        host,
    });
    const register = () => writeAtomic(entryFile(process.pid), JSON.stringify(entry()), 0o600);

    if (process.platform !== 'win32') { fs.rmSync(socket, { force: true }); }
    const server = net.createServer(conn => serve(conn, token, traceManager));
    server.on('error', err => console.error('TraceNotes: AI bridge server error', err));
    server.listen(socket, register);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(register),
        { dispose: () => { server.close(); removeEntry(entry()); } },
    );
    syncAgentSkills(context.extensionPath);
}

// Requests run one at a time: handlers switch the active tree and await file reads.
let queue: Promise<unknown> = Promise.resolve();

/** One request per connection: a JSON line in, a JSON line out. */
function serve(conn: net.Socket, token: string, tm: TraceManager): void {
    let buf = '';
    let handled = false;
    conn.setEncoding('utf8');
    conn.on('error', () => { /* client went away */ });
    conn.on('data', chunk => {
        if (handled) { return; }
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) { return; }
        handled = true;
        const reply = (body: object) => conn.end(JSON.stringify(body) + '\n');
        let req: { token?: string; op?: string; args?: Record<string, string | undefined> };
        try { req = JSON.parse(buf.slice(0, nl)); } catch { return reply({ ok: false, error: 'Malformed request.' }); }
        if (req.token !== token) { return reply({ ok: false, error: 'Bad token.' }); }
        const run = queue.then(() => handle(tm, req.op ?? '', req.args ?? {}));
        queue = run.catch(() => { /* reported below */ });
        run.then(
            result => reply({ ok: true, result }),
            err => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
    });
}

/** Exported for tests. */
export async function handle(tm: TraceManager, op: string, a: Record<string, string | undefined>): Promise<unknown> {
    await tm.ensureReady();
    switch (op) {
        case 'list':
            return tm.getTreeList();
        case 'show': {
            if (a.id) {
                // Read-only: look the trace up without switching the user's active tree.
                const hit = locate(tm, a.id);
                if (!hit) { throw new Error(`No trace with id ${a.id}.`); }
                if (a.tree && findTree(tm, a.tree).id !== hit.tree.id) { throw new Error(`Trace ${a.id} is not in tree "${a.tree}".`); }
                return describeTrace(hit.trace);
            }
            const tree = treeOrActive(tm, a.tree);
            if (!tree) { throw new Error('No active trace tree.'); }
            return { workspace: workspaceRoots(), ...describeTree(tree) };
        }
        case 'find': {
            // Read-only, across every tree (or --tree): never switches the user's active tree.
            // The panel's search syntax and fields (note + code), so both find the same cards.
            const query = a.text?.trim() ? parseQuery(a.text) : null;
            if (a.text?.trim() && !query) { throw new Error(`"${a.text}" has nothing to look for: give at least one word that isn't negated.`); }
            const file = a.file ? parseFileRef(a.file) : undefined;
            const tag = a.tag ? parseTag(a.tag) : undefined;
            if (!query && !file && !tag) { throw new Error('Give search text, --file <path>[:<line>[-<line>]], --tag <tag>, or a mix.'); }
            const trees = a.tree ? [findTree(tm, a.tree)] : tm.getTreesReadonly();
            const matches: object[] = [];
            const visit = (tree: TraceTree, list: TracePoint[], parent: string | undefined) => {
                for (const t of list) {
                    const hit = (!tag || tagOf(t) === tag) && matchTrace(t, query, file);
                    if (hit) {
                        const { children: _, ...b } = brief(t) as { children?: unknown };
                        matches.push({ tree: tree.name, parent, ...b, match: hit === true ? undefined : hit });
                    }
                    visit(tree, t.children ?? [], t.id);
                }
            };
            trees.forEach(tree => visit(tree, tree.traces, undefined));
            const LIMIT = 50;
            return {
                count: matches.length,
                matches: matches.slice(0, LIMIT),
                truncated: matches.length > LIMIT ? `Showing the first ${LIMIT}; narrow the search with --tree, --file, --tag or more words.` : undefined,
            };
        }
        case 'create': {
            await tm.importTraceTree(need(a.markdown, 'markdown'), need(a.name, '--name'));
            const tree = treeOrActive(tm)!;
            return withWarnings({ id: tree.id, name: tree.name, workspace: workspaceRoots(), traces: tree.traces.map(brief) }, tree.traces);
        }
        case 'add': {
            const sibling = a.after ?? a.before;
            if ([a.parent, a.after, a.before].filter(Boolean).length > 1) { throw new Error('Use only one of --parent, --after, --before.'); }
            const anchor = a.parent ?? sibling;
            // Resolve the target read-only first, so --dry-run rejects what a real add would.
            const named = a.tree ? findTree(tm, a.tree) : undefined;
            let target: TraceTree | undefined;
            let baseDepth = 0;
            if (anchor) {
                const hit = locate(tm, anchor);
                if (!hit) { throw new Error(`No trace with id ${anchor}.`); }
                if (named && named.id !== hit.tree.id) { throw new Error(`Trace ${anchor} is not in tree "${a.tree}".`); }
                target = hit.tree;
                baseDepth = a.parent ? hit.depth + 1 : hit.depth;
            } else {
                target = named ?? treeOrActive(tm);
                if (!target) { throw new Error('No active trace tree.'); }
            }
            if (a.dryRun) {
                // Same parsing and file reads as a real add; nothing is inserted.
                const parsed = await tm.previewTraces(need(a.markdown, 'markdown'));
                if (baseDepth + height(parsed) > MAX_DEPTH) { throw new Error(`Traces would exceed the maximum nesting depth of ${MAX_DEPTH}.`); }
                return withWarnings({ dryRun: true, workspace: workspaceRoots(), wouldAdd: parsed.map(brief) }, parsed);
            }
            activate(tm, target);
            const added = await tm.importTraces(need(a.markdown, 'markdown'), a.parent ?? null,
                sibling ? { id: sibling, after: !!a.after } : undefined);
            return withWarnings({ workspace: workspaceRoots(), added: added.map(brief) }, added);
        }
        case 'check': {
            const tree = treeOrActive(tm, a.tree);
            if (!tree) { throw new Error('No active trace tree.'); }
            activate(tm, tree);
            const before = new Map<string, string>();
            const remember = (list: TracePoint[]) => list.forEach(t => { if (t.lineRange) { before.set(t.id, lineSpan(t.lineRange)); } remember(t.children ?? []); });
            remember(tree.traces);
            await tm.validateActiveTreeBackground(); // re-anchor after outside edits
            const fresh = tm.getTreesReadonly().find(t => t.id === tree.id) ?? tree; // re-read after validation; a disk reload may have swapped it
            const { warnings } = await withWarnings({}, fresh.traces, before);
            return { tree: tree.name, warnings: warnings ?? [] };
        }
        case 'refresh': {
            const list = ids(a.id);
            if (a.lines && list.length > 1) { throw new Error('--lines takes a single trace id.'); }
            // Check every id before changing any, like `rm`.
            const plan: [string, vscode.TextDocument, vscode.Selection][] = [];
            const validated = new Set<string>();
            for (const id of list) {
                focusTreeOf(tm, id);
                const treeId = tm.getActiveTreeData()!.id;
                if (!a.lines && !validated.has(treeId)) { await tm.validateActiveTreeBackground(); validated.add(treeId); } // current lines, not stale ones
                const t = tm.findTraceById(id)!;
                if (!t.filePath) { throw new Error(`Trace ${id} has no code.`); }
                const doc = await vscode.workspace.openTextDocument(t.filePath);
                const m = a.lines?.match(/^(\d+):(\d+)$/);
                if (a.lines && !m) { throw new Error('--lines must be <startLine>:<endLine>.'); }
                if (!m && t.orphaned) { throw new Error(`Trace ${id} is orphaned; pass --lines <startLine>:<endLine>.`); }
                const [start, end] = m ? [+m[1] - 1, +m[2] - 1] : t.lineRange!;
                if (start < 0 || end < start || end >= doc.lineCount) { throw new Error(`Lines ${start + 1}:${end + 1} are outside ${t.filePath} (${doc.lineCount} lines).`); }
                plan.push([id, doc, new vscode.Selection(start, 0, end, doc.lineAt(end).text.length)]);
            }
            const done: TracePoint[] = [];
            for (const [id, doc, sel] of plan) {
                focusTreeOf(tm, id);
                tm.relocateTrace(id, doc, sel);
                done.push(tm.findTraceById(id)!);
            }
            return { refreshed: done.map(t => brief({ ...t, children: undefined })) };
        }
        case 'note': {
            const id = need(a.id, 'trace id');
            focusTreeOf(tm, id);
            if (a.text === undefined) { throw new Error('Missing note text.'); } // "" clears the note
            tm.updateNote(id, stripNumber(a.text));
            return brief(tm.findTraceById(id)!);
        }
        case 'title': {
            const id = need(a.id, 'trace id');
            focusTreeOf(tm, id);
            const title = need(stripNumber((a.text ?? '').split('\n')[0]).trim(), 'title');
            const t = tm.findTraceById(id)!;
            const body = t.note.split('\n').slice(1);
            tm.updateNote(id, [title, ...body].join('\n'));
            return brief(t);
        }
        case 'move': {
            const id = need(a.id, 'trace id');
            const dests = [a.parent, a.after, a.before, a.root].filter(Boolean);
            if (dests.length !== 1) { throw new Error('move needs exactly one of --parent <id>, --after <id>, --before <id>, --root.'); }
            focusTreeOf(tm, id);
            const anchor = a.parent ?? a.after ?? a.before;
            if (anchor && !tm.findTraceById(anchor)) { throw new Error(`Trace ${anchor} is not in the same tree as ${id}.`); }
            const sibling = a.after ?? a.before;
            tm.moveTrace(id, sibling ? { beside: sibling, after: !!a.after } : { parentId: a.parent ?? null });
            return { moved: id, parent: tm.getParentGroupId(id) ?? null };
        }
        case 'rm': {
            const list = ids(a.id);
            list.forEach(id => focusTreeOf(tm, id)); // fail before removing anything
            const removed: string[] = [];
            for (const id of list) {
                try { focusTreeOf(tm, id); } catch { continue; } // already gone with an earlier id's subtree
                tm.remove(id);
                removed.push(id);
            }
            return { removed };
        }
        case 'rename': {
            const tree = treeOrActive(tm, a.tree);
            if (!tree) { throw new Error('No active trace tree.'); }
            activate(tm, tree);
            tm.renameActiveTree(need(a.name, 'new name'));
            return tm.getActiveTreeData();
        }
        case 'delete-tree': {
            const tree = findTree(tm, need(a.tree, '--tree'));
            tm.deleteTree(tree.id);
            return { deleted: tree.id, name: tree.name };
        }
        case 'color':
            return colorCommand(a);
        default:
            throw new Error(`Unknown command "${op}".`);
    }
}

/** Several trace ids arrive space-separated in one argument. */
function ids(v: string | undefined): string[] {
    return need(v, 'trace id').split(/\s+/).filter(Boolean);
}

/** Drop a leading "<n>. " from a title line, as `add` does for headings: the panel numbers cards itself. */
function stripNumber(note: string): string {
    // Horizontal whitespace only: never eat the newline and promote line 2 to the title.
    return note.replace(/^\d+\.(?:[ \t]+|(?=\r?\n|$))/, '');
}

/** Where a trace lives, found without switching trees (unlike focusTreeOf). Depth 0 = tree root. */
function locate(tm: TraceManager, id: string): { tree: TraceTree; trace: TracePoint; depth: number } | undefined {
    const find = (list: TracePoint[], depth: number): { trace: TracePoint; depth: number } | undefined => {
        for (const t of list) {
            if (t.id === id) { return { trace: t, depth }; }
            const hit = find(t.children ?? [], depth + 1);
            if (hit) { return hit; }
        }
        return undefined;
    };
    for (const tree of tm.getTreesReadonly()) {
        const hit = find(tree.traces, 0);
        if (hit) { return { tree, ...hit }; }
    }
    return undefined;
}

/** `paths` are files, or folder prefixes (ending in a separator) when `dir`. */
interface FileRef { paths: string[]; dir: boolean; lines?: [number, number] }

/** `path`, `path:40` or `path:40-52` (1-based), or a folder; relative to a workspace root or absolute. */
function parseFileRef(ref: string): FileRef {
    const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(ref);
    const p = m ? m[1] : ref;
    let lines: [number, number] | undefined;
    if (m) {
        const [s, e] = [Number(m[2]), Number(m[3] ?? m[2])];
        if (s < 1 || e < s) { throw new Error(`Bad line range in "${ref}": use <line> or <start>-<end>, 1-based.`); }
        lines = [s - 1, e - 1];
    }
    const paths = path.isAbsolute(p) ? [p] : workspaceRoots().map(r => path.join(r, p));
    const isDir = (q: string) => { try { return fs.statSync(q).isDirectory(); } catch { return false; } };
    const dir = /[\\/]$/.test(p) || p === '.' || paths.some(isDir);
    if (dir && lines) { throw new Error(`"${p}" is a folder; line numbers only work with a file.`); }
    return { paths: paths.map(q => dir ? path.join(samePath(q), path.sep) : samePath(q)), dir, lines };
}

/** A colour tag name, case-insensitive, as the canonical spelling. */
function parseTag(ref: string): string {
    const name = ref.replace(/^%%|%%$/g, '');
    const all = Object.values(HIGHLIGHT_TO_TAG);
    const tag = all.find(x => x.toLowerCase() === name.toLowerCase());
    if (!tag) { throw new Error(`Unknown tag "${ref}". Tags: ${all.join(', ')}.`); }
    return tag;
}

/** Normalized for comparison; Windows paths are case-insensitive. */
function samePath(p: string): string {
    const n = path.normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * Whether a trace matches: false, true (nothing to show), or the line holding the
 * most search words, prefixed by where it was found ("note: …" / "code: …").
 */
function matchTrace(t: TracePoint, query: SearchNode | null, file: FileRef | undefined): string | boolean {
    if (file) {
        const p = t.filePath ? samePath(t.filePath) : undefined;
        if (!p || !(file.dir ? file.paths.some(d => p.startsWith(d)) : file.paths.includes(p))) { return false; }
        if (file.lines && (!t.lineRange || t.lineRange[1] < file.lines[0] || t.lineRange[0] > file.lines[1])) { return false; }
    }
    if (!query) { return true; }
    if (!matchQuery(query, `${t.note ?? ''}\n${t.content ?? ''}`)) { return false; }
    const words = collectHighlightTargets(query).map(w => w.toLowerCase());
    let best = { score: 0, text: '' };
    for (const [where, body] of [['note', t.note], ['code', t.content]] as const) {
        for (const line of body.split('\n')) {
            const score = words.filter(w => line.toLowerCase().includes(w)).length;
            if (score > best.score) {
                const s = line.trim();
                best = { score, text: `${where}: ${s.length > 80 ? s.slice(0, 77) + '...' : s}` };
            }
        }
    }
    return best.text || true;
}

function height(list: TracePoint[]): number {
    return list.reduce((h, t) => Math.max(h, 1 + height(t.children ?? [])), 0);
}

function lineSpan(r: [number, number]): string {
    return `${r[0] + 1}-${r[1] + 1}`;
}

/** Folders the CLI's relative paths resolve against. */
function workspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

function need(v: string | undefined, what: string): string {
    if (v === undefined || v === '') { throw new Error(`Missing ${what}.`); }
    return v;
}

function findTree(tm: TraceManager, ref: string): TraceTree {
    const trees = tm.getTreesReadonly();
    const tree = trees.find(t => t.id === ref) ?? trees.find(t => t.name === ref);
    if (!tree) { throw new Error(`No trace tree "${ref}".`); }
    return tree;
}

/** The tree named by `ref` (id or name), else the active tree. */
function treeOrActive(tm: TraceManager, ref?: string): TraceTree | undefined {
    if (ref) { return findTree(tm, ref); }
    const id = tm.getActiveTreeData()?.id;
    return tm.getTreesReadonly().find(t => t.id === id);
}

function activate(tm: TraceManager, tree: TraceTree): void {
    if (tm.getActiveTreeData()?.id !== tree.id) { tm.switchTree(tree.id); }
}

/** TraceManager's id lookups only cover the active tree, so switch to the tree holding `id`. */
function focusTreeOf(tm: TraceManager, id: string): void {
    const has = (list: TracePoint[]): boolean => list.some(t => t.id === id || has(t.children ?? []));
    const tree = tm.getTreesReadonly().find(t => has(t.traces));
    if (!tree) { throw new Error(`No trace with id ${id}.`); }
    activate(tm, tree);
}

/** Flags traces whose code doesn't match the file where they were anchored (stale or miscopied). */
async function withWarnings<T extends object>(result: T, traces: TracePoint[], before?: Map<string, string>): Promise<T & { warnings?: string[] }> {
    const warnings: string[] = [];
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const visit = async (t: TracePoint): Promise<void> => {
        if (t.filePath) {
            const where = `${t.id} (${vscode.workspace.asRelativePath(t.filePath, false)})`;
            if (t.orphaned) {
                warnings.push(`${where}: code not found in the file; the trace is orphaned. Run \`tracenotes refresh ${t.id} --lines <start>:<end>\`.`);
            } else {
                try {
                    const doc = await vscode.workspace.openTextDocument(t.filePath);
                    const text = doc.getText(new vscode.Range(doc.positionAt(t.rangeOffset[0]), doc.positionAt(t.rangeOffset[1])));
                    if (norm(text) !== norm(t.content)) {
                        const now = lineSpan(t.lineRange!);
                        const was = before?.get(t.id);
                        const match = was && was !== now ? `re-anchored from lines ${was} to the closest match at ${now}` : `closest match is lines ${now}`;
                        warnings.push(`${where}: code differs from the file (stale or miscopied); ${match}, which now starts "${preview(text)}". To accept lines ${now}, run \`tracenotes refresh ${t.id}\`; otherwise add --lines <start>:<end>.`);
                    }
                } catch {
                    warnings.push(`${where}: the file can't be read (deleted or moved?). Run \`tracenotes refresh ${t.id} --lines <start>:<end>\` once it's back, or rm the trace.`);
                }
            }
        }
        for (const c of t.children ?? []) { await visit(c); }
    };
    for (const t of traces) { await visit(t); }
    // Warnings first, so an agent that truncates long output still sees them.
    return warnings.length ? { warnings, ...result } : result;
}

function describeTree(tree: TraceTree) {
    return { id: tree.id, name: tree.name, traces: tree.traces.map(describeTrace) };
}

/** Compact form for mutation replies: id, title, location. `show` has the full notes. */
function brief(t: TracePoint): object {
    return {
        id: t.id,
        title: t.note.split('\n')[0],
        at: t.filePath && t.lineRange ? `${vscode.workspace.asRelativePath(t.filePath, false)}:${t.lineRange[0] + 1}-${t.lineRange[1] + 1}` : undefined,
        tag: tagOf(t),
        code: t.filePath ? preview(t.content) : undefined, // first line actually read: catches off-by-one line numbers
        orphaned: t.orphaned || undefined,
        children: t.children?.length ? t.children.map(brief) : undefined,
    };
}

function tagOf(t: TracePoint): string | undefined {
    return t.highlight ? HIGHLIGHT_TO_TAG[t.highlight] : undefined;
}

/** First non-blank line of some code, trimmed and cut to fit one line. */
function preview(code: string): string {
    const line = code.split('\n').find(l => l.trim())?.trim() ?? '';
    return line.length > 60 ? line.slice(0, 57) + '...' : line;
}

// Code content is omitted: agents can read the file at `file`/`lines` themselves.
function describeTrace(t: TracePoint): object {
    return {
        id: t.id,
        note: t.note,
        file: t.filePath ? vscode.workspace.asRelativePath(t.filePath, false) : undefined,
        lines: t.filePath && t.lineRange ? `${t.lineRange[0] + 1}-${t.lineRange[1] + 1}` : undefined,
        tag: tagOf(t),
        orphaned: t.orphaned || undefined,
        children: t.children?.length ? t.children.map(describeTrace) : undefined,
    };
}

/** `code` for VS Code, else the editor's URI scheme (`cursor`, `vscode-insiders`, …). */
function editorHost(): string {
    return vscode.env.uriScheme === 'vscode' ? 'code' : vscode.env.uriScheme;
}

/**
 * Stable entry points for agents. Rewritten on every activation so they follow
 * extension updates; run the CLI with this editor's own Electron as Node.
 * The generic `tracenotes` (no host) belongs to whichever editor started last;
 * `tracenotes-<host>` only talks to that editor's windows.
 */
function installShim(extensionPath: string, file: string, host?: string): void {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const cli = path.join(extensionPath, 'dist', 'cli.js');
    const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    // setlocal: keep the variables out of the caller's cmd session.
    const content = process.platform === 'win32'
        ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\nset TRACENOTES_HOST=${host ?? ''}\r\n"${process.execPath}" "${cli}" %*\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 TRACENOTES_HOST=${host ?? ''} exec ${sh(process.execPath)} ${sh(cli)} "$@"\n`;
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* first install */ }
    if (current !== content) { writeAtomic(file, content, 0o755); }
}

interface AgentTarget { name: string; file: string; write: () => void }

function skillMd(shim: string, editor: string): string {
    return `---
name: tracenotes
description: Create or edit TraceNotes trace trees (hierarchical code-reading notes shown in the user's ${editor} TraceNotes panel). Use when the user asks to build a trace tree, trace a code flow into TraceNotes, or add/edit/remove trace notes, or change the TraceNotes panel's colours.
---

Use the TraceNotes CLI at \`${shim}\` (below: \`tracenotes\`).
The project must be open in a ${editor} window with the TraceNotes extension.

${GUIDE}
`;
}

function writeIfChanged(file: string, text: string): void {
    try { if (fs.readFileSync(file, 'utf8') === text) { return; } } catch { /* not written yet */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/**
 * Agents whose config dir exists; each reads skills from <dir>/skills/<name>/SKILL.md.
 * Cursor's agent lives in Cursor, so it gets the Cursor-only launcher; Claude Code,
 * Codex and Antigravity get the generic one. Antigravity's IDE agent and its `agy` CLI
 * share one global root, ~/.gemini/config/, and the CLI runs beside any editor.
 */
function agentTargets(extensionPath: string, home = os.homedir()): AgentTarget[] {
    const skills = {
        generic: skillMd(SHIM_PATH, 'VS Code / Antigravity'),
        cursor: skillMd(shimPath('cursor'), 'Cursor'),
    };
    return ([['Claude Code', '.claude', 'generic'], ['Codex', '.codex', 'generic'], ['Cursor', '.cursor', 'cursor'],
        ['Antigravity', path.join('.gemini', 'config'), 'generic']] as const)
        .filter(([, dir]) => fs.existsSync(path.join(home, dir)))
        .map(([name, dir, skill]) => {
            const file = path.join(home, dir, 'skills', 'tracenotes', 'SKILL.md');
            const write = () => {
                writeIfChanged(file, skills[skill]);
                // Until Cursor runs TraceNotes itself, a stand-in so its skill gets the CLI's
                // "no Cursor window" error instead of "not found". Cursor's own copy replaces it.
                const cursorShim = shimPath('cursor');
                if (skill === 'cursor' && !fs.existsSync(cursorShim)) { installShim(extensionPath, cursorShim, 'cursor'); }
            };
            return { name, file, write };
        });
}

function setupAgents(extensionPath: string): void {
    const targets = agentTargets(extensionPath);
    if (!targets.length) {
        vscode.window.showInformationMessage(
            `TraceNotes: No Claude Code, Codex, Cursor or Antigravity config found. Tell your agent to run "${SHIM_PATH} help".`);
        return;
    }
    try {
        targets.forEach(t => t.write());
        vscode.window.showInformationMessage(`TraceNotes: Set up ${targets.map(t => t.name).join(', ')} (${targets.map(t => t.file).join(', ')}).`);
    } catch (err) {
        vscode.window.showErrorMessage(`TraceNotes: Agent setup failed. ${err}`);
    }
}

/** On every start, install or refresh the skill for each agent whose config dir exists. */
export function syncAgentSkills(extensionPath: string, home?: string): void {
    for (const t of agentTargets(extensionPath, home)) {
        try { t.write(); } catch (err) { console.error(`TraceNotes: syncing ${t.name} skill failed`, err); }
    }
}
