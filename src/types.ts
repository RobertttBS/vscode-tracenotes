export const MAX_DEPTH = 10;


export interface TracePoint {
    id: string;
    filePath: string;
    rangeOffset: [number, number]; // [startOffset, endOffset] (absolute)
    /** @deprecated used for migration only */
    lineRange?: [number, number]; 
    content: string;             // dedented source code
    lang: string;                // language id for syntax highlighting
    note: string;
    timestamp: number;
    highlight?: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null;
    orphaned?: boolean;
    children?: TracePoint[];     // sub-traces (max 3 levels deep)
}

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
    | { type: 'syncAll'; payload: { treeId: string; treeName: string; traces: TracePoint[] } }
    | { type: 'focusCard'; id: string }
    | { type: 'setActiveGroup'; id: string | null; depth: number; breadcrumb: string };

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
    | { command: 'renameTree'; name: string };
