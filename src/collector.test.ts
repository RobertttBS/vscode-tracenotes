import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { dedent } from './collector';

describe('dedent', () => {
    it('strips the indentation common to non-blank lines, ignoring blank and whitespace-only lines', () => {
        expect(dedent('    if (x) {\n\n  \n        y();\n    }')).toBe('if (x) {\n\n  \n    y();\n}'); // short blank lines kept as-is
    });

    it('normalizes CRLF to LF', () => {
        expect(dedent('  a\r\n    b\r\n')).toBe('a\n  b\n');
    });

    it('leaves unindented, empty and all-blank input alone', () => {
        expect(dedent('a\n  b')).toBe('a\n  b');
        expect(dedent('')).toBe('');
        expect(dedent('   \n ')).toBe('   \n ');
    });
});
