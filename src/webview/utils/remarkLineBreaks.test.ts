import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import { remarkLineBreaks } from './remarkLineBreaks';

function transform(md: string): Root {
    const processor = unified().use(remarkParse).use(remarkLineBreaks);
    return processor.runSync(processor.parse(md)) as Root;
}

function countBreaks(md: string): number {
    let breaks = 0;
    visit(transform(md), 'break', () => { breaks++; });
    return breaks;
}

function textValues(md: string): string[] {
    const values: string[] = [];
    visit(transform(md), 'text', (node) => { values.push(node.value); });
    return values;
}

describe('remarkLineBreaks', () => {
    it('turns a single newline into one hard break', () => {
        expect(countBreaks('line1\nline2')).toBe(1);
        expect(textValues('line1\nline2')).toEqual(['line1', 'line2']);
    });

    it('turns each newline in a run into its own break', () => {
        expect(countBreaks('a\nb\nc')).toBe(2);
        expect(textValues('a\nb\nc')).toEqual(['a', 'b', 'c']);
    });

    it('leaves text without newlines untouched', () => {
        expect(countBreaks('no breaks here')).toBe(0);
        expect(textValues('no breaks here')).toEqual(['no breaks here']);
    });

    it('does not add breaks for a paragraph gap (two newlines)', () => {
        // A blank line is already two separate paragraphs, not a soft break.
        expect(countBreaks('a\n\nb')).toBe(0);
    });
});
