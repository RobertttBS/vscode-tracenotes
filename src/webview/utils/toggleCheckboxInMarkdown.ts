import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

// Same parsing pipeline react-markdown uses, so the task-list items we find
// here line up 1:1 (in document order) with the checkboxes it renders.
const processor = unified().use(remarkParse).use(remarkGfm);

/**
 * Toggle the n-th GFM task-list checkbox (`- [ ]` / `- [x]`) in the raw
 * markdown. `index` is the document-order position of the checkbox as rendered
 * by react-markdown. Lines that merely look like task items (e.g. inside fenced
 * code blocks) are ignored because we walk the real AST instead of regex-
 * matching every line.
 */
export function toggleCheckboxInMarkdown(text: string, index: number): string {
    const tree = processor.parse(text);

    const offsets: number[] = [];
    visit(tree, 'listItem', (node) => {
        if (typeof node.checked === 'boolean' && node.position?.start.offset != null) {
            offsets.push(node.position.start.offset);
        }
    });

    if (index < 0 || index >= offsets.length) {
        return text;
    }

    // The checkbox is the first `[ ]` / `[x]` after the list marker.
    const rel = text.slice(offsets[index]).search(/\[[ xX]\]/);
    if (rel === -1) {
        return text;
    }

    const statePos = offsets[index] + rel + 1;
    const next = text[statePos] === ' ' ? 'x' : ' ';
    return text.slice(0, statePos) + next + text.slice(statePos + 1);
}
