import * as vscode from 'vscode';
import * as path from 'path';
import { TracePoint } from './types';

let traceDecorationType: vscode.TextEditorDecorationType;
let fadedDecorationType: vscode.TextEditorDecorationType;
export let flashDecorationType: vscode.TextEditorDecorationType;

let redDecorationType: vscode.TextEditorDecorationType;
let blueDecorationType: vscode.TextEditorDecorationType;
let greenDecorationType: vscode.TextEditorDecorationType;

/** Generate a data URI for the gutter icon with the specified color */
function getGutterIconUri(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M4 2h8a1 1 0 0 1 1 1v11.5a0.5 0.5 0 0 1-0.8 0.4L8 12l-4.2 2.9A0.5 0.5 0 0 1 3 14.5V3a1 1 0 0 1 1-1z" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

/** Create the shared decoration types (call once at activation) */
export function initDecorations(context: vscode.ExtensionContext): void {
    traceDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#AAAAAA'), // light grey
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(200, 200, 200, 0.05)', // subtle grey tint
    });

    fadedDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#666666'), // dark grey
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(100, 100, 100, 0.02)', // very subtle grey tint
    });

    flashDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 50, 0.25)',
        isWholeLine: true,
    });

    // Colored highlights
    redDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#F14C4C'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(241, 76, 76, 0.05)',
    });

    blueDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#3794FF'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(55, 148, 255, 0.05)',
    });

    greenDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#3AD900'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(58, 217, 0, 0.05)',
    });

    context.subscriptions.push(traceDecorationType);
    context.subscriptions.push(fadedDecorationType);
    context.subscriptions.push(flashDecorationType);
    context.subscriptions.push(redDecorationType);
    context.subscriptions.push(blueDecorationType);
    context.subscriptions.push(greenDecorationType);
}

/**
 * Re-render gutter icons & line highlights for the given editor.
 * Active-level traces get full styling (colored if set); all other traces get faded styling.
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

    const getDecorationOptions = (traces: TracePoint[]): vscode.DecorationOptions[] => {
        return traces.map(trace => ({
            range: new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0),
            hoverMessage: new vscode.MarkdownString(
                `**Note:** ${trace.note || '(No note)'}`,
            ),
        }));
    };

    const defaultActive = relevantActive.filter(t => !t.highlight);
    const redActive = relevantActive.filter(t => t.highlight === 'red');
    const blueActive = relevantActive.filter(t => t.highlight === 'blue');
    const greenActive = relevantActive.filter(t => t.highlight === 'green');

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

    // Apply decorations
    editor.setDecorations(fadedDecorationType, fadedDecorations);
    editor.setDecorations(traceDecorationType, getDecorationOptions(defaultActive));
    editor.setDecorations(redDecorationType, getDecorationOptions(redActive));
    editor.setDecorations(blueDecorationType, getDecorationOptions(blueActive));
    editor.setDecorations(greenDecorationType, getDecorationOptions(greenActive));
}
