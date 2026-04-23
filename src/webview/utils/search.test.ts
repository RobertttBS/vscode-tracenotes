import { describe, it, expect } from 'vitest';
import { parseQuery, matchTrace, collectHighlightTargets, SearchNode } from './search';

// helpers
const term = (v: string): SearchNode => ({ type: 'term', value: v });
const phrase = (v: string): SearchNode => ({ type: 'phrase', value: v });
const and_ = (...c: SearchNode[]): SearchNode => ({ type: 'and', children: c });
const or_ = (...c: SearchNode[]): SearchNode => ({ type: 'or', children: c });
const not_ = (c: SearchNode): SearchNode => ({ type: 'not', child: c });

// ─── parseQuery ───────────────────────────────────────────────────────────────

describe('parseQuery – parsing', () => {
    it('single bare term', () => {
        expect(parseQuery('aaa')).toEqual(term('aaa'));
    });

    it('implicit AND between two terms', () => {
        expect(parseQuery('aaa bbb')).toEqual(and_(term('aaa'), term('bbb')));
    });

    it('explicit OR', () => {
        expect(parseQuery('aaa OR bbb')).toEqual(or_(term('aaa'), term('bbb')));
    });

    it('explicit AND', () => {
        expect(parseQuery('aaa AND bbb')).toEqual(and_(term('aaa'), term('bbb')));
    });

    it('AND then OR – left-associative precedence: (aaa AND bbb) OR ccc', () => {
        expect(parseQuery('aaa AND bbb OR ccc')).toEqual(or_(and_(term('aaa'), term('bbb')), term('ccc')));
    });

    it('OR then implicit AND – right: aaa OR (bbb AND ccc)', () => {
        expect(parseQuery('aaa OR bbb ccc')).toEqual(or_(term('aaa'), and_(term('bbb'), term('ccc'))));
    });

    it('grouped OR with explicit AND', () => {
        expect(parseQuery('(aaa OR bbb) AND ccc')).toEqual(and_(or_(term('aaa'), term('bbb')), term('ccc')));
    });

    it('quoted phrase', () => {
        expect(parseQuery('"aaa bbb"')).toEqual(phrase('aaa bbb'));
    });

    it('term, phrase, term with implicit AND', () => {
        expect(parseQuery('aaa "bbb ccc" ddd')).toEqual(
            and_(and_(term('aaa'), phrase('bbb ccc')), term('ddd'))
        );
    });

    it('- shorthand NOT', () => {
        expect(parseQuery('-aaa')).toEqual(null); // only-negative root → null
    });

    it('NOT keyword', () => {
        expect(parseQuery('NOT aaa')).toEqual(null); // only-negative root → null
    });

    it('term AND NOT term', () => {
        expect(parseQuery('aaa -bbb')).toEqual(and_(term('aaa'), not_(term('bbb'))));
    });

    it('- before quoted phrase', () => {
        expect(parseQuery('baz -"foo bar"')).toEqual(and_(term('baz'), not_(phrase('foo bar'))));
    });

    it('foo-bar is a single term', () => {
        expect(parseQuery('foo-bar')).toEqual(term('foo-bar'));
    });

    it('lowercase and/or/not are literal terms', () => {
        const result = parseQuery('salt and pepper');
        // and_ is nested binary: AND(AND(salt, and), pepper)
        expect(result).toEqual(and_(and_(term('salt'), term('and')), term('pepper')));
    });

    it('unclosed quote treated as phrase to end of input', () => {
        expect(parseQuery('"aaa')).toEqual(phrase('aaa'));
    });

    it('empty string → null', () => {
        expect(parseQuery('')).toBeNull();
    });

    it('whitespace-only → null', () => {
        expect(parseQuery('   ')).toBeNull();
    });

    it('standalone AND → null', () => {
        expect(parseQuery('AND')).toBeNull();
    });

    it('standalone OR → null', () => {
        expect(parseQuery('OR')).toBeNull();
    });

    it('only-negative NOT aaa → null', () => {
        expect(parseQuery('NOT aaa')).toBeNull();
    });

    it('trailing AND dropped', () => {
        expect(parseQuery('aaa AND')).toEqual(term('aaa'));
    });

    it('consecutive operators collapsed: aaa AND OR bbb → OR(aaa, bbb)', () => {
        expect(parseQuery('aaa AND OR bbb')).toEqual(or_(term('aaa'), term('bbb')));
    });

    it('unbalanced ( inferred closed at end of input', () => {
        expect(parseQuery('(aaa')).toEqual(term('aaa'));
    });

    it('unbalanced ) extra paren dropped', () => {
        expect(parseQuery('aaa)')).toEqual(term('aaa'));
    });

    it('NOT with phrase', () => {
        expect(parseQuery('xyz NOT "foo bar"')).toEqual(and_(term('xyz'), not_(phrase('foo bar'))));
    });
});

