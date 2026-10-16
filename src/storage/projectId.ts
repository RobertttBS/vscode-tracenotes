import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Canonical form of a git remote URL so ssh / https / with-or-without `.git`
 * clones of the same repo map to one ID: `git@GitHub.com:me/p.git` and
 * `https://github.com/me/p` both become `github.com/me/p`.
 */
export function normalizeRemoteUrl(url: string): string {
    let u = url.trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')  // scheme
        .replace(/^[^@/]+@/, '');                  // user@
    u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/');    // scp-style host:path (keep host:port/)
    u = u.replace(/\/+$/, '').replace(/\.git$/i, '');
    const slash = u.indexOf('/');
    return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

/** Extracts `[remote "origin"] url` from the text of a `.git/config` file. */
export function parseOriginUrl(configText: string): string | undefined {
    let inOrigin = false;
    for (const raw of configText.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inOrigin = /^\[remote\s+"origin"\]$/i.test(line); // section names are case-insensitive
            continue;
        }
        const m = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
        if (m) { return m[1].trim(); }
    }
    return undefined;
}

async function readText(uri: vscode.Uri): Promise<string> {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Reads origin's URL without spawning git. Handles worktrees/submodules (`.git` is a file). */
async function readGitOrigin(root: vscode.Uri): Promise<string | undefined> {
    try {
        let gitDir = vscode.Uri.joinPath(root, '.git');
        const stat = await vscode.workspace.fs.stat(gitDir);
        if (stat.type & vscode.FileType.File) {
            const m = /^gitdir:\s*(.+)$/m.exec(await readText(gitDir));
            if (!m) { return undefined; }
            gitDir = vscode.Uri.file(path.resolve(root.fsPath, m[1].trim()));
            try {
                // Linked worktree: config lives in the common dir, not the per-worktree gitdir.
                const common = (await readText(vscode.Uri.joinPath(gitDir, 'commondir'))).trim();
                gitDir = vscode.Uri.file(path.resolve(gitDir.fsPath, common));
            } catch { /* submodule: config is in gitdir itself */ }
        }
        return parseOriginUrl(await readText(vscode.Uri.joinPath(gitDir, 'config')));
    } catch {
        return undefined;
    }
}

/**
 * Identity used to share traces between folders holding the same project:
 * `tracenotes.projectId` setting → normalized git origin → folder name.
 */
export async function resolveProjectId(root: vscode.Uri): Promise<ProjectId> {
    const configured = vscode.workspace.getConfiguration('tracenotes', root).get<string>('projectId')?.trim();
    if (configured) { return { id: configured, source: 'setting' }; }
    const origin = await readGitOrigin(root);
    return origin
        ? { id: normalizeRemoteUrl(origin), source: 'git origin' }
        : { id: path.basename(root.fsPath), source: 'folder name' };
}

export interface ProjectId {
    id: string;
    source: 'setting' | 'git origin' | 'folder name';
}
