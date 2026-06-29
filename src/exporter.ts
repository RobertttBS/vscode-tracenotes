import * as vscode from 'vscode';
import { TracePoint, HIGHLIGHT_TO_TAG, NOTE_BLOCK_START, NOTE_BLOCK_END } from './types';

/**
 * Generate a Markdown document from the collected traces.
 * Recursively renders children with increasing heading depth.
 */
export function generateMarkdown(traces: TracePoint[]): string {
    let md = `# Trace Result - ${new Date().toISOString().split('T')[0]}\n\n`;

    traces.forEach((t, index) => {
        md += renderTrace(t, index, 0);
    });

    return md;
}

function renderTrace(t: TracePoint, index: number, depth: number): string {
    // Root = ##, child = ###, grandchild = ####
    const heading = '#'.repeat(depth + 2);
    const relativePath = vscode.workspace.asRelativePath(t.filePath, false);
    const startLine = t.lineRange ? t.lineRange[0] + 1 : '?';
    // Display title for the structural heading: the note's first line with any
    // leading heading markers stripped. It's a human-readable summary only — the
    // full note is preserved verbatim in the fenced block below, so import reads
    // the note from there rather than from this title.
    const firstLine = t.note ? t.note.split(/\r?\n/)[0] : '';
    const title = firstLine.replace(/^#+\s*/, '');

    // Encode highlight colour as a %%Tag%% marker in the heading
    const tagStr = (t.highlight && HIGHLIGHT_TO_TAG[t.highlight])
        ? `%%${HIGHLIGHT_TO_TAG[t.highlight]}%% `
        : '';

    let md = `${heading} ${index + 1}. ${tagStr}${title} ${t.orphaned ? '(Orphaned)' : ''}\n\n`;
    if (t.note) {
        // Fence the raw note so any headings / blank lines / `---` it contains
        // round-trip intact and don't collide with the structural headings.
        md += `${NOTE_BLOCK_START}\n${t.note}\n${NOTE_BLOCK_END}\n\n`;
    }
    
    if (t.content.trim()) {
        const endLine = t.lineRange ? t.lineRange[1] + 1 : '?';
        md += '```' + t.lang + ` ${startLine}:${endLine}:${relativePath}` + '\n';
        md += t.content + '\n';
        md += '```\n\n';
    }

    if (t.children?.length) {
        t.children.forEach((child, i) => {
            md += renderTrace(child, i, depth + 1);
        });
    }

    return md;
}
