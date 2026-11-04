import * as vscode from 'vscode';

/**
 * Panel colours, contributed as theme colours (`contributes.colors` in package.json,
 * kept equal to this list by colors.test.ts). VS Code exposes each one to the webview
 * as `--vscode-tracenotes-<key>`; users override them in `workbench.colorCustomizations`,
 * which `tracenotes color` edits.
 */
export interface ThemeColorDef {
    id: string;
    description: string;
    defaults: { dark: string; light: string; highContrast: string; highContrastLight: string };
}

const same = (c: string) => ({ dark: c, light: c, highContrast: c, highContrastLight: c });

export const THEME_COLORS: ThemeColorDef[] = [
    { id: 'tracenotes.cardBackground', description: 'Background of a trace card in the panel.', defaults: same('editor.background') },
    { id: 'tracenotes.cardBorder', description: 'Border of a trace card in the panel.', defaults: { dark: 'panel.border', light: 'panel.border', highContrast: 'contrastBorder', highContrastLight: 'contrastBorder' } },
    { id: 'tracenotes.cardHoverBorder', description: 'Border of a trace card under the mouse.', defaults: { dark: '#858585', light: '#858585', highContrast: 'contrastActiveBorder', highContrastLight: 'contrastActiveBorder' } },
    { id: 'tracenotes.cardActiveBorder', description: 'Border (and flash) of the card for the code under the cursor. Tagged cards keep their tag colour.', defaults: { dark: '#858585', light: '#858585', highContrast: 'contrastActiveBorder', highContrastLight: 'contrastActiveBorder' } },
    { id: 'tracenotes.cardHeaderBackground', description: 'Background of a trace card\'s header row (number, file, buttons).', defaults: same('sideBarSectionHeader.background') },
    { id: 'tracenotes.cardFileForeground', description: 'File name in a trace card\'s header.', defaults: same('textLink.foreground') },
    { id: 'tracenotes.noteForeground', description: 'Note text on a trace card.', defaults: { dark: '#9ebeff', light: '#1f3a8a', highContrast: '#9ebeff', highContrastLight: '#1f3a8a' } },
    { id: 'tracenotes.noteBorder', description: 'Border around the note on a trace card.', defaults: same('widget.border') },
    { id: 'tracenotes.orphanBorder', description: 'Border of a card whose code can no longer be found in its file.', defaults: same('#ff000084') },
    { id: 'tracenotes.connector', description: 'Line joining consecutive cards in the panel.', defaults: same('panel.border') },
    { id: 'tracenotes.minimapBackground', description: 'Background of the minimap.', defaults: same('editor.background') },
    { id: 'tracenotes.minimapCardBorder', description: 'Border of an untagged card in the minimap and in cross-tree search results.', defaults: same('widget.border') },
    { id: 'tracenotes.minimapConnector', description: 'Lines joining parent and child cards in the minimap.', defaults: same('editorIndentGuide.background') },
    { id: 'tracenotes.minimapActiveArrow', description: 'Arrow pointing at the active card in the minimap.', defaults: same('charts.orange') },
    { id: 'tracenotes.minimapControlBackground', description: 'Background of the minimap\'s search bar and close button.', defaults: same('#d4d4d4') },
    { id: 'tracenotes.minimapControlForeground', description: 'Text and icons in the minimap\'s search bar and close button.', defaults: same('#000000') },
    { id: 'tracenotes.minimapControlBorder', description: 'Border of the minimap\'s search bar and close button.', defaults: same('#000000') },
    { id: 'tracenotes.searchMatchBackground', description: 'Background behind search matches in minimap and cross-tree search results.', defaults: same('#ffc80059') },
];

const PREFIX = 'tracenotes.';
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

type Customizations = Record<string, unknown>;

/** `cardBorder` or `tracenotes.cardBorder`, any case, as the full id. */
export function resolveKey(key: string): string {
    const k = key.toLowerCase().replace(/^tracenotes\./, '');
    const def = THEME_COLORS.find(c => c.id.slice(PREFIX.length).toLowerCase() === k);
    if (!def) {
        throw new Error(`Unknown colour "${key}". Colours: ${THEME_COLORS.map(c => c.id.slice(PREFIX.length)).join(', ')}.`);
    }
    return def.id;
}

/** A hex colour, lower-cased; the `#` is optional since an unquoted `#` starts a shell comment. */
export function checkColor(value: string): string {
    const v = value.startsWith('#') ? value : `#${value}`;
    if (!HEX.test(v)) { throw new Error(`"${value}" is not a colour: use #rgb, #rgba, #rrggbb or #rrggbbaa.`); }
    return v.toLowerCase();
}

/**
 * A copy of a `workbench.colorCustomizations` value with `set` applied and `reset` removed,
 * at the top level or inside the `[theme]` block. Only `tracenotes.*` keys are touched;
 * `reset: 'all'` drops every one of them in that block. Empty blocks are dropped, and an
 * empty result is `undefined` (remove the setting).
 */
