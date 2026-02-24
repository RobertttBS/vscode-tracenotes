import * as vscode from 'vscode';
import express from 'express';
import cors from 'cors';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TraceManager } from '../traceManager';

export class McpServerManager implements vscode.Disposable {
    private app: express.Express;
    private server?: Server;
    private mcpServer: McpServer;
    private transports = new Map<string, StreamableHTTPServerTransport>();
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;

    constructor(private traceManager: TraceManager) {
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());

        this.outputChannel = vscode.window.createOutputChannel('TraceNotes MCP');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

        this.mcpServer = new McpServer({ name: 'TraceNotes', version: '1.0.0' });
        this.setupRoutes();
        this.registerTools();
    }

    // ── Routes ────────────────────────────────────────────────────

    private setupRoutes(): void {
        // POST /mcp — handles both initialization and subsequent JSON-RPC messages
        this.app.post('/mcp', async (req, res) => {
            try {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                let transport: StreamableHTTPServerTransport;

                if (sessionId && this.transports.has(sessionId)) {
                    // Reuse existing session transport
                    transport = this.transports.get(sessionId)!;
                } else if (!sessionId && isInitializeRequest(req.body)) {
                    // New client: create a stateful transport
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => uuidv4(),
                        onsessioninitialized: (sid) => {
                            this.transports.set(sid, transport);
                            this.outputChannel.appendLine(`[MCP] Session initialized: ${sid}`);
                        },
                    });

                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid) {
                            this.transports.delete(sid);
                            this.outputChannel.appendLine(`[MCP] Session closed: ${sid}`);
                        }
                    };

                    await this.mcpServer.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                    return;
                } else {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Bad Request: missing or invalid session ID' },
                        id: null,
                    });
                    return;
                }

                await transport.handleRequest(req, res, req.body);
            } catch (err: any) {
                this.outputChannel.appendLine(`[MCP] POST error: ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        jsonrpc: '2.0',
                        error: { code: -32603, message: 'Internal server error' },
                        id: null,
                    });
                }
            }
        });

        // GET /mcp — SSE stream for server-to-client notifications
        this.app.get('/mcp', async (req, res) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !this.transports.has(sessionId)) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }
            const transport = this.transports.get(sessionId)!;
            await transport.handleRequest(req, res);
        });

        // DELETE /mcp — explicit session termination
        this.app.delete('/mcp', async (req, res) => {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            if (!sessionId || !this.transports.has(sessionId)) {
                res.status(400).send('Invalid or missing session ID');
                return;
            }
            const transport = this.transports.get(sessionId)!;
            await transport.handleRequest(req, res);
        });
    }

    // ── Tool Registration ─────────────────────────────────────────

    private registerTools(): void {
        // 1. Read — retrieve all traces in the active storyboard
        this.mcpServer.tool(
            'get_storyboard',
            'Retrieve all current trace notes and storyboard items from the active trace tree.',
            {},
            async () => {
                const traces = this.traceManager.getAllFlat();
                return {
                    content: [{ type: 'text', text: JSON.stringify(traces, null, 2) }],
                };
            }
        );

        // 2. Write — add a new trace note
        this.mcpServer.tool(
            'add_trace_note',
            'Add a new trace note to the storyboard. Attach it to a specific code snippet if provided.',
            {
                filePath: z.string().describe('Absolute path to the source file'),
                note: z.string().describe('The note or explanation for this trace'),
                codeSnippet: z.string().optional().describe('Exact code snippet to anchor the trace to'),
            },
            async ({ filePath, note, codeSnippet }) => {
                try {
                    const id = await this.addTraceFromAI(filePath, note, codeSnippet);
                    return {
                        content: [{ type: 'text', text: `Successfully added trace with ID: ${id}` }],
                    };
                } catch (err: any) {
                    return {
                        content: [{ type: 'text', text: `Error: ${err.message}` }],
                        isError: true,
                    };
                }
            }
        );

        // 3. Write — update an existing trace note
        this.mcpServer.tool(
            'update_note',
            'Update the text note on an existing trace by its ID.',
            {
                id: z.string().describe('The ID of the trace to update'),
                note: z.string().describe('The new note text'),
            },
            async ({ id, note }) => {
                const trace = this.traceManager.findTraceById(id);
                if (!trace) {
                    return {
                        content: [{ type: 'text', text: `Error: Trace with ID "${id}" not found.` }],
                        isError: true,
                    };
                }
                this.traceManager.updateNote(id, note);
                return {
                    content: [{ type: 'text', text: `Successfully updated note for trace ID: ${id}` }],
                };
            }
        );

        // 4. Write — delete a trace
        this.mcpServer.tool(
            'delete_trace',
            'Delete a trace note by its ID.',
            {
                id: z.string().describe('The ID of the trace to delete'),
            },
            async ({ id }) => {
                const trace = this.traceManager.findTraceById(id);
                if (!trace) {
                    return {
                        content: [{ type: 'text', text: `Error: Trace with ID "${id}" not found.` }],
                        isError: true,
                    };
                }
                this.traceManager.remove(id);
                return {
                    content: [{ type: 'text', text: `Successfully deleted trace ID: ${id}` }],
                };
            }
        );
    }

    // ── Smart Add Logic ───────────────────────────────────────────

    private async addTraceFromAI(
        filePath: string,
        note: string,
        codeSnippet?: string
    ): Promise<string> {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullText = doc.getText();

        let index = -1;
        if (codeSnippet) {
            index = fullText.indexOf(codeSnippet);
            if (index === -1) {
                // Heuristic fallback: try trimming surrounding whitespace
                index = fullText.indexOf(codeSnippet.trim());
            }
        }

        const snippetLength = (index !== -1 && codeSnippet) ? codeSnippet.length : 0;
        const rangeOffset: [number, number] = index !== -1
            ? [index, index + snippetLength]
            : [0, 0];

        // Derive line range from offset
        let lineRange: [number, number] | undefined;
        if (index !== -1) {
            const startPos = doc.positionAt(rangeOffset[0]);
            const endPos = doc.positionAt(rangeOffset[1]);
            lineRange = [startPos.line, endPos.line];
        }

        const id = uuidv4();
        const newTrace = {
            id,
            filePath: uri.fsPath,
            rangeOffset,
            lineRange,
            content: codeSnippet || '',
            lang: doc.languageId,
            note,
            timestamp: Date.now(),
            orphaned: index === -1 && !!codeSnippet,
        };

        this.traceManager.add(newTrace);
        this.outputChannel.appendLine(`[Tool] add_trace_note: created trace ${id} in ${filePath}`);
        return id;
    }

    // ── Lifecycle ─────────────────────────────────────────────────

    public start(): void {
        this.server = this.app.listen(0, '127.0.0.1', () => {
            const address = this.server?.address() as { port: number } | null;
            if (!address) { return; }

            const port = address.port;
            const mcpUrl = `http://localhost:${port}/mcp`;

            this.outputChannel.appendLine('──────────────────────────────────────────');
            this.outputChannel.appendLine('TraceNotes MCP Server is running.');
            this.outputChannel.appendLine(`Add the following URL to your AI agent config:`);
            this.outputChannel.appendLine(`  ${mcpUrl}`);
            this.outputChannel.appendLine('──────────────────────────────────────────');
            this.outputChannel.show(true);

            this.statusBarItem.text = `$(plug) MCP: ${port}`;
            this.statusBarItem.tooltip = new vscode.MarkdownString(
                `**TraceNotes MCP Server**\n\nRunning at:\n\`${mcpUrl}\`\n\n_Click to copy URL_`
            );
            this.statusBarItem.command = 'tracenotes.copyMcpUrl';
            this.statusBarItem.show();

            // Store URL in context so the copy command can read it
            vscode.commands.executeCommand('setContext', 'tracenotes.mcpUrl', mcpUrl);
        });
    }

    public getUrl(): string | undefined {
        if (!this.server) { return undefined; }
        const address = this.server.address() as { port: number } | null;
        if (!address) { return undefined; }
        return `http://localhost:${address.port}/mcp`;
    }

    public dispose(): void {
        this.statusBarItem.dispose();
        this.outputChannel.dispose();
        this.server?.close();
        for (const transport of this.transports.values()) {
            transport.close();
        }
        this.transports.clear();
    }
}
