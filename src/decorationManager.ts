import * as vscode from 'vscode';
import * as path from 'path';
import { TracePoint } from './types';

let traceDecorationType: vscode.TextEditorDecorationType;
let fadedDecorationType: vscode.TextEditorDecorationType;
export let flashDecorationType: vscode.TextEditorDecorationType;

let redDecorationType: vscode.TextEditorDecorationType;
let blueDecorationType: vscode.TextEditorDecorationType;
let greenDecorationType: vscode.TextEditorDecorationType;
let orangeDecorationType: vscode.TextEditorDecorationType;
let purpleDecorationType: vscode.TextEditorDecorationType;

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
        gutterIconPath: getGutterIconUri('#525252ff'), // dark grey
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

    orangeDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#FF8800'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(255, 136, 0, 0.05)',
    });

    purpleDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#9D00FF'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(157, 0, 255, 0.05)',
    });

    context.subscriptions.push(traceDecorationType);
    context.subscriptions.push(fadedDecorationType);
    context.subscriptions.push(flashDecorationType);
    context.subscriptions.push(redDecorationType);
    context.subscriptions.push(blueDecorationType);
    context.subscriptions.push(greenDecorationType);
    context.subscriptions.push(orangeDecorationType);
    context.subscriptions.push(purpleDecorationType);
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
        return traces.map(trace => {
            let range: vscode.Range;
            if (trace.rangeOffset) {
                const startPos = editor.document.positionAt(trace.rangeOffset[0]);
                const endPos = editor.document.positionAt(trace.rangeOffset[1]);
                range = new vscode.Range(startPos, endPos);
            } else if (trace.lineRange) {
                // Fallback for migration
                range = new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0);
            } else {
                return null;
            }
            
            return {
                range,
                hoverMessage: new vscode.MarkdownString(
                    `**Note:** ${trace.note || '(No note)'}${trace.orphaned ? ' **(Orphaned)**' : ''}`,
                ),
            };
        }).filter(d => d !== null) as vscode.DecorationOptions[];
    };

    const defaultActive = relevantActive.filter(t => !t.highlight);
    const redActive = relevantActive.filter(t => t.highlight === 'red');
    const blueActive = relevantActive.filter(t => t.highlight === 'blue');
    const greenActive = relevantActive.filter(t => t.highlight === 'green');
    const orangeActive = relevantActive.filter(t => t.highlight === 'orange');
    const purpleActive = relevantActive.filter(t => t.highlight === 'purple');

    // --- Collect the set of line numbers already covered by active traces ---
    // We use this to carve active lines out of faded ranges so gutter icons never
    // physically overlap — the only reliable way to guarantee active icons win.
    const activeLineNumbers = new Set<number>();
    for (const trace of relevantActive) {
        let startLine: number;
        let endLine: number;
        if (trace.rangeOffset) {
            startLine = editor.document.positionAt(trace.rangeOffset[0]).line;
            endLine   = editor.document.positionAt(trace.rangeOffset[1]).line;
        } else if (trace.lineRange) {
            startLine = trace.lineRange[0];
            endLine   = trace.lineRange[1];
        } else {
            continue;
        }
        for (let ln = startLine; ln <= endLine; ln++) {
            activeLineNumbers.add(ln);
        }
    }

    /**
     * Split a range into sub-ranges that skip any line in `activeLineNumbers`.
     * Returns zero or more non-overlapping ranges covering the same lines minus
     * the active ones.
     */
    function carveOutActiveLines(
        fullRange: vscode.Range,
        hoverMessage: vscode.MarkdownString,
    ): vscode.DecorationOptions[] {
        const results: vscode.DecorationOptions[] = [];
        let segStart: number | null = null;

        for (let ln = fullRange.start.line; ln <= fullRange.end.line; ln++) {
            if (!activeLineNumbers.has(ln)) {
                // This line is free — start or continue a segment.
                if (segStart === null) { segStart = ln; }
            } else {
                // Active line — flush any open segment before it.
                if (segStart !== null) {
                    results.push({
                        range: new vscode.Range(segStart, 0, ln - 1, 0),
                        hoverMessage,
                    });
                    segStart = null;
                }
            }
        }
        // Flush trailing segment.
        if (segStart !== null) {
            results.push({
                range: new vscode.Range(segStart, 0, fullRange.end.line, 0),
                hoverMessage,
            });
        }
        return results;
    }

    // --- Faded decorations (all other traces, with active lines carved out) ---
    const relevantFaded = allTraces.filter(
        t => t.filePath === currentFilePath && !activeIds.has(t.id),
    );

    const fadedDecorations: vscode.DecorationOptions[] = relevantFaded.flatMap(trace => {
        let range: vscode.Range;
        if (trace.rangeOffset) {
            const startPos = editor.document.positionAt(trace.rangeOffset[0]);
            const endPos   = editor.document.positionAt(trace.rangeOffset[1]);
            range = new vscode.Range(startPos, endPos);
        } else if (trace.lineRange) {
            range = new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0);
        } else {
            return [];
        }

        const hoverMessage = new vscode.MarkdownString(
            `*(Other level)* **Note:** ${trace.note || '(No note)'}${trace.orphaned ? ' **(Orphaned)**' : ''}`,
        );
        return carveOutActiveLines(range, hoverMessage);
    });

    // Apply decorations.
    // Note: setDecorations call order does NOT control gutter icon priority.
    // VS Code determines z-order from the order in which createTextEditorDecorationType()
    // was called at activation time — that order is not configurable after the fact.
    // Gutter conflicts are avoided spatially above: active lines are carved out of faded
    // ranges so no two decoration types ever compete for the same gutter slot.
    editor.setDecorations(traceDecorationType, getDecorationOptions(defaultActive));
    editor.setDecorations(redDecorationType, getDecorationOptions(redActive));
    editor.setDecorations(blueDecorationType, getDecorationOptions(blueActive));
    editor.setDecorations(greenDecorationType, getDecorationOptions(greenActive));
    editor.setDecorations(orangeDecorationType, getDecorationOptions(orangeActive));
    editor.setDecorations(purpleDecorationType, getDecorationOptions(purpleActive));
    editor.setDecorations(fadedDecorationType, fadedDecorations);
}
