import { visit, SKIP } from 'unist-util-visit';
import type { Root, Text, Break, PhrasingContent } from 'mdast';

/**
 * Remark plugin: render a single newline as a hard line break.
 *
 * mdast keeps a soft line break (one `\n` inside a paragraph) as a newline
 * character inside a `text` node, and react-markdown collapses it to a space —
 * so a single Enter in a note appears to do nothing. This splits such text
 * nodes on newlines and inserts `break` nodes between the parts, so one Enter
 * shows as a real line break without needing a blank line.
 */
export function remarkLineBreaks() {
    return (tree: Root): void => {
        visit(tree, 'text', (node: Text, index, parent) => {
            if (parent == null || index == null || !node.value.includes('\n')) {
                return;
            }

            const segments = node.value.split('\n');
            const replacement: PhrasingContent[] = [];
            segments.forEach((segment, i) => {
                if (i > 0) {
                    replacement.push({ type: 'break' } as Break);
                }
                if (segment.length > 0) {
                    replacement.push({ type: 'text', value: segment } as Text);
                }
            });

            parent.children.splice(index, 1, ...(replacement as typeof parent.children));
            // Skip the nodes we just inserted; they have no more newlines.
            return [SKIP, index + replacement.length];
        });
    };
}