// ─── matchTrace ───────────────────────────────────────────────────────────────

describe('matchTrace – matching', () => {
    const noteOnly = 'hello world\n';
    const contentOnly = '\nfoo bar baz';
    const both = 'hello world\nfoo bar baz';

    it('term in note only → matches', () => {
        const ast = parseQuery('hello')!;
        expect(matchTrace(ast, noteOnly)).toBe(true);
    });

    it('term in content only → matches', () => {
        const ast = parseQuery('foo')!;
        expect(matchTrace(ast, contentOnly)).toBe(true);
    });

    it('term in neither → no match', () => {
        const ast = parseQuery('missing')!;
        expect(matchTrace(ast, both)).toBe(false);
    });

    it('AND with one side in note, other in content → matches', () => {
        const ast = parseQuery('hello AND foo')!;
        expect(matchTrace(ast, both)).toBe(true);
    });

    it('phrase spanning note↔content boundary → does NOT match', () => {
        // "world\nfoo" - the \n in the joined text breaks the phrase
        const ast = parseQuery('"world foo"')!;
        // joined text is "hello world\nfoo bar baz" — "world foo" has a newline in between
        expect(matchTrace(ast, both)).toBe(false);
    });

    it('NOT correctly excludes', () => {
        const ast = parseQuery('hello AND NOT foo')!;
        expect(matchTrace(ast, both)).toBe(false);         // has foo
        expect(matchTrace(ast, noteOnly)).toBe(true);      // no foo
    });

    it('case-insensitive content match', () => {
        const ast = parseQuery('HELLO')!;
        expect(matchTrace(ast, 'hello world\n')).toBe(true);
    });

    it('lowercase operator treated as literal term', () => {
        // "and" is a literal term search, not a boolean operator
        const ast = parseQuery('and')!;
        expect(matchTrace(ast, 'salt and pepper\n')).toBe(true);
        expect(matchTrace(ast, 'salt pepper\n')).toBe(false);
    });

    it('OR matches when either side present', () => {
        const ast = parseQuery('alpha OR beta')!;
        expect(matchTrace(ast, 'alpha\n')).toBe(true);
        expect(matchTrace(ast, 'beta\n')).toBe(true);
        expect(matchTrace(ast, 'gamma\n')).toBe(false);
    });
});

// ─── collectHighlightTargets ─────────────────────────────────────────────────

describe('collectHighlightTargets', () => {
    it('term', () => {
        expect(collectHighlightTargets(term('aaa'))).toEqual(['aaa']);
    });

    it('phrase', () => {
        expect(collectHighlightTargets(phrase('foo bar'))).toEqual(['foo bar']);
    });

    it('NOT leaf is excluded', () => {
        expect(collectHighlightTargets(not_(term('aaa')))).toEqual([]);
    });

    it('AND collects from all positive children', () => {
        const ast = parseQuery('aaa AND bbb')!;
        expect(collectHighlightTargets(ast).sort()).toEqual(['aaa', 'bbb']);
    });

    it('AND with NOT – excluded term not collected', () => {
        const ast = parseQuery('aaa AND NOT bbb')!;
        expect(collectHighlightTargets(ast)).toEqual(['aaa']);
    });

    it('OR collects from all children', () => {
        const ast = parseQuery('aaa OR bbb')!;
        expect(collectHighlightTargets(ast).sort()).toEqual(['aaa', 'bbb']);
    });

    it('mixed query with phrase', () => {
        const ast = parseQuery('aaa "bbb ccc" -ddd')!;
        expect(collectHighlightTargets(ast).sort()).toEqual(['aaa', 'bbb ccc']);
    });
});
