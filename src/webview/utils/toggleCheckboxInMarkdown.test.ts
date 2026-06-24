import { describe, it, expect } from 'vitest';
import { toggleCheckboxInMarkdown } from './toggleCheckboxInMarkdown';

describe('toggleCheckboxInMarkdown', () => {
    it('toggles an unchecked box to checked', () => {
        expect(toggleCheckboxInMarkdown('- [ ] task', 0)).toBe('- [x] task');
    });

    it('toggles a checked box back to unchecked', () => {
        expect(toggleCheckboxInMarkdown('- [x] task', 0)).toBe('- [ ] task');
    });

    it('toggles uppercase X to unchecked', () => {
        expect(toggleCheckboxInMarkdown('- [X] task', 0)).toBe('- [ ] task');
    });

    it('toggles only the targeted item among several', () => {
        const input = '- [ ] a\n- [ ] b\n- [ ] c';
        expect(toggleCheckboxInMarkdown(input, 1)).toBe('- [ ] a\n- [x] b\n- [ ] c');
    });

    it('supports * and + list markers', () => {
        expect(toggleCheckboxInMarkdown('* [ ] a', 0)).toBe('* [x] a');
        expect(toggleCheckboxInMarkdown('+ [ ] a', 0)).toBe('+ [x] a');
    });

    it('supports ordered list markers', () => {
        expect(toggleCheckboxInMarkdown('1. [ ] a', 0)).toBe('1. [x] a');
    });

    it('toggles nested task items by document order', () => {
        const input = '- [ ] parent\n  - [ ] child';
        expect(toggleCheckboxInMarkdown(input, 1)).toBe('- [ ] parent\n  - [x] child');
    });

    it('ignores task-like lines inside fenced code blocks', () => {
        const input = '```\n- [ ] not a task\n```\n\n- [ ] real task';
        // The only rendered checkbox is the real one (index 0).
        expect(toggleCheckboxInMarkdown(input, 0)).toBe(
            '```\n- [ ] not a task\n```\n\n- [x] real task'
        );
    });

    it('returns the text unchanged for an out-of-range index', () => {
        const input = '- [ ] only';
        expect(toggleCheckboxInMarkdown(input, 5)).toBe(input);
    });

    it('leaves plain list items (no checkbox) untouched', () => {
        const input = '- plain\n- [ ] task';
        // Plain item is not a task item, so index 0 is the real checkbox.
        expect(toggleCheckboxInMarkdown(input, 0)).toBe('- plain\n- [x] task');
    });
});
