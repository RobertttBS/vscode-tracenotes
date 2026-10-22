import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WindowEntry, entryFile, pickEntry, readEntries, sweepStale } from './registry';

const entry = (pid: number, ...folders: string[]): WindowEntry => ({ pid, socket: `/s/${pid}`, token: 't', folders });

describe('pickEntry', () => {
    const a = entry(1, '/work/app');
    const b = entry(2, '/work/app/packages/core');
    const c = entry(3, '/work/app-2');

    it('picks the window whose folder contains cwd, deepest folder winning', () => {
        expect(pickEntry([a, b, c], '/work/app/src')).toBe(a);
        expect(pickEntry([a, b, c], '/work/app/packages/core/lib')).toBe(b);
        expect(pickEntry([a, b, c], '/work/app')).toBe(a);
    });

    it('does not match a sibling folder sharing a name prefix', () => {
        expect(pickEntry([a], '/work/app-2/src')).toBeUndefined();
        expect(pickEntry([a, c], '/work/app-2/src')).toBe(c);
    });

    it('returns undefined when no window has cwd open', () => {
        expect(pickEntry([a, b], '/elsewhere')).toBeUndefined();
    });
});

describe('sweepStale', () => {
    it('removes entries of dead processes and keeps live ones', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-run-'));
        const live = entry(process.pid, '/x');
        const dead = entry(2 ** 22 + 12345, '/y'); // above macOS/Linux default pid_max
        for (const e of [live, dead]) { fs.writeFileSync(entryFile(e.pid, dir), JSON.stringify(e)); }
        fs.writeFileSync(path.join(dir, 'junk.json'), '{');

        sweepStale(dir);

        expect(readEntries(dir).map(e => e.pid)).toEqual([process.pid]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
