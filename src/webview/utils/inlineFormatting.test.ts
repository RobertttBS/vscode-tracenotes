import { describe, it, expect } from 'vitest';
import { toggleBold, wrapSelection, WRAP_PAIRS } from './inlineFormatting';

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

describe('wrapSelection', () => {
    it('wraps a selection in a symmetric marker and keeps the inner text selected', () => {
        const r = wrapSelection('hello world', 6, 11, '`', '`');
        expect(r.value).toBe('hello `world`');
        expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('world');
    });

    it('wraps with a bracket pair', () => {
        const r = wrapSelection('see foo here', 4, 7, '(', ')');
        expect(r.value).toBe('see (foo) here');
        expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('foo');
    });

    it('stacks when applied repeatedly because the inner text stays selected', () => {
        const once = wrapSelection('a x b', 2, 3, '*', '*');
        expect(once.value).toBe('a *x* b');
        const twice = wrapSelection(once.value, once.selectionStart, once.selectionEnd, '*', '*');
        expect(twice.value).toBe('a **x** b');
        expect(twice.value.slice(twice.selectionStart, twice.selectionEnd)).toBe('x');
        const thrice = wrapSelection(twice.value, twice.selectionStart, twice.selectionEnd, '`', '`');
        expect(thrice.value).toBe('a **`x`** b');
    });

    it('exposes the expected wrap pairs', () => {
        expect(WRAP_PAIRS['*']).toBe('*');
        expect(WRAP_PAIRS['`']).toBe('`');
        expect(WRAP_PAIRS['(']).toBe(')');
        expect(WRAP_PAIRS['[']).toBe(']');
        expect(WRAP_PAIRS['{']).toBe('}');
        expect(WRAP_PAIRS['"']).toBe('"');
    });
});
