import { describe, it, expect } from 'vitest';
import { handleListEnter, handleListIndent } from './listEditing';

// Helper: place the caret with a `|` marker, run the op, and render the result
// back with `|` so expectations read like what the user would see.
function withCaret(text: string) {
    const start = text.indexOf('|');
    const rest = text.slice(0, start) + text.slice(start + 1);
    const end = rest.indexOf('|');
    if (end === -1) {
        return { value: rest, start, end: start };
    }
    return { value: rest.slice(0, end) + rest.slice(end + 1), start, end };
}

function render(value: string, selStart: number, selEnd: number) {
    if (selStart === selEnd) {
        return value.slice(0, selStart) + '|' + value.slice(selStart);
    }
    return value.slice(0, selStart) + '|' + value.slice(selStart, selEnd) + '|' + value.slice(selEnd);
}

describe('handleListEnter', () => {
    it('continues a bullet list', () => {
        const { value, start, end } = withCaret('- one|');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- one\n- |');
    });

    it('supports * and + markers', () => {
        const a = withCaret('* a|');
        expect(handleListEnter(a.value, a.start, a.end)!.value).toBe('* a\n* ');
        const b = withCaret('+ a|');
        expect(handleListEnter(b.value, b.start, b.end)!.value).toBe('+ a\n+ ');
    });

    it('increments ordered list numbers', () => {
        const { value, start, end } = withCaret('1. first|');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('1. first\n2. |');
    });

    it('supports ordered markers with a paren', () => {
        const { value, start, end } = withCaret('3) third|');
        expect(handleListEnter(value, start, end)!.value).toBe('3) third\n4) ');
    });

    it('carries indentation onto the next item', () => {
        const { value, start, end } = withCaret('  - nested|');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('  - nested\n  - |');
    });

    it('resets a checkbox to unchecked on the new line', () => {
        const { value, start, end } = withCaret('- [x] done|');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- [x] done\n- [ ] |');
    });

    it('exits the list when Enter is pressed on an empty item', () => {
        const { value, start, end } = withCaret('- one\n- |');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- one\n|');
    });

    it('outdents one level before exiting a nested empty item', () => {
        const { value, start, end } = withCaret('- a\n  - |');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- a\n|');
    });

    it('returns null for a non-list line', () => {
        const { value, start, end } = withCaret('plain text|');
        expect(handleListEnter(value, start, end)).toBeNull();
    });

    it('returns null for a ranged selection', () => {
        const { value, start, end } = withCaret('- |one|');
        expect(handleListEnter(value, start, end)).toBeNull();
    });

    it('splits content when the caret is mid-line', () => {
        const { value, start, end } = withCaret('- he|llo');
        const r = handleListEnter(value, start, end)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- he\n- |llo');
    });
});

describe('handleListIndent', () => {
    it('indents the current line', () => {
        const { value, start, end } = withCaret('- a|');
        const r = handleListIndent(value, start, end, false)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('  - a|');
    });

    it('outdents the current line', () => {
        const { value, start, end } = withCaret('  - a|');
        const r = handleListIndent(value, start, end, true)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- a|');
    });

    it('removes a leading tab on outdent', () => {
        const { value, start, end } = withCaret('\t- a|');
        const r = handleListIndent(value, start, end, true)!;
        expect(r.value).toBe('- a');
    });

    it('returns null when there is nothing to outdent', () => {
        const { value, start, end } = withCaret('- a|');
        expect(handleListIndent(value, start, end, true)).toBeNull();
    });

    it('indents every line spanned by the selection', () => {
        const { value, start, end } = withCaret('- a|\n- b|');
        const r = handleListIndent(value, start, end, false)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('  - a|\n  - b|');
    });

    it('outdents every line spanned by the selection', () => {
        const { value, start, end } = withCaret('  - a|\n  - b|');
        const r = handleListIndent(value, start, end, true)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('- a|\n- b|');
    });

    it('keeps a caret at the line start glued to the content on indent', () => {
        const { value, start, end } = withCaret('|- a');
        const r = handleListIndent(value, start, end, false)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('  |- a');
    });

    it('returns null when indenting a non-list line so Tab can move focus', () => {
        const { value, start, end } = withCaret('plain text|');
        expect(handleListIndent(value, start, end, false)).toBeNull();
    });

    it('indents a list block even when a spanned line is plain text', () => {
        const { value, start, end } = withCaret('- a|\ncontinuation|');
        const r = handleListIndent(value, start, end, false)!;
        expect(render(r.value, r.selectionStart, r.selectionEnd)).toBe('  - a|\n  continuation|');
    });
});
