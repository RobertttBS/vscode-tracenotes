import * as vscode from 'vscode';
import { flashDecorationType } from './decorationManager';

let flashTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Jump to a file/line range, select it, and briefly flash highlight.
 */
export async function handleJump(message: { filePath: string; range: [number, number] }): Promise<void> {
    try {
        const doc = await vscode.workspace.openTextDocument(message.filePath);
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
        });

        const endLine = message.range[1];
        const lineContent = doc.lineAt(endLine);
        const range = new vscode.Range(message.range[0], 0, endLine, lineContent.text.length);

        // Scroll to center
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        // Set selection
        editor.selection = new vscode.Selection(range.start, range.end);

        // Flash effect (500ms) — reuse singleton decoration type
        if (flashTimer) { clearTimeout(flashTimer); }
        editor.setDecorations(flashDecorationType, [range]);
        flashTimer = setTimeout(() => {
            editor.setDecorations(flashDecorationType, []);
            flashTimer = undefined;
        }, 500);
    } catch {
        vscode.window.showErrorMessage(
            `TraceNotes: Could not open file "${message.filePath}". It may have been moved or deleted.`
        );
    }
}
