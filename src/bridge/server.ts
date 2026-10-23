import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { TraceManager } from '../traceManager';
import { TracePoint, TraceTree } from '../types';
import { GUIDE } from './guide';
import { BIN_DIR, RUN_DIR, SHIM_PATH, WindowEntry, entryFile, removeEntry, sweepStale, writeAtomic } from './registry';

/**
 * Lets external AI agents (Claude Code, Codex, Cursor, …) edit trace trees through the
 * `~/.tracenotes/bin/tracenotes` CLI. Each window listens on its own local
 * socket and registers it in `~/.tracenotes/run/`; the CLI picks the window by cwd.
 * Every mutation goes through TraceManager.
 */
export function startBridge(context: vscode.ExtensionContext, traceManager: TraceManager): void {
    // Registered first: the command must exist even if the socket setup fails.
    context.subscriptions.push(vscode.commands.registerCommand('tracenotes.setupAgents', setupAgents));
    try {
        fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
        sweepStale();
        installShim(context.extensionPath);
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
    offerSetupOnce(context);
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
            const tree = treeOrActive(tm, a.tree);
            if (!tree) { throw new Error('No active trace tree.'); }
            return describeTree(tree);
        }
        case 'create': {
            await tm.importTraceTree(need(a.markdown, 'markdown'), need(a.name, '--name'));
            const tree = treeOrActive(tm)!;
            return withWarnings({ id: tree.id, name: tree.name, traces: tree.traces.map(brief) }, tree.traces);
        }
        case 'add': {
            const sibling = a.after ?? a.before;
            if ([a.parent, a.after, a.before].filter(Boolean).length > 1) { throw new Error('Use only one of --parent, --after, --before.'); }
            const anchor = a.parent ?? sibling;
            if (anchor) {
                focusTreeOf(tm, anchor);
                if (a.tree && findTree(tm, a.tree).id !== tm.getActiveTreeData()?.id) { throw new Error(`Trace ${anchor} is not in tree "${a.tree}".`); }
            } else if (a.tree) { activate(tm, findTree(tm, a.tree)); }
            const added = await tm.importTraces(need(a.markdown, 'markdown'), a.parent ?? null,
                sibling ? { id: sibling, after: !!a.after } : undefined);
            return withWarnings({ added: added.map(brief) }, added);
        }
        case 'check': {
            const tree = treeOrActive(tm, a.tree);
            if (!tree) { throw new Error('No active trace tree.'); }
            activate(tm, tree);
            await tm.validateActiveTreeBackground(); // re-anchor after outside edits
            const fresh = tm.getTreesReadonly().find(t => t.id === tree.id) ?? tree; // re-read after validation; a disk reload may have swapped it
            const { warnings } = await withWarnings({}, fresh.traces);
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
            tm.updateNote(id, a.text);
            return brief(tm.findTraceById(id)!);
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
        default:
            throw new Error(`Unknown command "${op}".`);
    }
}

/** Several trace ids arrive space-separated in one argument. */
function ids(v: string | undefined): string[] {
    return need(v, 'trace id').split(/\s+/).filter(Boolean);
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
async function withWarnings<T extends object>(result: T, traces: TracePoint[]): Promise<T & { warnings?: string[] }> {
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
                        warnings.push(`${where}: code differs from the file at lines ${t.lineRange![0] + 1}-${t.lineRange![1] + 1} (stale or miscopied); anchored to the closest match. Run \`tracenotes refresh ${t.id}\` to re-read these lines, or add --lines <start>:<end>.`);
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
        orphaned: t.orphaned || undefined,
        children: t.children?.length ? t.children.map(brief) : undefined,
    };
}

