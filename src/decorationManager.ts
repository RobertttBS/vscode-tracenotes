import * as vscode from 'vscode';
import * as path from 'path';
import { TracePoint } from './types';

function isOverlapping(t1: TracePoint, t2: TracePoint): boolean {
    if (t1.rangeOffset && t2.rangeOffset)
        return t1.rangeOffset[0] < t2.rangeOffset[1] && t2.rangeOffset[0] < t1.rangeOffset[1];
    if (t1.lineRange && t2.lineRange)
        return t1.lineRange[0] <= t2.lineRange[1] && t2.lineRange[0] <= t1.lineRange[1];
    return false;
}

let traceDecorationType: vscode.TextEditorDecorationType;
let fadedDecorationType: vscode.TextEditorDecorationType;
export let flashDecorationType: vscode.TextEditorDecorationType;

let redDecorationType: vscode.TextEditorDecorationType;
let blueDecorationType: vscode.TextEditorDecorationType;
let greenDecorationType: vscode.TextEditorDecorationType;
let orangeDecorationType: vscode.TextEditorDecorationType;
let purpleDecorationType: vscode.TextEditorDecorationType;
let indigoDecorationType: vscode.TextEditorDecorationType;
let brownDecorationType: vscode.TextEditorDecorationType;
let yellowDecorationType: vscode.TextEditorDecorationType;

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
        gutterIconPath: getGutterIconUri('#52525266'), // dark grey
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

    indigoDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#818CF8'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(129, 140, 248, 0.05)',
    });

    brownDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#C8864A'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(200, 134, 74, 0.05)',
    });

    yellowDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: getGutterIconUri('#FFCC00'),
        gutterIconSize: 'contain',
        isWholeLine: true,
        backgroundColor: 'rgba(255, 204, 0, 0.05)',
    });

    context.subscriptions.push(traceDecorationType);
    context.subscriptions.push(fadedDecorationType);
    context.subscriptions.push(flashDecorationType);
    context.subscriptions.push(redDecorationType);
    context.subscriptions.push(blueDecorationType);
    context.subscriptions.push(greenDecorationType);
    context.subscriptions.push(orangeDecorationType);
    context.subscriptions.push(purpleDecorationType);
    context.subscriptions.push(indigoDecorationType);
    context.subscriptions.push(brownDecorationType);
    context.subscriptions.push(yellowDecorationType);
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

    // Filter active traces to those in this file and build a fast-lookup set
    const relevantActive = activeTraces.filter(t => t.filePath === currentFilePath);
    const activeIds = new Set(relevantActive.map(t => t.id));

    // Pre-compute vscode.Range for every relevant trace once
    // (positionAt is relatively expensive; share the result across all uses below)
    type TraceWithRange = { trace: TracePoint; range: vscode.Range };

    const toRange = (trace: TracePoint): vscode.Range | null => {
        if (trace.rangeOffset) {
            return new vscode.Range(
                editor.document.positionAt(trace.rangeOffset[0]),
                editor.document.positionAt(trace.rangeOffset[1]),
            );
        }
        if (trace.lineRange) {
            return new vscode.Range(trace.lineRange[0], 0, trace.lineRange[1], 0);
        }
        return null;
    };

    const activeWithRanges: TraceWithRange[] = [];
    for (const trace of relevantActive) {
        const range = toRange(trace);
        if (range) { activeWithRanges.push({ trace, range }); }
    }

    // allTraces is already scoped to this file (from getTracesForFile); no extra filePath check needed
    const fadedWithRanges: TraceWithRange[] = [];
    for (const trace of allTraces) {
        if (!activeIds.has(trace.id)) {
            const range = toRange(trace);
            if (range) { fadedWithRanges.push({ trace, range }); }
        }
    }

    // Collect active line numbers from pre-computed ranges — no extra positionAt calls
    // We use this to carve active lines out of faded ranges so gutter icons never
    // physically overlap — the only reliable way to guarantee active icons win.
    const activeLineNumbers = new Set<number>();
    for (const { range } of activeWithRanges) {
        for (let ln = range.start.line; ln <= range.end.line; ln++) {
            activeLineNumbers.add(ln);
        }
    }

    // Pre-compute overlaps once: active trace id → faded traces that overlap it
    // Avoids the O(N²) per-trace scan that the old inline allTraces.filter() caused
    const overlapsMap = new Map<string, TracePoint[]>();
    if (fadedWithRanges.length > 0) {
        for (const { trace: activeTrace } of activeWithRanges) {
            const overlaps: TracePoint[] = [];
            for (const { trace: fadedTrace } of fadedWithRanges) {
                if (isOverlapping(activeTrace, fadedTrace)) {
                    overlaps.push(fadedTrace);
                }
            }
            if (overlaps.length > 0) {
                overlapsMap.set(activeTrace.id, overlaps);
            }
        }
    }

    // Group active traces by highlight color — single pass instead of 9 separate filter calls
    const byColor = new Map<TracePoint['highlight'] | 'default', TraceWithRange[]>();
    for (const item of activeWithRanges) {
        const key = item.trace.highlight ?? 'default';
        let arr = byColor.get(key);
        if (!arr) { arr = []; byColor.set(key, arr); }
        arr.push(item);
    }

    // Build decoration options for a pre-grouped color bucket
    const makeOptions = (items: TraceWithRange[]): vscode.DecorationOptions[] =>
        items.map(({ trace, range }) => {
            const hoverMessage = new vscode.MarkdownString(
                `**[Note]:** ${trace.note || '\u00A0\u00A0*(empty)*\u00A0\u00A0'}${trace.orphaned ? ' **(Orphaned)**' : ''}`,
            );
            const overlaps = overlapsMap.get(trace.id);
            if (overlaps?.length) {
                for (const other of overlaps) {
                    const noteText = other.note || '\u00A0\u00A0*(empty)*\u00A0\u00A0';
                    const args = encodeURIComponent(JSON.stringify([other.id]));
                    hoverMessage.appendMarkdown(`\n\n---\n**[Note]:** ${noteText}${other.orphaned ? ' **(Orphaned)**' : ''}  [\u00A0↗ Jump to card](command:tracenotes.jumpToFadedTrace?${args})`);
                }
                hoverMessage.isTrusted = { enabledCommands: ['tracenotes.jumpToFadedTrace'] };
            }
            return { range, hoverMessage };
        });

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
    const fadedDecorations: vscode.DecorationOptions[] = fadedWithRanges.flatMap(({ trace, range }) => {
        const noteText = trace.note || '\u00A0\u00A0*(empty)*\u00A0\u00A0';
        const orphanSuffix = trace.orphaned ? ' **(Orphaned)**' : '';
        const args = encodeURIComponent(JSON.stringify([trace.id]));
        const hoverMessage = new vscode.MarkdownString(
            `**[Note]:** ${noteText}${orphanSuffix}  [\u00A0↗ Jump to card](command:tracenotes.jumpToFadedTrace?${args})`,
        );
        hoverMessage.isTrusted = { enabledCommands: ['tracenotes.jumpToFadedTrace'] };
        return carveOutActiveLines(range, hoverMessage);
    });

    // Apply decorations.
    // Note: setDecorations call order does NOT control gutter icon priority.
    // VS Code determines z-order from the order in which createTextEditorDecorationType()
    // was called at activation time — that order is not configurable after the fact.
    // Gutter conflicts are avoided spatially above: active lines are carved out of faded
    // ranges so no two decoration types ever compete for the same gutter slot.
    const get = (key: TracePoint['highlight'] | 'default') => makeOptions(byColor.get(key) ?? []);

    editor.setDecorations(traceDecorationType,  get('default'));
    editor.setDecorations(redDecorationType,    get('red'));
    editor.setDecorations(blueDecorationType,   get('blue'));
    editor.setDecorations(greenDecorationType,  get('green'));
    editor.setDecorations(orangeDecorationType, get('orange'));
    editor.setDecorations(purpleDecorationType, get('purple'));
    editor.setDecorations(indigoDecorationType, get('indigo'));
    editor.setDecorations(brownDecorationType,  get('brown'));
    editor.setDecorations(yellowDecorationType, get('yellow'));
    editor.setDecorations(fadedDecorationType,  fadedDecorations);
}
