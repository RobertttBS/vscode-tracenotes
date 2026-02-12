import * as vscode from 'vscode';
import * as path from 'path';
import { TracePoint } from './types';

let traceDecorationType: vscode.TextEditorDecorationType;
let fadedDecorationType: vscode.TextEditorDecorationType;

/** Create the shared decoration types (call once at activation) */
export function initDecorations(context: vscode.ExtensionContext): void {
    traceDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(path.join('resources', 'bookmark.svg')),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(255, 215, 0, 0.1)', // soft gold tint
    });

    fadedDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: context.asAbsolutePath(path.join('resources', 'bookmark-faded.svg')),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(255, 215, 0, 0.03)', // very subtle gold tint
    });
}

/**
 * Re-render gutter icons & line highlights for the given editor.
 * Active-level traces get full styling; all other traces get faded styling.
 */
export function updateDecorations(
    editor: vscode.TextEditor,
    activeTraces: TracePoint[],
    allTraces: TracePoint[],
): void {
    if (!traceDecorationType || !fadedDecorationType) { return; }

    const currentFilePath = editor.document.uri.fsPath;

    // --- Active decorations (current level) ---
    const relevantActive = activeTraces.filter(t => t.filePath === currentFilePath);
    const activeIds = new Set(relevantActive.map(t => t.id));

    const activeDecorations: vscode.DecorationOptions[] = relevantActive.map(trace => ({
        range: new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0),
        hoverMessage: new vscode.MarkdownString(
            `**Note:** ${trace.note || '(No note)'}`,
        ),
    }));

    // --- Faded decorations (all other traces) ---
    const relevantFaded = allTraces.filter(
        t => t.filePath === currentFilePath && !activeIds.has(t.id),
    );

    const fadedDecorations: vscode.DecorationOptions[] = relevantFaded.map(trace => ({
        range: new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0),
        hoverMessage: new vscode.MarkdownString(
            `*(Other level)* **Note:** ${trace.note || '(No note)'}`,
        ),
    }));

    // Apply faded first, then active — active visually overrides on overlapping ranges
    editor.setDecorations(fadedDecorationType, fadedDecorations);
    editor.setDecorations(traceDecorationType, activeDecorations);
}
