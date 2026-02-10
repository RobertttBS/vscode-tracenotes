import { TracePoint } from './types';

/**
 * Generate a Markdown document from the collected traces.
 */
export function generateMarkdown(traces: TracePoint[]): string {
    let md = `# Trace Result - ${new Date().toISOString().split('T')[0]}\n\n`;

    traces.forEach((t, index) => {
        const fileName = t.filePath.split('/').pop() ?? t.filePath;
        md += `### ${index + 1}. ${fileName}:${t.lineRange[0] + 1}\n\n`;
        if (t.note) {
            md += `> **Note:** ${t.note}\n\n`;
        }
        md += '```' + t.lang + '\n';
        md += t.content + '\n';
        md += '```\n\n';
        if (index < traces.length - 1) {
            md += '---\n\n';
        }
    });

    return md;
}
