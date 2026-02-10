import * as vscode from 'vscode';

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

        const range = new vscode.Range(message.range[0], 0, message.range[1], 0);

        // Scroll to center
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        // Set selection
        editor.selection = new vscode.Selection(range.start, range.end);

        // Flash effect (500ms)
        const flashDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 200, 50, 0.25)',
            isWholeLine: true,
        });
        editor.setDecorations(flashDecoration, [range]);
        setTimeout(() => flashDecoration.dispose(), 500);
    } catch {
        vscode.window.showErrorMessage(
            `MindStack: Could not open file "${message.filePath}". It may have been moved or deleted.`
        );
    }
}
