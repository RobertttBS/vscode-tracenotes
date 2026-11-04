import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => import('../test/vscodeMock'));

import * as fs from 'fs';
import * as path from 'path';
import { ColorThemeKind, Uri, extensions, settings, window, workspace } from '../test/vscodeMock';
import { THEME_COLORS, applyColors, checkColor, colorCommand, resolveKey } from './colors';

const ROOT = path.join(__dirname, '..', '..');
const KEY = 'workbench.colorCustomizations';

describe('theme colour definitions', () => {
    it('match contributes.colors in package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.contributes.colors).toEqual(THEME_COLORS);
    });

    it('have one dot, so the webview variable is --vscode-tracenotes-<key>', () => {
        // VS Code turns only the first "." into "-" when it names the CSS variable.
        for (const c of THEME_COLORS) { expect(c.id).toMatch(/^tracenotes\.[a-zA-Z]+$/); }
    });

    it('are each used by the webview, which uses no undefined ones', () => {
        const dir = path.join(ROOT, 'src', 'webview');
        const files = [path.join(dir, 'webview.css'), ...fs.readdirSync(path.join(dir, 'components')).map(f => path.join(dir, 'components', f))];
        const used = new Set(files.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/--vscode-tracenotes-([a-zA-Z]+)/g)].map(m => `tracenotes.${m[1]}`)));
        expect([...used].sort()).toEqual(THEME_COLORS.map(c => c.id).sort());
    });
});

describe('resolveKey / checkColor', () => {
    it('accepts short, full and any-case keys', () => {
        expect(resolveKey('cardBorder')).toBe('tracenotes.cardBorder');
        expect(resolveKey('tracenotes.cardborder')).toBe('tracenotes.cardBorder');
        expect(() => resolveKey('editor.background')).toThrow(/Unknown colour/);
    });

    it('accepts hex with or without #, lower-cased', () => {
        expect(checkColor('#FF8800')).toBe('#ff8800');
        expect(checkColor('f80a')).toBe('#f80a');
        expect(() => checkColor('red')).toThrow(/not a colour/);
        expect(() => checkColor('#12345')).toThrow(/not a colour/);
    });
});

describe('applyColors', () => {
    it('keeps other keys and themes when setting', () => {
        const cur = { 'editor.background': '#000', '[Dark+]': { 'editor.foreground': '#fff' } };
        expect(applyColors(cur, undefined, { 'tracenotes.cardBorder': '#f00' }, [])).toEqual({ ...cur, 'tracenotes.cardBorder': '#f00' });
        expect(applyColors(cur, 'Dark+', { 'tracenotes.cardBorder': '#f00' }, [])).toEqual({
            'editor.background': '#000', '[Dark+]': { 'editor.foreground': '#fff', 'tracenotes.cardBorder': '#f00' },
        });
        expect(cur).toEqual({ 'editor.background': '#000', '[Dark+]': { 'editor.foreground': '#fff' } }); // not mutated
    });

    it('resets only our keys, dropping emptied blocks and an emptied setting', () => {
        const cur = { 'editor.background': '#000', 'tracenotes.cardBorder': '#f00', 'tracenotes.connector': '#0f0', '[Light+]': { 'tracenotes.cardBorder': '#00f' } };
        expect(applyColors(cur, undefined, {}, ['tracenotes.cardBorder'])).toEqual({
            'editor.background': '#000', 'tracenotes.connector': '#0f0', '[Light+]': { 'tracenotes.cardBorder': '#00f' },
        });
        expect(applyColors(cur, undefined, {}, 'all')).toEqual({ 'editor.background': '#000', '[Light+]': { 'tracenotes.cardBorder': '#00f' } });
        expect(applyColors(cur, 'Light+', {}, 'all')).toEqual({ 'editor.background': '#000', 'tracenotes.cardBorder': '#f00', 'tracenotes.connector': '#0f0' });
        expect(applyColors({ 'tracenotes.cardBorder': '#f00' }, undefined, {}, 'all')).toBeUndefined();
    });
});

