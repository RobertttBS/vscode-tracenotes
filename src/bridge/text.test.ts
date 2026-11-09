import { describe, expect, it } from 'vitest';
import { asciiSafe, decodeText } from './text';

const md = '## 1. 登入流程\n註解\n';

describe('decodeText', () => {
    it('reads UTF-8, with or without a BOM', () => {
        expect(decodeText(Buffer.from(md, 'utf8'))).toBe(md);
        expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(md, 'utf8')]))).toBe(md);
    });
    it('reads UTF-16 LE and BE with a BOM', () => {
        expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(md, 'utf16le')]))).toBe(md);
        expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(md, 'utf16le').swap16()]))).toBe(md);
    });
});

describe('asciiSafe', () => {
    it('escapes non-ASCII so JSON output stays ASCII and parses back unchanged', () => {
        const json = JSON.stringify({ title: '登入 😀 é', id: 'a"b' }, null, 2);
        const safe = asciiSafe(json);
        expect(safe).toMatch(/^[\x00-\x7f]*$/);
        expect(JSON.parse(safe)).toEqual(JSON.parse(json));
    });
});
