import { describe, it, expect } from 'vitest';
import { toggleBold } from './inlineFormatting';

describe('toggleBold', () => {
    it('wraps a selection in ** and keeps the inner text selected', () => {
        const r = toggleBold('hello world', 6, 11);
        expect(r.value).toBe('hello **world**');
        expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('world');
    });

    it('inserts empty markers and parks the caret between them', () => {
        const r = toggleBold('hello ', 6, 6);
        expect(r.value).toBe('hello ****');
        expect(r.selectionStart).toBe(8);
        expect(r.selectionEnd).toBe(8);
    });

    it('unwraps when the markers are inside the selection', () => {
        const r = toggleBold('hello **world**', 6, 15);
        expect(r.value).toBe('hello world');
        expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('world');
    });

    it('unwraps when the markers sit just outside the selection', () => {
        const r = toggleBold('hello **world**', 8, 13);
        expect(r.value).toBe('hello world');
        expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('world');
    });
});
