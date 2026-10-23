import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TraceManager } from './traceManager';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';

/**
 * Provides the React-based webview for the TraceNotes sidebar.
 */
export class StoryboardProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'tracenotes.storyboard';
    public _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly traceManager: TraceManager,
        private readonly onMessage: (msg: Exclude<WebviewToExtensionMessage, { command: 'ready' }>) => void,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg: WebviewToExtensionMessage) => {
            // Gate all webview commands behind initialization so no message
            // can read or mutate trace data before the disk load resolves.
            await this.traceManager.ensureReady();

            if (msg.command === 'ready') {
                // Sync everything in one go
                this.postMessage({ 
                    type: 'syncWorkspace', 
                    payload: this.traceManager.getWorkspaceSyncPayload() 
                });
                this.postMinimapLayout();
            } else {
                this.onMessage(msg);
            }
        });
    }

    /** Send a message to the webview */
    postMessage(message: ExtensionToWebviewMessage): void {
        this._view?.webview.postMessage(message);
    }

    /** Push the minimap layout settings (tracenotes.minimap.*) to the webview */
    postMinimapLayout(): void {
        const config = vscode.workspace.getConfiguration('tracenotes.minimap');
        // package.json min/max are only editor hints; clamp so hand-edited values can't break the layout
        const clamp = (key: string, def: number, min: number, max: number) => {
            const v = config.get<number>(key, def);
            return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
        };
        this.postMessage({
            type: 'minimapLayout',
            cardWidth: clamp('cardWidth', 380, 200, 1000),
            columnGap: clamp('columnGap', 60, 56, 400),
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
        );
        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
        );

        const nonce = getNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';">
    <title>TraceNotes</title>
    <link rel="stylesheet" href="${cssUri}">
    <style>
        body {
            margin: 0;
            padding: 0;
            background: transparent;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        #root {
            min-height: 100vh;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    return crypto.randomBytes(24).toString('base64url');
}
