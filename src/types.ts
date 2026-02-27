export const MAX_DEPTH = 10;


export interface TracePoint {
    id: string;
    filePath: string;
    rangeOffset: [number, number]; // [startOffset, endOffset] (absolute)
    lineRange?: [number, number]; 
    content: string;             // dedented source code
    lang: string;                // language id for syntax highlighting
    note: string;
    timestamp: number;
    highlight?: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null;
    orphaned?: boolean;
    children?: TracePoint[];     // sub-traces (max 10 levels deep)
}

/** Maps a highlight colour to its human-readable Markdown tag (and vice-versa). */
export const HIGHLIGHT_TO_TAG: Record<NonNullable<TracePoint['highlight']>, string> = {
    red:    'Important',
    orange: 'Faq',
    blue:   'Note',
    green:  'Tip',
    purple: 'Remark',
};

/** Root level container for a tree of traces */
export interface TraceTree {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    traces: TracePoint[];
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
    };

/** Messages sent from Webview → Extension */
export type WebviewToExtensionMessage =
    | { command: 'jumpToCode'; filePath: string; range: [number, number] }
    | { command: 'removeTrace'; id: string }
    | { command: 'reorderTraces'; orderedIds: string[] }
    | { command: 'updateNote'; id: string; note: string }
    | { command: 'ready' }
    | { command: 'enterGroup'; id: string }
    | { command: 'exitGroup' }
    | { command: 'clearCurrentLevel' }
    | { command: 'updateHighlight'; id: string; highlight: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null }
    | { command: 'exportToMarkdown' }
    | { command: 'renameTree'; name: string }
    | { command: 'createTree'; name: string }
    | { command: 'switchTree'; id: string }
    | { command: 'deleteTree'; id: string }
    | { command: 'relocateTrace'; id: string }
    | { command: 'importTrace' }
    | { command: 'moveToChild'; traceId: string; targetId: string }
    | { command: 'moveToParent'; traceId: string }
    | { command: 'addEmptyTrace' };
