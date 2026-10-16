// src/storage/FileStorageManager.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { TracePoint, TraceTree } from '../types';
import { resolveProjectId, ProjectId } from './projectId';
import { toShared, fromShared } from './pathMapping';

/** Per-checkout fields: each folder (branch) anchors traces in its own copy of the code. */
type Positions = Record<string, Pick<TracePoint, 'rangeOffset' | 'lineRange' | 'orphaned'>>;

/** `projects/<hash>/project.json` — maps the hashed directory back to its readable ID. */
export interface ProjectEntry {
    id: string;
    folders: string[];
}

/**
 * Two storage layers when a folder is open (see docs/specs/shared-project-traces.md):
 *   - shared file  `globalStorageUri/projects/<hash(projectId)>/tracenotes.data.json`
 *     — the trees, with root-relative paths; every folder of the project reads it.
 *   - positions    `storageUri/tracenotes.positions.json` — this folder's offsets,
 *     written by validation so two checkouts never rewrite the shared file.
 * Without a folder, everything lives in one file as before.
 */
export class FileStorageManager {
    private readonly fileName = 'tracenotes.data.json';
    private readonly backupName = 'tracenotes.backup.json';
    private readonly tempName = 'tracenotes.temp.json';
    private readonly positionsName = 'tracenotes.positions.json';

