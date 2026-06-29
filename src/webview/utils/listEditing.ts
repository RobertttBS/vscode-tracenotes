// Pure helpers for editing markdown lists inside a plain <textarea>.
//
// They take the current text plus the selection (start/end caret offsets) and
// return the next text and where the caret(s) should land, or `null` when the
// key press should fall through to the textarea's default behaviour. Keeping
// them pure makes them easy to unit-test without a DOM.

export interface EditResult {
    value: string;
    selectionStart: number;
    selectionEnd: number;
}

/** Two spaces per indent level — enough for remark to treat items as nested. */
const INDENT = '  ';

// Leading whitespace, a list marker (`-` / `*` / `+` or `1.` / `1)`), the
// whitespace after it, an optional GFM checkbox, then the item's content.
const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;

interface LineBounds {
    start: number;
    end: number;
}

/** Offsets of the line containing `pos` (end excludes the trailing newline). */
function lineBounds(value: string, pos: number): LineBounds {
    const start = value.lastIndexOf('\n', pos - 1) + 1;
    const nl = value.indexOf('\n', pos);
    const end = nl === -1 ? value.length : nl;
    return { start, end };
}

/** `1.` -> `2.`, `3)` -> `4)`; bullets are returned unchanged. */
function advanceMarker(marker: string): string {
    const m = /^(\d+)([.)])$/.exec(marker);
    return m ? `${parseInt(m[1], 10) + 1}${m[2]}` : marker;
}

/**
 * Enter inside a list item. Continues the list with a fresh marker (ordered
 * numbers are incremented, checkboxes reset to unchecked). Pressing Enter on an
 * empty item exits the list: one indent level is stripped, or the marker is
 * cleared when already at the outer level. Returns `null` for non-list lines or
 * a ranged selection so the textarea handles Enter normally.
 */
export function handleListEnter(value: string, start: number, end: number): EditResult | null {
    if (start !== end) { return null; }

    const { start: ls, end: le } = lineBounds(value, start);
    const line = value.slice(ls, le);
    const m = LIST_ITEM_RE.exec(line);
    if (!m) { return null; }

    const [, indent, marker, spaceAfter, checkbox = '', content] = m;

    // Empty item (marker only): exit the list instead of adding another bullet.
    if (content.trim() === '' && start >= le) {
        if (indent.length > 0) {
            const reduced = indent.slice(0, Math.max(0, indent.length - INDENT.length));
            const newValue = value.slice(0, ls) + reduced + value.slice(le);
            const caret = ls + reduced.length;
            return { value: newValue, selectionStart: caret, selectionEnd: caret };
        }
        const newValue = value.slice(0, ls) + value.slice(le);
        return { value: newValue, selectionStart: ls, selectionEnd: ls };
    }

    const prefix = indent + advanceMarker(marker) + spaceAfter + (checkbox ? '[ ] ' : '');
    const insert = '\n' + prefix;
    const newValue = value.slice(0, start) + insert + value.slice(start);
    const caret = start + insert.length;
    return { value: newValue, selectionStart: caret, selectionEnd: caret };
}

/**
 * Tab / Shift+Tab indents or outdents every line touched by the selection.
 * Indent prepends two spaces; outdent removes a leading tab or up to two spaces.
 *
 * Returns `null` so the key falls through to the textarea's default — which for
 * Tab moves focus, keeping the field from becoming a keyboard trap — when:
 *   - indent and the selection touches no list item, or
 *   - outdent and no line has leading whitespace to remove.
 */
export function handleListIndent(
    value: string,
    start: number,
    end: number,
    outdent: boolean,
): EditResult | null {
    const blockStart = lineBounds(value, start).start;
    const blockEnd = lineBounds(value, end > start ? end - 1 : end).end;
    const lines = value.slice(blockStart, blockEnd).split('\n');

    // Offset of each line's start within `value`, in document order.
    const lineStarts: number[] = [];
    let pos = blockStart;
    for (const line of lines) {
        lineStarts.push(pos);
        pos += line.length + 1; // account for the newline that split() dropped
    }

    let newLines: string[];
    let remap: (p: number) => number;

    if (!outdent) {
        // Only treat Tab as list-indent when the selection actually touches a
        // list item, so plain prose keeps Tab's default behaviour.
        if (!lines.some((line) => LIST_ITEM_RE.test(line))) { return null; }

        // Every line gains a fixed INDENT, so a caret shifts right by INDENT.length
        // for each line start at or before it.
        newLines = lines.map((line) => INDENT + line);
        remap = (p) => p + INDENT.length * lineStarts.filter((ls) => ls <= p).length;
    } else {
        // Outdent removes a leading tab or up to two spaces per line — the amount
        // varies and some lines may not change, so bail when nothing would.
        const removals = lines.map((line) => /^(\t| {1,2})/.exec(line)?.[0].length ?? 0);
        if (removals.every((r) => r === 0)) { return null; }

        newLines = lines.map((line, i) => line.slice(removals[i]));
        // A removal before the caret pulls it left; a caret inside the removed run
        // lands at its line start.
        remap = (p) => {
            let shift = 0;
            removals.forEach((remove, i) => {
                if (remove === 0) { return; }
                const ls = lineStarts[i];
                if (p >= ls + remove) { shift -= remove; }
                else if (p > ls) { shift -= p - ls; }
            });
            return p + shift;
        };
    }

    const newValue = value.slice(0, blockStart) + newLines.join('\n') + value.slice(blockEnd);
    return {
        value: newValue,
        selectionStart: remap(start),
        selectionEnd: remap(end),
    };
}
