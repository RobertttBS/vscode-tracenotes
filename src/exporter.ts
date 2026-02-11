import { TracePoint } from './types';

/**
 * Generate a Markdown document from the collected traces.
 * Recursively renders children with increasing heading depth.
 */
export function generateMarkdown(traces: TracePoint[]): string {
    let md = `# Trace Result - ${new Date().toISOString().split('T')[0]}\n\n`;

    traces.forEach((t, index) => {
        md += renderTrace(t, index, 0);
        if (index < traces.length - 1) {
            md += '---\n\n';
        }
    });

    return md;
}

function renderTrace(t: TracePoint, index: number, depth: number): string {
    // Root = ###, child = ####, grandchild = #####
    const heading = '#'.repeat(depth + 3);
    const fileName = t.filePath.split('/').pop() ?? t.filePath;

    let md = `${heading} ${index + 1}. ${fileName}:${t.lineRange[0] + 1}\n\n`;
    if (t.note) {
        md += `> **Note:** ${t.note}\n\n`;
    }
    md += '```' + t.lang + '\n';
    md += t.content + '\n';
    md += '```\n\n';

    if (t.children?.length) {
        t.children.forEach((child, i) => {
            md += renderTrace(child, i, depth + 1);
        });
    }

    return md;
}
