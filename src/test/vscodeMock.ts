// Minimal `vscode` stand-in for vitest: `vi.mock('vscode', () => import('./test/vscodeMock'))`.
// workspace.fs hits the real disk (point storage at a temp dir) so persistence
// tests exercise the actual atomic-write / backup / reload flow.
import * as fs from 'fs/promises';
import * as path from 'path';

export class Uri {
    private constructor(public readonly fsPath: string) {}
    get path() { return this.fsPath; }
    static file(p: string) { return new Uri(p); }
    static parse(p: string) { return new Uri(p); }
    static joinPath(base: Uri, ...segs: string[]) { return new Uri(path.join(base.fsPath, ...segs)); }
    toString() { return `file://${this.fsPath}`; }
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

export class Selection extends Range {
    constructor(a: Position | number, b: Position | number, c = 0, d = 0) {
        super(typeof a === 'number' ? new Position(a, b as number) : a, typeof a === 'number' ? new Position(c, d) : b as Position);
    }
}

export class EventEmitter<T> {
    private listeners = new Set<(e: T) => void>();
    event = (fn: (e: T) => void) => {
        this.listeners.add(fn);
        return { dispose: () => this.listeners.delete(fn) };
    };
    fire(e: T) { this.listeners.forEach(fn => fn(e)); }
    dispose() { this.listeners.clear(); }
}

export class CancellationTokenSource {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
}

export class RelativePattern {
    constructor(public base: Uri, public pattern: string) {}
}

export enum FileType { File = 1, Directory = 2 }

/** Settings read through workspace.getConfiguration; tests may mutate it. */
export const config: Record<string, unknown> = {};

const noopDisposable = { dispose() {} };

export const workspace = {
    workspaceFolders: undefined as { uri: Uri; name: string }[] | undefined,
    textDocuments: [] as unknown[],
    getConfiguration: () => ({ get: (key: string) => config[key] }),
    onDidCloseTextDocument: () => noopDisposable,
    onDidChangeTextDocument: () => noopDisposable,
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }),
    findFiles: async () => [],
    asRelativePath: (p: string | Uri) => typeof p === 'string' ? p : p.fsPath,
    openTextDocument: async () => { throw new Error('openTextDocument not mocked'); },
    fs: {
        stat: async (u: Uri) => {
            const s = await fs.stat(u.fsPath);
            return { type: s.isDirectory() ? FileType.Directory : FileType.File };
        },
        readFile: async (u: Uri) => new Uint8Array(await fs.readFile(u.fsPath)),
        writeFile: (u: Uri, data: Uint8Array) => fs.writeFile(u.fsPath, data),
        createDirectory: (u: Uri) => fs.mkdir(u.fsPath, { recursive: true }).then(() => {}),
        readDirectory: async (u: Uri) => (await fs.readdir(u.fsPath, { withFileTypes: true }))
            .map(d => [d.name, d.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType]),
        copy: (a: Uri, b: Uri) => fs.copyFile(a.fsPath, b.fsPath),
        rename: (a: Uri, b: Uri) => fs.rename(a.fsPath, b.fsPath),
        delete: (u: Uri) => fs.rm(u.fsPath, { force: true }),
    },
};

export const window = {
    visibleTextEditors: [] as unknown[],
    createOutputChannel: () => ({ appendLine() {}, info() {}, warn() {}, error() {}, show() {}, dispose() {} }),
    showErrorMessage: () => undefined,
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
};

/** Text document stand-in with real offset ↔ position math. */
export function makeDoc(filePath: string, text: string, version = 1) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) { if (text[i] === '\n') { lineStarts.push(i + 1); } }
    const positionAt = (offset: number) => {
        let line = 0;
        while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) { line++; }
        return new Position(line, offset - lineStarts[line]);
    };
    const offsetAt = (p: Position) => lineStarts[p.line] + p.character;
    return {
        uri: Uri.file(filePath), version, languageId: 'typescript', lineCount: lineStarts.length,
        getText: (r?: { start: Position; end: Position }) => r ? text.slice(offsetAt(r.start), offsetAt(r.end)) : text,
        positionAt, offsetAt,
        lineAt: (line: number) => {
            const end = (lineStarts[line + 1] ?? text.length + 1) - 1;
            return { text: text.slice(lineStarts[line], end), range: { end: positionAt(end) } };
        },
    } as any;
}
