import * as vscode from 'vscode';
import { TraceManager } from './traceManager';
import { EditorTracker } from './utils/EditorTracker';
import { StoryboardProvider } from './webviewProvider';
import { collectTrace } from './collector';
import { handleJump } from './decoration';
import { generateMarkdown } from './exporter';
import { initDecorations, updateDecorations } from './decorationManager';

// Module-level reference so `deactivate` can flush pending saves.
let _traceManagerRef: TraceManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    const traceManager = new TraceManager(context);
    _traceManagerRef = traceManager;
    context.subscriptions.push(traceManager);

    // Track the last active text editor safely to support actions from the webview
    const editorTracker = new EditorTracker();
    context.subscriptions.push(editorTracker);

    // Initialise gutter-icon decoration type
    initDecorations(context);

    // Helper: refresh decorations on the active editor (scoped to active group)
    const refreshDecorations = () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
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
                    break;
                case 'reorderTraces':
                    traceManager.reorder(msg.orderedIds);
                    break;
                case 'updateNote':
                    traceManager.updateNote(msg.id, msg.note);
                    break;
                case 'relocateTrace': {
                    const editor = editorTracker.activeOrLastEditor;
                    if (!editor) {
                        vscode.window.showErrorMessage('TraceNotes: Please open and focus a file to relocate the trace.');
                        return;
                    }
                    if (editor.selection.isEmpty) {
                        vscode.window.showWarningMessage('TraceNotes: Select some code to relocate the trace.');
                        return;
                    }
                    traceManager.relocateTrace(msg.id, editor.document, editor.selection);
                    break;
                }
                case 'updateHighlight':
                    traceManager.updateHighlight(msg.id, msg.highlight);
                    break;
                case 'enterGroup':
                    traceManager.enterGroup(msg.id);
                    break;
                case 'exitGroup': {
                    const exitedGroupId = traceManager.getActiveGroupId();
                    traceManager.exitGroup();
                    if (exitedGroupId) {
                        // Defer so the webview re-renders with the parent view first
                        if (focusCardTimer) { clearTimeout(focusCardTimer); }
                        focusCardTimer = setTimeout(() => {
                            provider.postMessage({ type: 'focusCard', id: exitedGroupId });
                            focusCardTimer = undefined;
                        }, 100);
                    }
                    break;
                }
                case 'clearCurrentLevel':
                    traceManager.clearActiveChildren();
                    break;
                case 'exportToMarkdown':
                    vscode.commands.executeCommand('tracenotes.exportMarkdown');
                    break;
                case 'importTrace':
                    vscode.commands.executeCommand('tracenotes.importTrace');
                    break;
                case 'renameTree':
                    traceManager.renameActiveTree(msg.name);
                    break;
                case 'createTree':
                    traceManager.createTree(msg.name);
                    break;
                case 'switchTree':
                    traceManager.switchTree(msg.id);
                    break;
                case 'deleteTree':
                    traceManager.deleteTree(msg.id);
                    break;
                case 'addEmptyTrace':
                    traceManager.addEmptyTrace();
                    break;
                case 'moveToChild':
                    traceManager.moveToChild(msg.traceId, msg.targetId);
                    break;
                case 'moveToParent':
                    traceManager.moveToParent(msg.traceId);
                    break;
            }
        },
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(StoryboardProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    // Command: Collect Trace
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.collectTrace', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('TraceNotes: No active editor.');
                return;
            }

            // Wait for disk load to finish before writing, preventing the
            // initialization race condition that would silently discard the trace.
            await traceManager.ensureReady();

            const trace = collectTrace(editor);
            if (trace) {
                traceManager.add(trace);

                // Show the sidebar view (preserve focus if already open)
                if (provider._view) {
                    provider._view.show(true);
                } else {
                    vscode.commands.executeCommand('tracenotes.storyboard.focus');
                }

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
            await traceManager.ensureReady();

            const traces = traceManager.getAll();
            if (traces.length === 0) {
                vscode.window.showWarningMessage('TraceNotes: No traces to export.');
                return;
            }
            const md = generateMarkdown(traces);

            const treeData = traceManager.getActiveTreeData();
            const fileName = treeData ? `${treeData.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md` : 'tracenotes.md';

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(fileName),
                filters: { 'Markdown': ['md'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(md));
                await vscode.window.showTextDocument(uri);
            }
        }),
    );

    // Command: Import Trace
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.importTrace', async () => {
            await traceManager.ensureReady();

            const options: vscode.OpenDialogOptions = {
                canSelectMany: false, // User can only select one file
                openLabel: 'Import',
                filters: {
                    'Markdown Files': ['md'],
                    'All Files': ['*']
                }
            };

            const fileUri = await vscode.window.showOpenDialog(options);

            if (fileUri && fileUri[0]) {
                try {
                    const fileData = await vscode.workspace.fs.readFile(fileUri[0]);
                    const markdown = new TextDecoder().decode(fileData);

                    // Extract filename without extension
                    const fileName = fileUri[0].path.split('/').pop()?.replace(/\.md$/i, '') || 'Imported Trace';

                    await traceManager.importTraceTree(markdown, fileName);
                    vscode.window.showInformationMessage('TraceNotes: Trace tree imported successfully!');
                } catch (e) {
                    vscode.window.showErrorMessage(`TraceNotes: Failed to import trace tree. ${e}`);
                }
            }
        }),
    );

    // Command: Clear All
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.clearAll', async () => {
            await traceManager.ensureReady();
            traceManager.clear();
            vscode.window.showInformationMessage('TraceNotes: All traces cleared.');
        }),
    );

    // Re-render decorations when the user switches editor tabs
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
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
                    updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
                }, 100);
            }
        }),
    );

    // --- Reverse sync: cursor position → sidebar card ---
    let lastFocusedTraceId: string | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let syncDebounce: ReturnType<typeof setTimeout> | undefined;
    let pendingFocusId: string | undefined;

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
        traceManager.onDidChangeTraces((eventPayload) => {
            for (const editor of vscode.window.visibleTextEditors) {
                updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
            }
            // Extract optional focusId carried by addEmptyTrace
            const focusId = (eventPayload && typeof eventPayload === 'object' && 'focusId' in eventPayload)
                ? eventPayload.focusId
                : undefined;
            if (focusId) {
                pendingFocusId = focusId;
            }

            // Sync with webview (Debounced to prevent flooding during rapid typing/validation)
            if (syncDebounce) { clearTimeout(syncDebounce); }
            syncDebounce = setTimeout(() => {
                const payload = { ...traceManager.getWorkspaceSyncPayload(), focusId: pendingFocusId };
                provider.postMessage({ type: 'syncWorkspace', payload });
                pendingFocusId = undefined; // Reset after sending
            }, 50);
        })
    );

    // Dispose all pending timers on deactivation
    context.subscriptions.push({
        dispose: () => {
            if (focusCardTimer) { clearTimeout(focusCardTimer); }
            if (decorationDebounce) { clearTimeout(decorationDebounce); }
            if (debounceTimer) { clearTimeout(debounceTimer); }
            if (syncDebounce) { clearTimeout(syncDebounce); }
            pendingFocusId = undefined;
        },
    });

    // Paint decorations for the already-open editor on activation
    refreshDecorations();
}

/**
 * VS Code allows `deactivate` to return a Promise, giving up to ~5 s for
 * background tasks to complete. We use this window to flush any pending
 * debounced save so data is never lost when the window closes mid-debounce.
 */
export async function deactivate(): Promise<void> {
    if (_traceManagerRef) {
        await _traceManagerRef.flush();
    }
}
