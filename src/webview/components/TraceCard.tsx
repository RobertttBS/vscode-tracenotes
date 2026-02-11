import React, { useState, useCallback, useMemo } from 'react';
import { postMessage } from '../utils/messaging';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

// Register only the languages we actually need (instead of bundling all ~300)
import tsx from 'refractor/lang/tsx';
import typescript from 'refractor/lang/typescript';
import javascript from 'refractor/lang/javascript';
import python from 'refractor/lang/python';
import json from 'refractor/lang/json';
import bash from 'refractor/lang/bash';
import css from 'refractor/lang/css';
import markdown from 'refractor/lang/markdown';

SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('markdown', markdown);

interface TracePoint {
    id: string;
    filePath: string;
    lineRange: [number, number];
    content: string;
    lang: string;
    note: string;
    timestamp: number;
    children?: TracePoint[];
}

interface TraceCardProps {
    trace: TracePoint;
    index: number;
    onUpdateNote: (id: string, note: string) => void;
    onRemove: (id: string) => void;
    onEnterGroup: (id: string) => void;
    showEnterGroup: boolean;
}

/** Map common VS Code languageIds to Prism language names */
function mapLanguage(lang: string): string {
    const map: Record<string, string> = {
        typescriptreact: 'tsx',
        javascriptreact: 'jsx',
        shellscript: 'bash',
        plaintext: 'text',
    };
    return map[lang] || lang;
}

const TraceCard: React.FC<TraceCardProps> = ({ trace, index, onUpdateNote, onRemove, onEnterGroup, showEnterGroup }) => {
    const [editing, setEditing] = useState(false);
    const [noteValue, setNoteValue] = useState(trace.note);

    const fileName = useMemo(() => {
        const parts = trace.filePath.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || trace.filePath;
    }, [trace.filePath]);

    const handleJump = useCallback(() => {
        postMessage({
            command: 'jumpToCode',
            filePath: trace.filePath,
            range: trace.lineRange,
        });
    }, [trace]);

    const handleNoteSave = useCallback(() => {
        setEditing(false);
        onUpdateNote(trace.id, noteValue);
    }, [trace.id, noteValue, onUpdateNote]);

    const handleNoteKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleNoteSave();
        }
        if (e.key === 'Escape') {
            setEditing(false);
            setNoteValue(trace.note);
        }
    }, [handleNoteSave, trace.note]);

    return (
        <div className="trace-card">
            {/* Connector line */}
            <div className="connector-line" />

            {/* Header */}
            <div className="card-header" onClick={handleJump} title="Click to jump to code">
                <span className="card-index">{index + 1}</span>
                <span className="card-file">{fileName}</span>
                <span className="card-line">L{trace.lineRange[0] + 1}–{trace.lineRange[1] + 1}</span>
                <button
                    className="card-remove"
                    title="Remove trace"
                    onClick={(e) => { e.stopPropagation(); onRemove(trace.id); }}
                >
                    ✕
                </button>
            </div>

            {/* Code block */}
            <div className="card-code">
                <SyntaxHighlighter
                    language={mapLanguage(trace.lang)}
                    style={vscDarkPlus}
                    customStyle={{
                        margin: 0,
                        padding: '8px',
                        fontSize: '12px',
                        borderRadius: '0 0 4px 4px',
                        background: 'var(--vscode-editor-background, #1e1e1e)',
                    }}
                    wrapLongLines
                >
                    {trace.content}
                </SyntaxHighlighter>
            </div>

            {/* Note */}
            <div className="card-note">
                {editing ? (
                    <textarea
                        className="note-input"
                        value={noteValue}
                        onChange={(e) => setNoteValue(e.target.value)}
                        onBlur={handleNoteSave}
                        onKeyDown={handleNoteKeyDown}
                        placeholder="Add a note..."
                        autoFocus
                    />
                ) : (
                    <div
                        className="note-display"
                        onClick={() => setEditing(true)}
                        title="Click to edit note"
                    >
                        {trace.note || <span className="note-placeholder">Click to add a note…</span>}
                    </div>
                )}
            </div>
            {/* Enter group */}
            {showEnterGroup && (
                <div className="card-group">
                    <button
                        className="enter-group-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterGroup(trace.id); }}
                    >
                        {trace.children?.length ? 'View Childs ›' : 'Add Childs +'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default React.memo(TraceCard);
