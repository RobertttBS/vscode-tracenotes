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
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    refreshDecorations();
                    break;
                case 'reorderTraces':
                    traceManager.reorder(msg.orderedIds);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    break;
                case 'updateNote':
                    traceManager.updateNote(msg.id, msg.note);
                    refreshDecorations(); // hover message may have changed
                    break;
                case 'updateHighlight':
                    traceManager.updateHighlight(msg.id, msg.highlight);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() }); // Sync to webview so it knows the new state
                    refreshDecorations();
                    break;
                case 'enterGroup':
                    traceManager.enterGroup(msg.id);
                    provider.postMessage({ type: 'setActiveGroup', id: msg.id, depth: traceManager.getActiveDepth(), breadcrumb: traceManager.getActiveBreadcrumb() });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    refreshDecorations();
                    break;
                case 'exitGroup': {
                    const exitedGroupId = traceManager.getActiveGroupId();
                    // const exitedGroup = exitedGroupId ? traceManager.findTraceById(exitedGroupId) : undefined;
                    const newGroupId = traceManager.exitGroup();
                    provider.postMessage({ type: 'setActiveGroup', id: newGroupId, depth: traceManager.getActiveDepth(), breadcrumb: traceManager.getActiveBreadcrumb() });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
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
                case 'clearCurrentLevel':
                    traceManager.clearActiveChildren();
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    refreshDecorations();
                    break;
                case 'exportToMarkdown':
                    vscode.commands.executeCommand('tracenotes.exportMarkdown');
                    break;
                case 'renameTree':
                    traceManager.renameActiveTree(msg.name);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    provider.postMessage({ type: 'syncTreeList', payload: traceManager.getTreeList() });
                    break;
                case 'getTreeList':
                    provider.postMessage({ type: 'syncTreeList', payload: traceManager.getTreeList() });
                    break;
                case 'createTree':
                    traceManager.createTree(msg.name);
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    provider.postMessage({ type: 'syncTreeList', payload: traceManager.getTreeList() });
                    break;
                case 'switchTree':
                    traceManager.switchTree(msg.id);
                    // Also reset group view in webview
                    provider.postMessage({ type: 'setActiveGroup', id: null, depth: 0, breadcrumb: '' });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    provider.postMessage({ type: 'syncTreeList', payload: traceManager.getTreeList() });
                    refreshDecorations();
                    break;
                case 'deleteTree':
                    traceManager.deleteTree(msg.id);
                    // If we deleted the active tree, the manager switched us. Sync everything.
                    provider.postMessage({ type: 'setActiveGroup', id: null, depth: 0, breadcrumb: '' });
                    provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                    provider.postMessage({ type: 'syncTreeList', payload: traceManager.getTreeList() });
                    refreshDecorations();
                    break;
            }
        },
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(StoryboardProvider.viewType, provider),
    );

    // Command: Collect Trace
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.collectTrace', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('TraceNotes: No active editor.');
                return;
            }
            const trace = collectTrace(editor);
            if (trace) {
                traceManager.add(trace);

                // Show the sidebar view (preserve focus if already open)
                if (provider._view) {
                    provider._view.show(true);
                } else {
                    vscode.commands.executeCommand('tracenotes.storyboard.focus');
                }

                provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
                
                refreshDecorations();

                // Delay focus to allow view to render/settle
                setTimeout(() => {
                    provider.postMessage({ type: 'focusCard', id: trace.id });
                }, 300);

                vscode.window.showInformationMessage('TraceNotes: Trace collected!');
            }
        }),
    );

    // Command: Export to Markdown
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.exportMarkdown', async () => {
            const traces = traceManager.getAll();
            if (traces.length === 0) {
                vscode.window.showWarningMessage('TraceNotes: No traces to export.');
                return;
            }
            const md = generateMarkdown(traces);
            
            const treeData = traceManager.getActiveTreeData();
            const fileName = treeData ? `${treeData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md` : 'tracenotes.md';

            // Just open a new untitled document with the content? 
            // Or let user save?
            // "The user wants to name the markdown file name"
            // vscode.workspace.openTextDocument({ content: md, language: 'markdown' }) 
            // creates an untitled document. It doesn't set the filename until save.
            // But we can suggest a name if we use showSaveDialog, OR we can just open it.
            // Opening an untitled document with a specific name is tricky.
            // Actually, we can just open it. The user said "When exporting the markdown, it will use the name as markdown file name."
            // This implies when saving? Or we can simulate it by standard "Save As" flow?
            // Let's stick to the current behavior (openTextDocument) but maybe we can't easily force the name 
            // unless we save it.
            // For now, let's keep the existing flow but if we wanted to enforce name we'd need save dialog.
            // Code snippet below uses openTextDocument.
            
            // To suggest a name, we might want to use showSaveDialog instead.
            // But for now, I'll stick to opening the document, but I can't easily set the title of untitled doc.
            // Actually, I can try to set the language and maybe content.
            
            // Wait, the user requirement is "When exporting the markdown, it will use the name as markdown file name."
            // If I just show it, it's "Untitled-1".
            // Implementation idea: Use showSaveDialog to let user pick location, using tree name as default.
            
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(fileName),
                filters: { 'Markdown': ['md'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
                await vscode.window.showTextDocument(uri);
            }
        }),
    );

    // Command: Clear All
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.clearAll', () => {
            traceManager.clear();
            provider.postMessage({ type: 'setActiveGroup', id: null, depth: 0, breadcrumb: '' });
            provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
            refreshDecorations();
            vscode.window.showInformationMessage('TraceNotes: All traces cleared.');
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
            // Keep traces in sync with document changes
            traceManager.handleTextDocumentChange(event);

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
                const matched = allTraces.find(t => {
                    if (t.filePath !== currentFilePath) { return false; }
                    if (t.rangeOffset) {
                         const offset = editor.document.offsetAt(position);
                         return offset >= t.rangeOffset[0] && offset <= t.rangeOffset[1];
                    }
                    if (t.lineRange) {
                        return position.line >= t.lineRange[0] && position.line <= t.lineRange[1];
                    }
                    return false;
                });

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

    // Listen for trace changes from validation/updates (UI Sync)
    context.subscriptions.push(
        traceManager.onDidChangeTraces(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getAllFlat());
            }
            // Sync with webview
            provider.postMessage({ type: 'syncAll', payload: traceManager.getSyncPayload() });
        })
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
