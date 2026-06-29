// Type declarations for the VS Code webview API
interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

/** Send a message to the extension host */
export function postMessage(message: Record<string, unknown>): void {
    vscode.postMessage(message);
}

/** Persist UI state into the webview's VS Code state cache */
export function saveState(state: Record<string, any>): void {
    vscode.setState(state);
}

/** Restore previously cached UI state; returns undefined on first load */
export function loadState<T = Record<string, any>>(): T | undefined {
    return vscode.getState() as T | undefined;
}
