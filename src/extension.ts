import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
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
                case 'jumpToGroup': {
                    traceManager.jumpToGroup(msg.groupId);
                    if (msg.focusId) {
                        if (focusCardTimer) { clearTimeout(focusCardTimer); }
                        focusCardTimer = setTimeout(() => {
                            provider.postMessage({ type: 'focusCard', id: msg.focusId });
                            focusCardTimer = undefined;
                        }, 100);
                    }
                    break;
                }
                case 'exportToMarkdown':
                    vscode.commands.executeCommand('tracenotes.exportMarkdown');
                    break;
                case 'importTrace':
                    vscode.commands.executeCommand('tracenotes.importTrace');
                    break;
                case 'exportAllData':
                    vscode.commands.executeCommand('tracenotes.exportData');
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
                case 'navigateToTrace': {
                    traceManager.switchTree(msg.treeId);
                    if (msg.groupId !== null) {
                        traceManager.jumpToGroup(msg.groupId);
                    }
                    if (msg.focusId) {
                        if (focusCardTimer) { clearTimeout(focusCardTimer); }
                        focusCardTimer = setTimeout(() => {
                            provider.postMessage({ type: 'focusCard', id: msg.focusId });
                            focusCardTimer = undefined;
                        }, 100);
                    }
                    break;
                }
                case 'requestAllTrees':
                    provider.postMessage({
                        type: 'allTreesData',
                        payload: { trees: traceManager.getSearchableTrees() },
                    });
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
                if (focusCardTimer) { clearTimeout(focusCardTimer); }
                focusCardTimer = setTimeout(() => {
                    provider.postMessage({ type: 'focusCard', id: trace.id });
                    focusCardTimer = undefined;
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
            const fileName = treeData ? `${treeData.name.replace(/[^\p{L}\p{N}\s\-]/gu, '_').replace(/\s+/g, ' ').trim()}.md` : 'tracenotes.md';

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

    // Command: Import Trace (Markdown or data.json)
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.importTrace', async () => {
            await traceManager.ensureReady();

            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Import',
                filters: {
                    'TraceNotes Files': ['md', 'json'],
                    'Markdown Files': ['md'],
                    'JSON Files': ['json'],
                }
            });

            if (!fileUris || !fileUris[0]) { return; }

            try {
                const fileData = await vscode.workspace.fs.readFile(fileUris[0]);
                const text = new TextDecoder().decode(fileData);
                const filePath = fileUris[0].path;

                if (filePath.toLowerCase().endsWith('.json')) {
                    const parsed = JSON.parse(text);
                    if (!Array.isArray(parsed) || !parsed.every((t: unknown) => typeof (t as any).id === 'string' && Array.isArray((t as any).traces))) {
                        throw new Error('Invalid format: expected an array of trace trees with string IDs and traces arrays.');
                    }
                    await traceManager.importAllTrees(parsed);
                    vscode.window.showInformationMessage(`TraceNotes: Imported ${parsed.length} tree(s) from JSON.`);
                } else {
                    const fileName = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'Imported Trace';
                    await traceManager.importTraceTree(text, fileName);
                    vscode.window.showInformationMessage('TraceNotes: Trace tree imported successfully!');
                }
            } catch (e) {
                vscode.window.showErrorMessage(`TraceNotes: Failed to import. ${e}`);
            }
        }),
    );

    // Command: Export all trace trees to data.json
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.exportData', async () => {
            await traceManager.ensureReady();

            const trees = traceManager.getAllTrees();
            if (trees.length === 0) {
                vscode.window.showWarningMessage('TraceNotes: No trace trees to export.');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: workspaceRoot
                    ? vscode.Uri.joinPath(workspaceRoot, 'tracenotes-data.json')
                    : vscode.Uri.file(path.join(os.homedir(), 'tracenotes-data.json')),
                filters: { 'JSON': ['json'] }
            });

            if (uri) {
                await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(trees, null, 2)));
                vscode.window.showInformationMessage(`TraceNotes: Exported ${trees.length} tree(s) to ${uri.fsPath.split('/').pop()}.`);
            }
        }),
    );

    // Command: Jump to Trace Card from Faded Gutter Decoration
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.jumpToFadedTrace', (traceId: string) => {
            const parentGroupId = traceManager.getParentGroupId(traceId);
            provider.postMessage({
                type: 'jumpToFadedTrace',
                groupId: parentGroupId,
                focusId: traceId,
            });
        })
    );

    // Command: Clear All
    context.subscriptions.push(
        vscode.commands.registerCommand('tracenotes.clearAll', async () => {
            await traceManager.ensureReady();
            traceManager.clear();
            vscode.window.showInformationMessage('TraceNotes: All traces cleared.');
        }),
    );

    // Re-render decorations when the user switches editor tabs.
    // Also re-validate the file's traces on-demand: edits made outside a live
    // onDidChangeTextDocument stream (git checkout, external edits, reload) never
    // enqueue the debounced validation pass, so a stale lineRange/orphan flag would
    // otherwise persist forever until the user happens to type in that file.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) return;
            updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
            traceManager.ensureReady()
                .then(() => traceManager.validateDocumentNow(editor.document))
                .catch((err) => console.error('TraceNotes: on-demand validation failed', err));
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

                const fileTraces = traceManager.getTracesForFile(currentFilePath);
                if (fileTraces.length === 0) {
                    if (lastFocusedTraceId !== undefined) {
                        lastFocusedTraceId = undefined;
                        provider._view?.webview.postMessage({ type: 'focusCard', id: null });
                    }
                    return;
                }
                const activeChildrenIds = new Set(traceManager.getActiveChildren().map(t => t.id));
                const cursorOffset = editor.document.offsetAt(position);
                const matched = fileTraces.find(t => {
                    if (!activeChildrenIds.has(t.id)) { return false; }
                    if (t.rangeOffset) {
                        return cursorOffset >= t.rangeOffset[0] && cursorOffset <= t.rangeOffset[1];
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
            // Shares decorationDebounce with onDidChangeTextDocument (100 ms); this 50 ms
            // timeout coalesces burst repaints from validation and takes precedence when both fire.
            if (decorationDebounce) { clearTimeout(decorationDebounce); }
            decorationDebounce = setTimeout(() => {
                for (const editor of vscode.window.visibleTextEditors) {
                    updateDecorations(editor, traceManager.getActiveChildren(), traceManager.getTracesForFile(editor.document.uri.fsPath));
                }
            }, 50);

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

    // Paint decorations for the already-open editor on activation, and run an
    // on-demand validation pass over all currently visible editors. This catches
    // drift introduced while VS Code was closed (git checkout, external edits)
    // that would otherwise never trigger the edit-event-driven validation queue.
    refreshDecorations();
    traceManager.ensureReady()
        .then(() => Promise.all(
            vscode.window.visibleTextEditors.map((editor) => traceManager.validateDocumentNow(editor.document)),
        ))
        .catch((err) => console.error('TraceNotes: startup validation failed', err));
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
