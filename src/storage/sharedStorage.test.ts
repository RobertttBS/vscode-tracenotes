import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { normalizeRemoteUrl, parseOriginUrl } from './projectId';
import { toShared, fromShared } from './pathMapping';
import { mergeTrees } from './FileStorageManager';
import type { TraceTree } from '../types';

describe('normalizeRemoteUrl', () => {
    it('maps ssh, https and scp forms of one repo to the same id', () => {
        const ids = [
            'git@GitHub.com:me/project1.git',
            'https://github.com/me/project1',
            'https://user@github.com/me/project1.git/',
            'ssh://git@github.com/me/project1.git',
        ].map(normalizeRemoteUrl);
        expect(new Set(ids)).toEqual(new Set(['github.com/me/project1']));
    });

    it('keeps an explicit port', () => {
        expect(normalizeRemoteUrl('https://host:8443/a/b.git')).toBe('host:8443/a/b');
    });
});

describe('parseOriginUrl', () => {
    it('reads only the origin remote', () => {
        const cfg = [
            '[core]', '\turl = nope',
            '[remote "upstream"]', '\turl = git@github.com:up/p.git',
            '[remote "origin"]', '\tfetch = +refs/heads/*:refs/remotes/origin/*', '\turl = git@github.com:me/p.git',
        ].join('\n');
        expect(parseOriginUrl(cfg)).toBe('git@github.com:me/p.git');
    });

    it('returns undefined without an origin', () => {
        expect(parseOriginUrl('[remote "upstream"]\n\turl = x')).toBeUndefined();
    });
});

describe('toShared / fromShared', () => {
    const trees: TraceTree[] = [{
        id: 't', name: 'n', createdAt: 0, updatedAt: 0,
        traces: [
            { id: 'a', filePath: '/issue1/src/a.ts', rangeOffset: [0, 1], content: '', lang: 'ts', note: '', timestamp: 0,
              children: [{ id: 'b', filePath: '/issue1/lib/b.ts', rangeOffset: [0, 1], content: '', lang: 'ts', note: '', timestamp: 0 }] },
            { id: 'c', filePath: '/elsewhere/c.ts', rangeOffset: [0, 1], content: '', lang: 'ts', note: '', timestamp: 0 },
            { id: 'd', filePath: '', rangeOffset: [0, 0], content: '', lang: 'ts', note: '', timestamp: 0 },
        ],
    }];

    it('stores in-workspace paths relative, others unchanged', () => {
        const shared = toShared(trees, '/issue1');
        expect(shared[0].traces.map(t => t.filePath)).toEqual(['src/a.ts', '/elsewhere/c.ts', '']);
        expect(shared[0].traces[0].children![0].filePath).toBe('lib/b.ts');
        expect(trees[0].traces[0].filePath).toBe('/issue1/src/a.ts'); // input untouched
    });

    it('resolves relative paths against another checkout', () => {
        const moved = fromShared(toShared(trees, '/issue1'), '/issue2');
        expect(moved[0].traces.map(t => t.filePath)).toEqual(['/issue2/src/a.ts', '/elsewhere/c.ts', '']);
        expect(moved[0].traces[0].children![0].filePath).toBe('/issue2/lib/b.ts');
    });
});

describe('mergeTrees', () => {
    const tree = (id: string, note: string, offset = 0): TraceTree => ({
        id, name: id, createdAt: 0, updatedAt: offset,
        traces: [{ id: `${id}-t`, filePath: '/r/a.ts', rangeOffset: [offset, offset + 1], content: 'x', lang: 'ts', note, timestamp: 0 }],
    });

    it('appends new trees and skips ones that differ only in positions', () => {
        const merged = mergeTrees([tree('a', 'n')], [tree('a', 'n', 50), tree('b', 'n')], 'issue2');
        expect(merged.map(t => t.id)).toEqual(['a', 'b']);
    });

    it('keeps both copies of a clashing tree, with fresh ids', () => {
        const merged = mergeTrees([tree('default', 'one')], [tree('default', 'two')], 'issue2');
        expect(merged).toHaveLength(2);
        expect(merged[1].name).toBe('default (issue2)');
        expect(merged[1].id).not.toBe('default');
        expect(merged[1].traces[0].id).not.toBe('default-t');
        expect(merged[1].traces[0].note).toBe('two');
    });

    it('drops an empty clashing tree and ignores createdAt', () => {
        const empty = { ...tree('default', 'x'), traces: [] };
        const later = { ...tree('a', 'n'), createdAt: 99 };
        expect(mergeTrees([tree('default', 'one'), tree('a', 'n')], [empty, later], 'issue2')).toHaveLength(2);
    });
});
