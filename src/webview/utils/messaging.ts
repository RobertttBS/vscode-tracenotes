// Type declarations for the VS Code webview API
interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export type MessageHandler = (message: { type: string; payload?: unknown }) => void;

/** Subscribe to messages from the extension host */
export function onMessage(handler: MessageHandler): () => void {
    const listener = (event: MessageEvent) => {
        handler(event.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
}

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
