// Pure helpers for toggling inline markdown formatting inside a plain
// <textarea>. Like the list helpers, they take the text plus the selection
// (start/end caret offsets) and return the next text and where the selection
// should land. Keeping them pure makes them easy to unit-test without a DOM.

import type { EditResult } from './listEditing';

const BOLD = '**';

/**
 * Toggle bold (`**`) around the current selection, mirroring Cmd/Ctrl+B in
 * editors like Obsidian:
 *
 * - Selection already wrapped (markers inside or just outside the selection):
 *   strip the markers, leaving the inner text selected.
 * - Selection without markers: wrap it in `**`, keeping the inner text selected.
 * - No selection: insert an empty `****` and drop the caret between the markers
 *   so the user can type bold text straight away.
 */
export function toggleBold(value: string, start: number, end: number): EditResult {
    const selected = value.slice(start, end);

    // Markers are part of the selection (e.g. user selected "**word**").
    if (selected.startsWith(BOLD) && selected.endsWith(BOLD) && selected.length >= BOLD.length * 2) {
        const inner = selected.slice(BOLD.length, -BOLD.length);
        const newValue = value.slice(0, start) + inner + value.slice(end);
        return { value: newValue, selectionStart: start, selectionEnd: start + inner.length };
    }

    // Markers sit just outside the selection (e.g. "word" selected within "**word**").
    if (value.slice(start - BOLD.length, start) === BOLD && value.slice(end, end + BOLD.length) === BOLD) {
        const newValue = value.slice(0, start - BOLD.length) + selected + value.slice(end + BOLD.length);
        return { value: newValue, selectionStart: start - BOLD.length, selectionEnd: end - BOLD.length };
    }

    // Otherwise wrap the selection (or insert empty markers when it's collapsed).
    const newValue = value.slice(0, start) + BOLD + selected + BOLD + value.slice(end);
    return { value: newValue, selectionStart: start + BOLD.length, selectionEnd: end + BOLD.length };
}

/**
 * Characters that, when typed over a non-empty selection, wrap the selection in
 * a matching pair instead of replacing it — mirroring Obsidian/typical editors.
 * Symmetric markers (`*`, `` ` ``, ...) map to themselves; brackets/quotes map to
 * their closing partner.
 */
export const WRAP_PAIRS: Record<string, string> = {
    '*': '*',
    '_': '_',
    '`': '`',
    '~': '~',
    '(': ')',
    '[': ']',
    '{': '}',
    '"': '"',
    "'": "'",
};

/**
 * Wrap the current selection with `open`/`close`, leaving the original (inner)
 * text selected. Because the inner text stays selected, pressing the same key
 * again stacks another layer — so `*` twice yields `**…**` (bold) and `` ` ``
 * three times yields ```` ```…``` ```` — matching how Obsidian wraps selections.
 */
export function wrapSelection(value: string, start: number, end: number, open: string, close: string): EditResult {
    const selected = value.slice(start, end);
    const newValue = value.slice(0, start) + open + selected + close + value.slice(end);
    return { value: newValue, selectionStart: start + open.length, selectionEnd: end + open.length };
}