    private readonly logger: vscode.LogOutputChannel;
    private sharedDir: Promise<{ dir: vscode.Uri; project: ProjectId }> | undefined;
    /** Last shared JSON this window wrote or read — lets the watcher ignore our own writes. */
    private lastSharedJson: string | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.logger = vscode.window.createOutputChannel('TraceNotes Storage', { log: true });
    }

    /** Workspace root when sharing applies (a folder is open), else undefined. */
    private get root(): vscode.Uri | undefined {
        return this.context.storageUri ? vscode.workspace.workspaceFolders?.[0]?.uri : undefined;
    }

    private get projectsDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, 'projects');
    }

    /** Resolved once per window; `resetProject()` re-resolves after the setting changes. */
    private resolveSharedDir(root: vscode.Uri): Promise<{ dir: vscode.Uri; project: ProjectId }> {
        return this.sharedDir ??= resolveProjectId(root).then(async project => {
            const key = createHash('sha1').update(project.id).digest('hex').slice(0, 16);
            const dir = vscode.Uri.joinPath(this.projectsDir, key);
            this.logger.info(`Project ID "${project.id}" (${project.source}) → ${dir.fsPath}`);
            await vscode.workspace.fs.createDirectory(dir);
            await this.updateProjectEntry(dir, project.id, folders => [...new Set([...folders, root.fsPath])]);
            return { dir, project };
        }).catch(e => {
            this.sharedDir = undefined; // let the next call retry
            throw e;
        });
    }

    private async updateProjectEntry(dir: vscode.Uri, id: string, edit: (folders: string[]) => string[]): Promise<void> {
        const uri = vscode.Uri.joinPath(dir, 'project.json');
        const entry = this.parse<ProjectEntry>(await this.readText(uri), uri);
        const next: ProjectEntry = { id, folders: edit(entry?.folders ?? []) };
        try {
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(next)));
        } catch (e) {
            this.logger.error('Failed to write project.json', e as Error);
        }
    }

    /** This folder's project ID, or undefined when no folder is open. */
    public async getProject(): Promise<ProjectId | undefined> {
        const root = this.root;
        return root ? (await this.resolveSharedDir(root)).project : undefined;
    }

    /** Every project that has a shared directory. */
    public async listProjects(): Promise<ProjectEntry[]> {
        let dirs: [string, vscode.FileType][];
        try {
            dirs = await vscode.workspace.fs.readDirectory(this.projectsDir);
        } catch {
            return [];
        }
        const entries: ProjectEntry[] = [];
        for (const [name, type] of dirs) {
            if (!(type & vscode.FileType.Directory)) { continue; }
            const uri = vscode.Uri.joinPath(this.projectsDir, name, 'project.json');
            const entry = this.parse<ProjectEntry>(await this.readText(uri), uri);
            if (entry) { entries.push(entry); }
        }
        return entries;
    }

    /**
     * Drops this folder from its current project and forgets the cached ID, so the
     * next load resolves `tracenotes.projectId` afresh. Callers must re-`watch()`.
     */
    public async resetProject(): Promise<void> {
        const root = this.root;
        if (!root || !this.sharedDir) { return; }
        const { dir, project } = await this.sharedDir;
        await this.updateProjectEntry(dir, project.id, folders => folders.filter(f => f !== root.fsPath));
        this.sharedDir = undefined;
        this.lastSharedJson = undefined;
    }

    /**
     * Resolves the storage directory for the trees file and creates it if absent:
     * the project's shared directory when a folder is open, else the old
     * storageUri / globalStorageUri location.
     */
    private async getStorageDirectory(): Promise<vscode.Uri | undefined> {
        try {
            const root = this.root;
            const storageDir = root
                ? (await this.resolveSharedDir(root)).dir
                : this.context.storageUri ?? this.context.globalStorageUri;
            await vscode.workspace.fs.createDirectory(storageDir);
            return storageDir;
        } catch (e) {
            this.logger.error('Failed to create storage directory', e as Error);
            return undefined;
        }
    }

    /**
     * Atomically persists text to `dir/name`:
     *   1. Write to a temp file.
     *   2. Rotate the current main file to backup.
     *   3. Rename temp → main (OS-level atomic on most filesystems).
     */
    private async atomicWrite(dir: vscode.Uri, name: string, backupName: string, tempName: string, text: string): Promise<boolean> {
        const fileUri   = vscode.Uri.joinPath(dir, name);
        const backupUri = vscode.Uri.joinPath(dir, backupName);
        // Unique per write: windows of one project share `dir`.
        const tempUri   = vscode.Uri.joinPath(dir, `${tempName}.${crypto.randomUUID().slice(0, 8)}`);

        try {
            // 1. Write new data to a TEMP file (compact JSON — this file is
            //    machine-read only; pretty-printing roughly doubles the bytes)
            await vscode.workspace.fs.writeFile(tempUri, new TextEncoder().encode(text));

            // 2. Rotate old main → backup (if main exists)
            if (await this.uriExists(fileUri)) {
                await vscode.workspace.fs.copy(fileUri, backupUri, { overwrite: true });
            }

            // 3. Atomically promote temp → main
            await vscode.workspace.fs.rename(tempUri, fileUri, { overwrite: true });
            return true;
        } catch (e) {
            this.logger.error(`Failed to persist ${name}.`, e as Error);
            vscode.window.showErrorMessage('TraceNotes: Failed to save data.');
            // Clean up the temp file if it was created before the failure
            try { await vscode.workspace.fs.delete(tempUri); } catch { /* ignore */ }
            return false;
        }
    }

    /** Persists the trees (shared file) and, when sharing, this folder's positions. */
    public async save(trees: TraceTree[]): Promise<boolean> {
        const storageDir = await this.getStorageDirectory();
        if (!storageDir) { return false; }

        const root = this.root;
        const json = JSON.stringify(root ? toShared(trees, root.fsPath) : trees);
        this.lastSharedJson = json; // set before writing so the watcher event of our own write is ignored
        const ok = await this.atomicWrite(storageDir, this.fileName, this.backupName, this.tempName, json);
        if (ok) { this.logger.info('Trace trees saved successfully.'); }
        const positionsOk = root ? await this.writePositions(trees) : true;
        return ok && positionsOk;
    }

    /** Persists only this folder's positions — validation results never touch the shared file. */
    public async savePositions(trees: TraceTree[]): Promise<boolean> {
        return this.root
            ? this.writePositions(trees)
            : this.save(trees); // no sharing: positions live in the single trees file
    }

    private async writePositions(trees: TraceTree[]): Promise<boolean> {
        const dir = this.context.storageUri!;
        const positions: Positions = {};
        const walk = (traces: TracePoint[]) => {
            for (const t of traces) {
                positions[t.id] = { rangeOffset: t.rangeOffset, lineRange: t.lineRange, orphaned: t.orphaned };
                if (t.children) { walk(t.children); }
            }
        };
        trees.forEach(tree => walk(tree.traces));
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch (e) {
            this.logger.error('Failed to create storage directory', e as Error);
            return false;
        }
        return this.atomicWrite(dir, this.positionsName, 'tracenotes.positions.backup.json', 'tracenotes.positions.temp.json', JSON.stringify(positions));
    }

    /**
     * Loads traces from the main file; transparently falls back to the backup
     * if the main file is missing or corrupt. When sharing, resolves paths
     * against this folder, migrates this folder's pre-sharing file, and
     * overlays this folder's positions.
     */
    public async load(): Promise<TraceTree[] | null> {
        const storageDir = await this.getStorageDirectory();
        if (!storageDir) { return null; }

        const fileUri   = vscode.Uri.joinPath(storageDir, this.fileName);
        const backupUri = vscode.Uri.joinPath(storageDir, this.backupName);

        // Primary
        const text = await this.readText(fileUri);
        let data = this.parse<TraceTree[]>(text, fileUri);
        this.lastSharedJson = text ?? undefined;

        // Fallback to backup
        if (data === null) {
            const backupData = this.parse<TraceTree[]>(await this.readText(backupUri), backupUri);
            if (backupData !== null) {
                this.logger.warn('Main file missing or corrupted. Loaded backup.');
                vscode.window.showWarningMessage('TraceNotes: Loaded data from backup file.');
                data = backupData;
            }
        }

        const root = this.root;
        if (!root) { return data; }

        if (data) { data = fromShared(data, root.fsPath); }
        data = await this.migrateLegacy(data, root);
        if (data) {
            const positionsUri = vscode.Uri.joinPath(this.context.storageUri!, this.positionsName);
            const positions = this.parse<Positions>(await this.readText(positionsUri), positionsUri);
            if (positions) { data.forEach(tree => applyPositions(tree.traces, positions)); }
        }
        // No persisted data at all — caller should init with defaults
        return data;
    }

    /**
     * One-time: folds this folder's pre-sharing `storageUri/tracenotes.data.json`
     * into the shared trees, then renames it to `.migrated` (kept, not deleted).
     */
    private async migrateLegacy(shared: TraceTree[] | null, root: vscode.Uri): Promise<TraceTree[] | null> {
        const legacyUri = vscode.Uri.joinPath(this.context.storageUri!, this.fileName);
        const legacy = this.parse<TraceTree[]>(await this.readText(legacyUri), legacyUri);
        if (!legacy) { return shared; }

        const merged = mergeTrees(shared ?? [], legacy, path.basename(root.fsPath));
        if (await this.save(merged)) {
            await vscode.workspace.fs.rename(legacyUri, vscode.Uri.joinPath(this.context.storageUri!, `${this.fileName}.migrated`), { overwrite: true });
            this.logger.info(`Migrated ${legacy.length} tree(s) from ${legacyUri.fsPath} into the shared project file.`);
        }
        return merged;
    }

    /**
     * Calls `onExternalChange` when another window rewrites the shared file.
     * Returns undefined when nothing is shared (no folder open).
     */
    public async watch(onExternalChange: () => void): Promise<vscode.Disposable | undefined> {
        if (!this.root) { return undefined; }
        const dir = await this.getStorageDirectory();
        if (!dir) { return undefined; }

        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, this.fileName));
        const handler = async () => {
            const text = await this.readText(vscode.Uri.joinPath(dir, this.fileName));
            if (text !== null && text !== this.lastSharedJson) { onExternalChange(); }
        };
        watcher.onDidChange(handler);
        watcher.onDidCreate(handler);
        return watcher;
    }

    private async readText(uri: vscode.Uri): Promise<string | null> {
        if (!(await this.uriExists(uri))) {
            return null;
        }
        try {
            return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch (e) {
            this.logger.error(`Failed to read ${uri.path}`, e as Error);
            return null;
        }
    }

    private parse<T>(text: string | null, uri: vscode.Uri): T | null {
        if (text === null) { return null; }
        try {
            return JSON.parse(text) as T;
        } catch (e) {
            this.logger.error(`Failed to parse ${uri.path}`, e as Error);
            return null;
        }
    }

    private async uriExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }
}

