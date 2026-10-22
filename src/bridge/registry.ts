// Shared by the extension host and the standalone CLI (dist/cli.js) — must not import `vscode`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HOME_DIR = path.join(os.homedir(), '.tracenotes');
export const RUN_DIR = path.join(HOME_DIR, 'run');
export const BIN_DIR = path.join(HOME_DIR, 'bin');
export const SHIM_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'tracenotes.cmd' : 'tracenotes');

/** One VS Code window's IPC endpoint, written to `RUN_DIR/<pid>.json`. */
export interface WindowEntry {
    pid: number;
    socket: string;
    token: string;
    folders: string[];
}

export function entryFile(pid: number, dir = RUN_DIR): string {
    return path.join(dir, `${pid}.json`);
}

export function readEntries(dir = RUN_DIR): WindowEntry[] {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const entries: WindowEntry[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        try { entries.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch { /* half-written or foreign file */ }
    }
    return entries;
}

/** Remove an entry and its Unix socket file (named pipes vanish on their own). */
export function removeEntry(entry: WindowEntry, dir = RUN_DIR): void {
    fs.rmSync(entryFile(entry.pid, dir), { force: true });
    if (process.platform !== 'win32') { fs.rmSync(entry.socket, { force: true }); }
}

export function isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Drop entries left behind by windows that died without deactivating (crash, force quit). */
export function sweepStale(dir = RUN_DIR): void {
    for (const e of readEntries(dir)) {
        if (!isAlive(e.pid)) { removeEntry(e, dir); }
    }
}

// ponytail: case-sensitive path compare; normalise case if case-insensitive FS mismatches show up.
function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The window whose workspace folder contains `cwd`; the deepest folder wins. */
export function pickEntry(entries: WindowEntry[], cwd: string): WindowEntry | undefined {
    let best: WindowEntry | undefined;
    let bestLen = -1;
    for (const e of entries) {
        for (const f of e.folders) {
            if (f.length > bestLen && isInside(cwd, f)) {
                best = e;
                bestLen = f.length;
            }
        }
    }
    return best;
}

/** Write via temp file + rename so readers never see a partial file. */
export function writeAtomic(file: string, data: string, mode: number): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}
