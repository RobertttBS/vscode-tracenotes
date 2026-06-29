export const MAX_DEPTH = 10;

export interface NavigationHistoryEntry {
    treeId: string;
    groupId: string | null;
    focusId: string | null;
}


export interface TracePoint {
    id: string;
    filePath: string;
    rangeOffset: [number, number]; // [startOffset, endOffset] (absolute)
    lineRange?: [number, number]; 
    content: string;             // dedented source code
    lang: string;                // language id for syntax highlighting
    note: string;
    timestamp: number;
    highlight?: 'red' | 'blue' | 'green' | 'orange' | 'purple' | 'indigo' | 'brown' | 'yellow' | null;
    orphaned?: boolean;
    children?: TracePoint[];     // sub-traces (max 10 levels deep)
}

/**
 * Fences that wrap a trace note's raw Markdown body in exported documents.
 * The note is written verbatim between them, so headings, blank lines and `---`
 * inside a note survive the round-trip without colliding with the structural
 * headings that encode the trace tree. HTML comments keep the markers invisible
 * in rendered Markdown (e.g. Obsidian reading view).
 */
export const NOTE_BLOCK_START = '<!-- tracenote -->';
export const NOTE_BLOCK_END = '<!-- /tracenote -->';

/**
 * A note body can itself contain a line that looks like a fence delimiter. Escape
 * such lines on export by inserting a zero-width space after `<!--`, and reverse it
 * on import, so the delimiters round-trip without prematurely closing the block.
 */
const NOTE_FENCE_ESCAPE = '<!--\u200B';

/** Escape any delimiter-looking lines in a note before wrapping it in a fence. */
export function escapeNoteFences(note: string): string {
    return note.split('\n').map(line => {
        const trimmed = line.trim();
        return (trimmed === NOTE_BLOCK_START || trimmed === NOTE_BLOCK_END)
            ? line.replace('<!--', NOTE_FENCE_ESCAPE)
            : line;
    }).join('\n');
}

/** Reverse {@link escapeNoteFences} for a single captured note line. */
export function unescapeNoteFence(line: string): string {
    const trimmed = line.trim();
    return (trimmed === NOTE_BLOCK_START.replace('<!--', NOTE_FENCE_ESCAPE) ||
            trimmed === NOTE_BLOCK_END.replace('<!--', NOTE_FENCE_ESCAPE))
        ? line.replace(NOTE_FENCE_ESCAPE, '<!--')
        : line;
}

/** Maps a highlight colour to its human-readable Markdown tag (and vice-versa). */
export const HIGHLIGHT_TO_TAG: Record<NonNullable<TracePoint['highlight']>, string> = {
    red:    'Important',
    orange: 'Faq',
    blue:   'Note',
    green:  'Tip',
    purple: 'Remark',
    indigo:   'Info',
    brown:    'Warning',
    yellow: 'Todo',
};

/** Root level container for a tree of traces */
export interface TraceTree {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    traces: TracePoint[];
}

/** Slim trace projection used by the cross-tree search view. */
export interface SearchableTrace {
    id: string;
    note: string;
    content: string;
    filePath: string;
    lineRange?: [number, number];
    highlight?: TracePoint['highlight'];
    children?: SearchableTrace[];
}

export interface SearchableTree {
    id: string;
    name: string;
    traces: SearchableTrace[];
}

/** Messages sent from Extension → Webview */
export type ExtensionToWebviewMessage =
    | { type: 'focusCard'; id: string | null }
    | {
        type: 'syncWorkspace';
        payload: {
            treeId: string;
            treeName: string;
            traces: TracePoint[];
            activeGroupId: string | null;
            activeDepth: number;
            breadcrumb: string;
            treeList: { id: string; name: string; active: boolean }[];
            focusId?: string;
        };
    }
    | { type: 'allTreesData'; payload: { trees: SearchableTree[] } }
    | { type: 'jumpToFadedTrace'; groupId: string | null; focusId: string };

/** Messages sent from Webview → Extension */
export type WebviewToExtensionMessage =
    | { command: 'jumpToCode'; id: string; filePath: string; range: [number, number] }
    | { command: 'removeTrace'; id: string }
    | { command: 'reorderTraces'; orderedIds: string[] }
    | { command: 'updateNote'; id: string; note: string }
    | { command: 'ready' }
    | { command: 'enterGroup'; id: string }
    | { command: 'exitGroup' }
    | { command: 'updateHighlight'; id: string; highlight: 'red' | 'blue' | 'green' | 'orange' | 'purple' | 'indigo' | 'brown' | 'yellow' | null }
    | { command: 'exportToMarkdown' }
    | { command: 'renameTree'; name: string }
    | { command: 'createTree'; name: string }
    | { command: 'switchTree'; id: string }
    | { command: 'deleteTree'; id: string }
    | { command: 'relocateTrace'; id: string }
    | { command: 'importTrace' }
    | { command: 'moveToChild'; traceId: string; targetId: string }
    | { command: 'moveToParent'; traceId: string }
    | { command: 'addEmptyTrace' }
    | { command: 'jumpToGroup'; groupId: string | null; focusId: string }
    | { command: 'exportAllData' }
    | { command: 'navigateToTrace'; treeId: string; groupId: string | null; focusId: string }
    | { command: 'requestAllTrees' };