function applyPositions(traces: TracePoint[], positions: Positions): void {
    for (const t of traces) {
        const p = positions[t.id];
        if (p) { Object.assign(t, p); }
        if (t.children) { applyPositions(t.children, positions); }
    }
}

/** Fields that differ per checkout or per save — ignored when deciding two trees are the same. */
const VOLATILE_KEYS = new Set(['rangeOffset', 'lineRange', 'orphaned', 'createdAt', 'updatedAt']);
const stableJson = (tree: TraceTree) => JSON.stringify(tree, (k, v) => VOLATILE_KEYS.has(k) ? undefined : v);

/**
 * Appends `incoming` trees to `target` (both with this checkout's absolute paths).
 * A tree whose id is already present is skipped when identical or empty, otherwise kept
 * as a copy with fresh ids (e.g. every folder's 'default' tree) named
 * `<name> (<label>)` so the trace index maps stay unique and nothing is lost.
 */
export function mergeTrees(target: TraceTree[], incoming: TraceTree[], label: string): TraceTree[] {
    const merged = [...target];
    for (const tree of incoming) {
        const clash = merged.find(t => t.id === tree.id);
        if (!clash) {
            merged.push(tree);
        } else if (tree.traces.length > 0 && stableJson(clash) !== stableJson(tree)) {
            // An empty clashing tree (an unused folder's 'default') adds nothing.
            merged.push({ ...tree, id: crypto.randomUUID(), name: `${tree.name} (${label})`, traces: reId(tree.traces) });
        }
    }
    return merged;
}

function reId(traces: TracePoint[]): TracePoint[] {
    return traces.map(t => ({ ...t, id: crypto.randomUUID(), children: t.children && reId(t.children) }));
}
