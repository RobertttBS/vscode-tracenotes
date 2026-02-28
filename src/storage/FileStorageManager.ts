// src/storage/FileStorageManager.ts
import * as vscode from 'vscode';
import { TraceTree } from '../types';

export class FileStorageManager {
    private readonly fileName = 'tracenotes.data.json';
    private readonly backupName = 'tracenotes.backup.json';
    private readonly tempName = 'tracenotes.temp.json';

    private readonly logger: vscode.LogOutputChannel;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.logger = vscode.window.createOutputChannel('TraceNotes Storage', { log: true });
    }

    /**
     * Resolves the storage directory, preferring workspace-specific storage
     * with a fallback to global storage. Creates the directory if absent.
     *
     * storageUri  – workspace-scoped (undefined when no folder is open)
     * globalStorageUri – always available, extension-scoped
     */
    private async getStorageDirectory(): Promise<vscode.Uri | undefined> {
        const storageDir = this.context.storageUri ?? this.context.globalStorageUri;
        if (!storageDir) {
            this.logger.error('No storage directory available.');
            return undefined;
        }

        try {
            await vscode.workspace.fs.createDirectory(storageDir);
            return storageDir;
        } catch (e) {
            this.logger.error('Failed to create storage directory', e as Error);
            return undefined;
        }
    }

    /**
     * Atomically persists trees to disk:
     *   1. Write to a temp file.
     *   2. Rotate the current main file to backup.
     *   3. Rename temp → main (OS-level atomic on most filesystems).
     */
    public async save(trees: TraceTree[]): Promise<void> {
        const storageDir = await this.getStorageDirectory();
        if (!storageDir) { return; }

        const fileUri   = vscode.Uri.joinPath(storageDir, this.fileName);
        const backupUri = vscode.Uri.joinPath(storageDir, this.backupName);
        const tempUri   = vscode.Uri.joinPath(storageDir, this.tempName);

        try {
            // 1. Write new data to a TEMP file
            const dataBytes = new TextEncoder().encode(JSON.stringify(trees, null, 2));
            await vscode.workspace.fs.writeFile(tempUri, dataBytes);

            // 2. Rotate old main → backup (if main exists)
            if (await this.uriExists(fileUri)) {
                await vscode.workspace.fs.copy(fileUri, backupUri, { overwrite: true });
            }

            // 3. Atomically promote temp → main
            await vscode.workspace.fs.rename(tempUri, fileUri, { overwrite: true });

            this.logger.info('Trace trees saved successfully.');
        } catch (e) {
            this.logger.error('Failed to persist state.', e as Error);
            vscode.window.showErrorMessage('TraceNotes: Failed to save data.');
            // Clean up the temp file if it was created before the failure
            try { await vscode.workspace.fs.delete(tempUri); } catch { /* ignore */ }
        }
    }

    /**
     * Loads traces from the main file; transparently falls back to the backup
     * if the main file is missing or corrupt.
     */
    public async load(): Promise<TraceTree[] | null> {
        const storageDir = await this.getStorageDirectory();
        if (!storageDir) { return null; }

        const fileUri   = vscode.Uri.joinPath(storageDir, this.fileName);
        const backupUri = vscode.Uri.joinPath(storageDir, this.backupName);

        // Primary
        const data = await this.readFileSafely(fileUri);
        if (data !== null) { return data; }

        // Fallback to backup
        this.logger.warn('Main file missing or corrupted. Attempting backup.');
        const backupData = await this.readFileSafely(backupUri);
        if (backupData !== null) {
            vscode.window.showWarningMessage('TraceNotes: Loaded data from backup file.');
            return backupData;
        }

        // No persisted data at all — caller should init with defaults
        return null;
    }

    private async readFileSafely(uri: vscode.Uri): Promise<TraceTree[] | null> {
        if (!(await this.uriExists(uri))) {
            return null;
        }

        try {
            const bytes      = await vscode.workspace.fs.readFile(uri);
            const dataString = new TextDecoder().decode(bytes);
            return JSON.parse(dataString) as TraceTree[];
        } catch (e) {
            this.logger.error(`Failed to read or parse ${uri.path}`, e as Error);
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
