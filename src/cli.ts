// Standalone CLI bundled to dist/cli.js and run via the ~/.tracenotes/bin shim.
// Talks to the VS Code window that has the cwd open (see src/bridge/). No `vscode` import.
import * as fs from 'fs';
import * as net from 'net';
import { parseArgs } from 'util';
import { GUIDE } from './bridge/guide';
import { WindowEntry, pickEntry, readEntries, removeEntry } from './bridge/registry';

const HELP = `tracenotes — create and edit TraceNotes trace trees in the VS Code window
that has the current folder open.

${GUIDE}`;

function readStdin(): string {
    if (process.stdin.isTTY) { throw new Error('Pipe the Markdown in on stdin, e.g. `tracenotes create --name X < tree.md`.'); }
    return fs.readFileSync(0, 'utf8');
}

function request(entry: WindowEntry, op: string, args: Record<string, string | undefined>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const conn = net.connect(entry.socket);
        let buf = '';
        conn.setEncoding('utf8');
        conn.setTimeout(60_000, () => conn.destroy(new Error('Timed out waiting for VS Code.')));
        conn.on('connect', () => conn.write(JSON.stringify({ token: entry.token, op, args }) + '\n'));
        conn.on('data', d => { buf += d; });
        conn.on('error', reject);
        conn.on('end', () => {
            try {
                const res = JSON.parse(buf);
                res.ok ? resolve(res.result) : reject(new Error(res.error));
            } catch {
                reject(new Error('VS Code closed the connection before replying; the change may not have been applied. Check with `tracenotes show`.'));
            }
        });
    });
}

/** Send to the window that has cwd open, discarding entries of windows that are gone. */
async function send(op: string, args: Record<string, string | undefined>): Promise<unknown> {
    // Set by the per-editor launcher (tracenotes-cursor, tracenotes-code, …).
    const host = process.env.TRACENOTES_HOST || undefined;
    const editor = host ? ({ code: 'VS Code', cursor: 'Cursor', antigravity: 'Antigravity' } as Record<string, string>)[host] ?? host : 'VS Code';
    let entries = readEntries();
    for (;;) {
        const entry = pickEntry(entries, process.cwd(), host);
        if (!entry) {
            throw new Error(`No ${editor} window with TraceNotes has ${process.cwd()} open. Open the project in ${editor} and retry.`);
        }
        try {
            return await request(entry, op, args);
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== 'ECONNREFUSED' && code !== 'ENOENT') { throw e; }
            removeEntry(entry);
            entries = entries.filter(x => x !== entry);
        }
    }
}

interface Outlined { note?: string; id?: string; name?: string; file?: string; lines?: string; tag?: string; orphaned?: boolean; workspace?: string[]; children?: Outlined[]; traces?: Outlined[] }

/** `show --outline`: one indented line per trace — id, [tag], title, location. */
function outline(tree: Outlined): string {
    // `show --id` returns a single trace (no `traces`, no tree name).
    const lines = tree.traces ? [`${tree.name}  (${tree.id})${tree.workspace ? `  workspace: ${tree.workspace.join(', ')}` : ''}`] : [];
    const walk = (list: Outlined[] = [], depth: number) => list.forEach(t => {
        const where = t.file ? `  ${t.file}:${t.lines}${t.orphaned ? ' (orphaned)' : ''}` : '';
        const tag = t.tag ? `[${t.tag}] ` : '';
        lines.push(`${'  '.repeat(depth)}${t.id}  ${tag}${(t.note ?? '').split('\n')[0]}${where}`);
        walk(t.children, depth + 1);
    });
    if (tree.traces) { walk(tree.traces, 1); } else { walk([tree], 0); }
    return lines.join('\n') + '\n';
}

interface Found { count: number; truncated?: string; matches: { id: string; tree: string; title: string; tag?: string; at?: string; match?: string }[] }

/** `find --outline`: one line per match — id, [tag], title, location, (tree), matching line. */
function findOutline(r: Found): string {
    const lines = r.matches.map(m => [`${m.id}  ${m.tag ? `[${m.tag}] ` : ''}${m.title}`, m.at, `(${m.tree})`, m.match && `— ${m.match}`]
        .filter(Boolean).join('  '));
    if (!r.count) { lines.push('No matches.'); }
    if (r.truncated) { lines.push(r.truncated); }
    return lines.join('\n') + '\n';
}

async function main(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            name: { type: 'string' }, tree: { type: 'string' }, parent: { type: 'string' },
            after: { type: 'string' }, before: { type: 'string' }, lines: { type: 'string' }, outline: { type: 'boolean' },
            id: { type: 'string' }, file: { type: 'string' }, tag: { type: 'string' }, root: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
        },
    });
    const [cmd, id, ...rest] = positionals;
    if (!cmd || cmd === 'help' || values.help) { process.stdout.write(HELP); return; }

    const args: Record<string, string | undefined> = { name: values.name, tree: values.tree, parent: values.parent, after: values.after, before: values.before, lines: values.lines, id,
        root: values.root ? 'true' : undefined, dryRun: values['dry-run'] ? 'true' : undefined };
    if (cmd === 'show') { args.id = values.id; }
    if (cmd === 'find') { args.text = [id, ...rest].join(' ') || undefined; args.id = undefined; args.file = values.file; args.tag = values.tag; }
    if (cmd === 'title') { args.text = rest.join(' '); }
    if (cmd === 'rm' || cmd === 'refresh') { args.id = [id, ...rest].join(' '); }
    if (cmd === 'rename') { args.name = [id, ...rest].join(' '); }
    if (cmd === 'create' && !values.name) { throw new Error('create needs --name <name>.'); }
    if (cmd === 'create' || cmd === 'add') { args.markdown = readStdin(); }
    if (cmd === 'note') { args.text = rest.length ? rest.join(' ') : readStdin().replace(/\n$/, ''); }

    let result = await send(cmd, args);
    if (values.quiet && (cmd === 'create' || cmd === 'add') && !values['dry-run']) {
        // `--quiet`: drop the per-trace list; ids are one `show --outline` away.
        const { traces, added, ...rest } = result as Outlined & { added?: Outlined[] };
        const count = (list: Outlined[] = []): number => list.reduce((n, t) => n + 1 + count(t.children), 0);
        result = { ...rest, count: count(traces ?? added) };
    }
    const out = values.outline && cmd === 'show' ? outline(result as Outlined)
        : values.outline && cmd === 'find' ? findOutline(result as Found)
        : JSON.stringify(result, null, 2) + '\n';
    process.stdout.write(out);
}

main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`tracenotes: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
});
