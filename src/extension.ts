import * as vscode from 'vscode';
import { TraceManager } from './traceManager';
import { StoryboardProvider } from './webviewProvider';
import { collectTrace } from './collector';
import { handleJump } from './decoration';
import { generateMarkdown } from './exporter';

export function activate(context: vscode.ExtensionContext) {
    const traceManager = new TraceManager(context);

    // Create the webview provider
    const provider = new StoryboardProvider(
        context.extensionUri,
        traceManager,
        (msg) => {
            switch (msg.command) {
                case 'jumpToCode':
                    handleJump({ filePath: msg.filePath, range: msg.range });
                    break;
                case 'removeTrace':
                    traceManager.remove(msg.id);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getAll() });
                    break;
                case 'reorderTraces':
                    traceManager.reorder(msg.orderedIds);
                    break;
                case 'updateNote':
                    traceManager.updateNote(msg.id, msg.note);
                    break;
            }
        },
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(StoryboardProvider.viewType, provider),
    );

    // Command: Collect Trace
    context.subscriptions.push(
        vscode.commands.registerCommand('mindstack.collectTrace', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('MindStack: No active editor.');
                return;
            }
            const trace = collectTrace(editor);
            if (trace) {
                traceManager.add(trace);
                provider.postMessage({ type: 'addTrace', payload: trace });
                vscode.window.showInformationMessage('MindStack: Trace collected!');
            }
        }),
    );

    // Command: Export to Markdown
    context.subscriptions.push(
        vscode.commands.registerCommand('mindstack.exportMarkdown', async () => {
            const traces = traceManager.getAll();
            if (traces.length === 0) {
                vscode.window.showWarningMessage('MindStack: No traces to export.');
                return;
            }
            const md = generateMarkdown(traces);
            const doc = await vscode.workspace.openTextDocument({
                content: md,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        }),
    );

    // Command: Clear All
    context.subscriptions.push(
        vscode.commands.registerCommand('mindstack.clearAll', () => {
            traceManager.clear();
            provider.postMessage({ type: 'syncAll', payload: [] });
            vscode.window.showInformationMessage('MindStack: All traces cleared.');
        }),
    );
}

export function deactivate() {}
