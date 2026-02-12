import * as vscode from 'vscode';
import { TraceManager } from './traceManager';
import { StoryboardProvider } from './webviewProvider';
import { collectTrace } from './collector';
import { handleJump } from './decoration';
import { generateMarkdown } from './exporter';
import { initDecorations, updateDecorations } from './decorationManager';

export function activate(context: vscode.ExtensionContext) {
    const traceManager = new TraceManager(context);

    // Initialise gutter-icon decoration type
    initDecorations(context);

    // Helper: refresh decorations on the active editor (scoped to active group)
    const refreshDecorations = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getAllFlat());
        }
    };

    // Timer handle for the deferred focusCard after exitGroup
    let focusCardTimer: ReturnType<typeof setTimeout> | undefined;

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
                    refreshDecorations();
                    break;
                case 'reorderTraces':
                    traceManager.reorder(msg.orderedIds);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getAll() });
                    break;
                case 'updateNote':
                    traceManager.updateNote(msg.id, msg.note);
                    refreshDecorations(); // hover message may have changed
                    break;
                case 'enterGroup':
                    traceManager.enterGroup(msg.id);
                    provider.postMessage({ type: 'setActiveGroup', id: msg.id, depth: traceManager.getActiveDepth() });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getAll() });
                    refreshDecorations();
                    break;
                case 'exitGroup': {
                    const exitedGroupId = traceManager.getActiveGroupId();
                    const exitedGroup = exitedGroupId ? traceManager.findTraceById(exitedGroupId) : undefined;
                    const newGroupId = traceManager.exitGroup();
                    provider.postMessage({ type: 'setActiveGroup', id: newGroupId, depth: traceManager.getActiveDepth() });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getAll() });
                    if (exitedGroupId) {
                        // Defer so the webview re-renders with the parent view first
                        if (focusCardTimer) { clearTimeout(focusCardTimer); }
                        focusCardTimer = setTimeout(() => {
                            provider.postMessage({ type: 'focusCard', id: exitedGroupId });
                            focusCardTimer = undefined;
                        }, 100);
                    }
                    refreshDecorations();
                    break;
                }
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
                provider.postMessage({ type: 'syncAll', payload: traceManager.getAll() });
                provider.postMessage({ type: 'focusCard', id: trace.id });
                refreshDecorations();
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
            provider.postMessage({ type: 'setActiveGroup', id: null, depth: 0 });
            provider.postMessage({ type: 'syncAll', payload: [] });
            refreshDecorations();
            vscode.window.showInformationMessage('MindStack: All traces cleared.');
        }),
    );

    // Re-render decorations when the user switches editor tabs
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getAllFlat());
            }
        }),
    );

    // Re-apply decorations after edits so VS Code's automatic range expansion
    // doesn't leak gutter icons / highlights to newly typed lines.
    let decorationDebounce: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                if (decorationDebounce) { clearTimeout(decorationDebounce); }
                decorationDebounce = setTimeout(() => {
                    updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getAllFlat());
                }, 100);
            }
        }),
    );

    // --- Reverse sync: cursor position → sidebar card ---
    let lastFocusedTraceId: string | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (debounceTimer) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(() => {
                const editor = event.textEditor;
                const position = editor.selection.active;
                const currentFilePath = editor.document.uri.fsPath;

                const allTraces = traceManager.getActiveChildren();
                const matched = allTraces.find(t =>
                    t.filePath === currentFilePath &&
                    position.line >= t.lineRange[0] &&
                    position.line <= t.lineRange[1],
                );

                const matchedId = matched?.id;
                if (matchedId && matchedId !== lastFocusedTraceId) {
                    lastFocusedTraceId = matchedId;
                    provider._view?.webview.postMessage({
                        type: 'focusCard',
                        id: matchedId,
                    });
                } else if (!matchedId && lastFocusedTraceId !== undefined) {
                    lastFocusedTraceId = undefined;
                    provider._view?.webview.postMessage({
                        type: 'focusCard',
                        id: null,
                    });
                }
            }, 150); // 150ms debounce
        }),
    );

    // Dispose all pending timers on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (focusCardTimer) { clearTimeout(focusCardTimer); }
            if (decorationDebounce) { clearTimeout(decorationDebounce); }
            if (debounceTimer) { clearTimeout(debounceTimer); }
        },
    });

    // Paint decorations for the already-open editor on activation
    refreshDecorations();
}

export function deactivate() {}