// Code content is omitted: agents can read the file at `file`/`lines` themselves.
function describeTrace(t: TracePoint): object {
    return {
        id: t.id,
        note: t.note,
        file: t.filePath ? vscode.workspace.asRelativePath(t.filePath, false) : undefined,
        lines: t.filePath && t.lineRange ? `${t.lineRange[0] + 1}-${t.lineRange[1] + 1}` : undefined,
        highlight: t.highlight ?? undefined,
        orphaned: t.orphaned || undefined,
        children: t.children?.length ? t.children.map(describeTrace) : undefined,
    };
}

/**
 * Stable entry point for agents. Rewritten on every activation so it follows
 * extension updates; runs the CLI with this editor's own Electron as Node.
 */
function installShim(extensionPath: string): void {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const cli = path.join(extensionPath, 'dist', 'cli.js');
    const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const content = process.platform === 'win32'
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${sh(process.execPath)} ${sh(cli)} "$@"\n`;
    let current = '';
    try { current = fs.readFileSync(SHIM_PATH, 'utf8'); } catch { /* first install */ }
    if (current !== content) { writeAtomic(SHIM_PATH, content, 0o755); }
}

const SKILL_BODY = `Use the TraceNotes CLI at \`${SHIM_PATH}\` (below: \`tracenotes\`).
The project must be open in a VS Code window with the TraceNotes extension.

${GUIDE}`;

interface AgentTarget { name: string; file: string; installed: () => boolean; write: () => void }

const SKILL_MD = `---
name: tracenotes
description: Create or edit TraceNotes trace trees (hierarchical code-reading notes shown in the user's VS Code TraceNotes panel). Use when the user asks to build a trace tree, trace a code flow into TraceNotes, or add/edit/remove trace notes.
---

${SKILL_BODY}
`;

function writeIfChanged(file: string, text: string): void {
    try { if (fs.readFileSync(file, 'utf8') === text) { return; } } catch { /* not written yet */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

/** Agents whose config dir exists; each reads skills from <dir>/skills/<name>/SKILL.md. */
function agentTargets(): AgentTarget[] {
    const home = os.homedir();
    return ([['Claude Code', '.claude'], ['Codex', '.codex'], ['Cursor', '.cursor']] as const)
        .filter(([, dir]) => fs.existsSync(path.join(home, dir)))
        .map(([name, dir]) => {
            const file = path.join(home, dir, 'skills', 'tracenotes', 'SKILL.md');
            return { name, file, installed: () => fs.existsSync(file), write: () => writeIfChanged(file, SKILL_MD) };
        });
}

async function setupAgents(): Promise<void> {
    const targets = agentTargets();
    if (!targets.length) {
        vscode.window.showInformationMessage(
            `TraceNotes: No Claude Code, Codex or Cursor config found. Tell your agent to run "${SHIM_PATH} help".`);
        return;
    }
    const ok = await vscode.window.showInformationMessage(
        `TraceNotes: Teach ${targets.map(t => t.name).join(', ')} to create trace trees?`,
        { modal: true, detail: `This writes:\n${targets.map(t => t.file).join('\n')}` },
        'Write',
    );
    if (ok !== 'Write') { return; }
    try {
        targets.forEach(t => t.write());
        vscode.window.showInformationMessage(`TraceNotes: Set up ${targets.map(t => t.name).join(', ')}.`);
    } catch (err) {
        vscode.window.showErrorMessage(`TraceNotes: Agent setup failed. ${err}`);
    }
}

function offerSetupOnce(context: vscode.ExtensionContext): void {
    // Keep already-installed instructions in step with this version of the CLI.
    try { agentTargets().filter(t => t.installed()).forEach(t => t.write()); } catch (err) {
        console.error('TraceNotes: refreshing agent instructions failed', err);
    }
    const key = 'tracenotes.agentSetupOffered';
    if (context.globalState.get(key) || !agentTargets().length) { return; }
    void context.globalState.update(key, true);
    vscode.window.showInformationMessage('TraceNotes: Let AI agents (Claude Code, Codex, Cursor) create trace trees?', 'Set Up')
        .then(choice => { if (choice) { void setupAgents(); } });
}