describe('colorCommand', () => {
    beforeEach(() => {
        settings.global = {};
        settings.workspace = {};
        workspace.workspaceFolders = undefined;
        window.activeColorTheme = { kind: ColorThemeKind.Dark };
        extensions.all = [];
    });

    it('sets pairs in user settings by default and lists them', async () => {
        settings.global[KEY] = { 'editor.background': '#111' };
        const r = await colorCommand({ action: 'set', text: 'cardBorder #FF8800 noteForeground abc' }) as any;
        expect(r.scope).toBe('user');
        expect(settings.global[KEY]).toEqual({ 'editor.background': '#111', 'tracenotes.cardBorder': '#ff8800', 'tracenotes.noteForeground': '#abc' });

        const list = await colorCommand({ action: 'list' }) as any;
        expect(list.colors).toHaveLength(THEME_COLORS.length);
        const border = list.colors.find((c: any) => c.key === 'cardBorder');
        expect(border).toMatchObject({ default: 'panel.border', overrides: [{ scope: 'user', value: '#ff8800' }] });
        expect(list.colors.find((c: any) => c.key === 'connector').overrides).toBeUndefined();
    });

    it('lists defaults for the active theme kind', async () => {
        window.activeColorTheme = { kind: ColorThemeKind.Light };
        const list = await colorCommand({}) as any;
        expect(list.colors.find((c: any) => c.key === 'noteForeground').default).toBe('#1f3a8a');
    });

    it('writes a theme block in workspace scope, and warns on an unknown theme', async () => {
        workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws' }];
        extensions.all = [{ packageJSON: { contributes: { themes: [{ id: 'Default Dark+', label: 'Dark+' }] } } }];
        const ok = await colorCommand({ action: 'set', text: 'connector #123456', scope: 'workspace', theme: 'Dark+' }) as any;
        expect(ok.warnings).toBeUndefined();
        expect(settings.workspace[KEY]).toEqual({ '[Dark+]': { 'tracenotes.connector': '#123456' } });
        expect(settings.global[KEY]).toBeUndefined();

        const odd = await colorCommand({ action: 'set', text: 'connector #123456', scope: 'workspace', theme: 'Drak+' }) as any;
        expect(odd.warnings?.[0]).toMatch(/Drak\+/);

        // "[Dark+]" as written in colorCustomizations is the same theme, not "[[Dark+]]".
        const bracketed = await colorCommand({ action: 'set', text: 'connector #123456', scope: 'workspace', theme: '[Dark+]' }) as any;
        expect(bracketed.theme).toBe('Dark+');
        expect(bracketed.warnings).toBeUndefined();

        const list = await colorCommand({ action: 'list' }) as any;
        expect(list.colors.find((c: any) => c.key === 'connector').overrides).toEqual([
            { scope: 'workspace', theme: 'Dark+', value: '#123456' },
            { scope: 'workspace', theme: 'Drak+', value: '#123456' },
        ]);
    });

    it('resets one key or all of ours, removing the setting when nothing is left', async () => {
        settings.global[KEY] = { 'tracenotes.cardBorder': '#f00', 'tracenotes.connector': '#0f0', 'editor.background': '#000' };
        await colorCommand({ action: 'reset', text: 'cardBorder' });
        expect(settings.global[KEY]).toEqual({ 'tracenotes.connector': '#0f0', 'editor.background': '#000' });
        await colorCommand({ action: 'reset', text: '' });
        expect(settings.global[KEY]).toEqual({ 'editor.background': '#000' });

        settings.global[KEY] = { 'tracenotes.cardBorder': '#f00' };
        await colorCommand({ action: 'reset' });
        expect(KEY in settings.global).toBe(false);
    });

    it('rejects bad input without writing', async () => {
        settings.global[KEY] = { 'tracenotes.cardBorder': '#f00' };
        await expect(colorCommand({ action: 'set', text: 'cardBorder' })).rejects.toThrow(/pairs/);
        await expect(colorCommand({ action: 'set', text: 'cardBorder #f00 nope #fff' })).rejects.toThrow(/Unknown colour "nope"/);
        await expect(colorCommand({ action: 'set', text: 'cardBorder red' })).rejects.toThrow(/not a colour/);
        await expect(colorCommand({ action: 'set', text: 'cardBorder #fff', scope: 'workspace' })).rejects.toThrow(/No folder is open/);
        await expect(colorCommand({ action: 'set', text: 'cardBorder #fff', scope: 'global' })).rejects.toThrow(/--scope/);
        await expect(colorCommand({ action: 'paint' })).rejects.toThrow(/Unknown color action/);
        expect(settings.global[KEY]).toEqual({ 'tracenotes.cardBorder': '#f00' });
    });
});