export function applyColors(current: Customizations | undefined, theme: string | undefined,
    set: Record<string, string>, reset: string[] | 'all'): Customizations | undefined {
    const next: Customizations = { ...(current ?? {}) };
    const blockKey = theme ? `[${theme}]` : undefined;
    const prev = blockKey ? next[blockKey] : next;
    const block: Customizations = blockKey ? { ...(isObject(prev) ? prev : {}) } : next;
    for (const k of Object.keys(block)) {
        if (k.startsWith(PREFIX) && (reset === 'all' || reset.includes(k))) { delete block[k]; }
    }
    Object.assign(block, set);
    if (blockKey) {
        if (Object.keys(block).length) { next[blockKey] = block; } else { delete next[blockKey]; }
    }
    return Object.keys(next).length ? next : undefined;
}

function isObject(v: unknown): v is Customizations {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Overrides of our colours in one colorCustomizations value: [theme or '', id, value]. */
function overridesIn(value: unknown): [string, string, string][] {
    if (!isObject(value)) { return []; }
    const out: [string, string, string][] = [];
    for (const [k, v] of Object.entries(value)) {
        if (k.startsWith(PREFIX) && typeof v === 'string') { out.push(['', k, v]); }
        const m = /^\[(.+)\]$/.exec(k);
        if (m && isObject(v)) {
            for (const [ck, cv] of Object.entries(v)) {
                if (ck.startsWith(PREFIX) && typeof cv === 'string') { out.push([m[1], ck, cv]); }
            }
        }
    }
    return out;
}

type Scope = 'user' | 'workspace';

function parseScope(s: string | undefined): Scope {
    if (s === undefined || s === 'user') { return 'user'; }
    if (s === 'workspace') {
        if (!vscode.workspace.workspaceFolders?.length) { throw new Error('No folder is open, so there are no workspace settings; use --scope user.'); }
        return 'workspace';
    }
    throw new Error(`--scope must be user or workspace, not "${s}".`);
}

function kindKey(): keyof ThemeColorDef['defaults'] {
    switch (vscode.window.activeColorTheme?.kind) {
        case vscode.ColorThemeKind.Light: return 'light';
        case vscode.ColorThemeKind.HighContrast: return 'highContrast';
        case vscode.ColorThemeKind.HighContrastLight: return 'highContrastLight';
        default: return 'dark';
    }
}

/** Installed colour themes' ids and labels, for a friendly warning on a misspelt --theme. */
function installedThemes(): string[] {
    const names: string[] = [];
    for (const ext of vscode.extensions?.all ?? []) {
        for (const t of (ext.packageJSON?.contributes?.themes ?? []) as { id?: string; label?: string }[]) {
            if (t.id) { names.push(t.id); }
            if (t.label) { names.push(t.label); }
        }
    }
    return names;
}

/** `tracenotes color list|set|reset`. `text` holds the positionals after the action. */
export async function colorCommand(a: Record<string, string | undefined>): Promise<unknown> {
    const config = vscode.workspace.getConfiguration('workbench');
    const words = (a.text ?? '').split(/\s+/).filter(Boolean);
    switch (a.action) {
        case 'list':
        case undefined: {
            const info = config.inspect<Customizations>('colorCustomizations');
            const found: Record<string, { scope: Scope; theme?: string; value: string }[]> = {};
            for (const [scope, value] of [['user', info?.globalValue], ['workspace', info?.workspaceValue]] as const) {
                for (const [theme, id, v] of overridesIn(value)) {
                    (found[id] ??= []).push({ scope, theme: theme || undefined, value: v });
                }
            }
            const kind = kindKey();
            return {
                theme: config.get<string>('colorTheme'),
                note: 'An override for the active theme ("theme" set) beats a general one; workspace beats user. "default" is a hex colour or the VS Code theme colour it follows.',
                colors: THEME_COLORS.map(c => ({
                    key: c.id.slice(PREFIX.length),
                    description: c.description,
                    default: c.defaults[kind],
                    overrides: found[c.id],
                })),
            };
        }
        case 'set':
        case 'reset': {
            const scope = parseScope(a.scope);
            // Accept "[Dark+]" too, as written in colorCustomizations, without double-bracketing it.
            const theme = a.theme?.trim().replace(/^\[(.*)\]$/, '$1').trim() || undefined;
            const set: Record<string, string> = {};
            let reset: string[] | 'all' = [];
            if (a.action === 'set') {
                if (!words.length || words.length % 2) { throw new Error('color set needs <key> <#colour> pairs, e.g. color set cardBorder "#ff8800".'); }
                for (let i = 0; i < words.length; i += 2) { set[resolveKey(words[i])] = checkColor(words[i + 1]); }
            } else {
                reset = words.length ? words.map(resolveKey) : 'all';
            }
            const target = scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
            const info = config.inspect<Customizations>('colorCustomizations');
            const current = scope === 'user' ? info?.globalValue : info?.workspaceValue;
            await config.update('colorCustomizations', applyColors(current, theme, set, reset), target);
            const themes = theme ? installedThemes() : [];
            return {
                scope,
                theme,
                set: a.action === 'set' ? set : undefined,
                reset: a.action === 'reset' ? (reset === 'all' ? 'all' : reset) : undefined,
                warnings: theme && themes.length && !themes.includes(theme)
                    ? [`No installed colour theme is called "${theme}"; the colours apply only once a theme with that name is active.`]
                    : undefined,
            };
        }
        default:
            throw new Error(`Unknown color action "${a.action}": use list, set or reset.`);
    }
}
