import * as vscode from 'vscode';
import { TracePoint } from './types';

function generateUUID(): string {
    // Simple UUID v4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Collect a trace from the current editor selection.
 * Applies smart dedent to remove excess leading whitespace.
 */
export function collectTrace(editor: vscode.TextEditor): TracePoint | null {
    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showWarningMessage('TraceNotes: Please select some code first.');
        return null;
    }

    const text = editor.document.getText(selection);
    const filePath = editor.document.uri.fsPath;

    // Smart dedent algorithm
    const lines = text.split('\n');
    const minIndent = lines.reduce((min, line) => {
        if (line.trim().length === 0) { return min; }
        const match = line.match(/^\s*/);
        const indent = match ? match[0].length : 0;
        return indent < min ? indent : min;
    }, Infinity);

    const effectiveIndent = minIndent === Infinity ? 0 : minIndent;
    const cleanContent = lines
        .map(line => (line.length >= effectiveIndent ? line.slice(effectiveIndent) : line))
        .join('\n');

    return {
        id: generateUUID(),
        filePath,
        lineRange: [selection.start.line, selection.end.line],
        content: cleanContent,
        lang: editor.document.languageId,
        note: '',
        timestamp: Date.now(),
    };
}
