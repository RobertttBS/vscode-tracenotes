import * as vscode from 'vscode';
import { TraceManager } from './traceManager';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';

/**
 * Provides the React-based webview for the MindStack sidebar.
 */
export class StoryboardProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'mindstack.storyboard';
    private view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly traceManager: TraceManager,
        private readonly onMessage: (msg: WebviewToExtensionMessage) => void,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
        };

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
            if (msg.command === 'ready') {
                // Sync existing traces when webview first loads
                this.postMessage({ type: 'syncAll', payload: this.traceManager.getAll() });
            } else {
                this.onMessage(msg);
            }
        });
    }

    /** Send a message to the webview */
    postMessage(message: ExtensionToWebviewMessage): void {
        this.view?.webview.postMessage(message);
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
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
    <title>MindStack</title>
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
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
