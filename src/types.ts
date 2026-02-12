export const MAX_DEPTH = 10;

export interface TracePoint {
    id: string;
    filePath: string;
    lineRange: [number, number]; // [startLine, endLine]
    content: string;             // dedented source code
    lang: string;                // language id for syntax highlighting
    note: string;
    timestamp: number;
    children?: TracePoint[];     // sub-traces (max 3 levels deep)
}

/** Messages sent from Extension → Webview */
export type ExtensionToWebviewMessage =
    | { type: 'syncAll'; payload: TracePoint[] }
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
    | { command: 'clearCurrentLevel' };
