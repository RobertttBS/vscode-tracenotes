export interface TracePoint {
    id: string;
    filePath: string;
    lineRange: [number, number]; // [startLine, endLine]
    content: string;             // dedented source code
    lang: string;                // language id for syntax highlighting
    note: string;
    timestamp: number;
}

/** Messages sent from Extension → Webview */
export type ExtensionToWebviewMessage =
    | { type: 'addTrace'; payload: TracePoint }
    | { type: 'syncAll'; payload: TracePoint[] }
    | { type: 'traceRemoved'; payload: { id: string } };

/** Messages sent from Webview → Extension */
export type WebviewToExtensionMessage =
    | { command: 'jumpToCode'; filePath: string; range: [number, number] }
    | { command: 'removeTrace'; id: string }
    | { command: 'reorderTraces'; orderedIds: string[] }
    | { command: 'updateNote'; id: string; note: string }
    | { command: 'ready' };
