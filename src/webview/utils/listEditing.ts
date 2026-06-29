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
 * Indent prepends two spaces; outdent removes a leading tab or up to two
 * spaces. Returns `null` only when an outdent would change nothing.
 */
export function handleListIndent(
    value: string,
    start: number,
    end: number,
    outdent: boolean,
): EditResult | null {
    const blockStart = value.lastIndexOf('\n', start - 1) + 1;
    const nl = value.indexOf('\n', end > start ? end - 1 : end);
    const blockEnd = nl === -1 ? value.length : nl;

    const lines = value.slice(blockStart, blockEnd).split('\n');

    // Each entry records a single-line edit applied at the line's start offset:
    // a positive `change` inserts that many chars, a negative one removes them.
    const edits: { lineStart: number; change: number }[] = [];
    let changed = false;
    let pos = blockStart;

    const newLines = lines.map((line) => {
        const lineStart = pos;
        pos += line.length + 1; // account for the newline that split() dropped

        if (!outdent) {
            changed = true;
            edits.push({ lineStart, change: INDENT.length });
            return INDENT + line;
        }

        const m = /^(\t| {1,2})/.exec(line);
        const remove = m ? m[0].length : 0;
        if (remove > 0) {
            changed = true;
            edits.push({ lineStart, change: -remove });
        }
        return remove > 0 ? line.slice(remove) : line;
    });

    if (!changed) { return null; }

    // Remap a caret offset through every line edit. Inserts before/at the caret
    // push it right; removals before it pull it left, clamped so a caret inside
    // the removed run lands at the line start.
    const remap = (p: number): number => {
        let shift = 0;
        for (const { lineStart, change } of edits) {
            if (change > 0) {
                if (lineStart <= p) { shift += change; }
            } else {
                const removeEnd = lineStart - change; // lineStart + |change|
                if (p >= removeEnd) { shift += change; }
                else if (p > lineStart) { shift += lineStart - p; }
            }
        }
        return p + shift;
    };

    const newValue = value.slice(0, blockStart) + newLines.join('\n') + value.slice(blockEnd);
    return {
        value: newValue,
        selectionStart: remap(start),
        selectionEnd: remap(end),
    };
}
