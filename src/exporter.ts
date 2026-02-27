import * as vscode from 'vscode';
import { TracePoint, HIGHLIGHT_TO_TAG } from './types';

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
    const title = t.note ? t.note.split(/\r?\n/)[0] : '';

    // Encode highlight colour as a %%Tag%% marker in the heading
    const tagStr = (t.highlight && HIGHLIGHT_TO_TAG[t.highlight])
        ? `%%${HIGHLIGHT_TO_TAG[t.highlight]}%% `
        : '';

    let md = `${heading} ${index + 1}. ${tagStr}${title} ${t.orphaned ? '(Orphaned)' : ''}\n\n`;
    if (t.note) {
        const rest = t.note.split(/\r?\n/).slice(1).join('\n').trim();
        if (rest) {
            md += `${rest}\n\n`;
        }
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
