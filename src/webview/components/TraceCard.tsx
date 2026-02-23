import React, { useState, useCallback, useMemo } from 'react';
import { postMessage } from '../utils/messaging';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { vscDarkPlus, prism } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useVSCodeTheme } from '../hooks/useVSCodeTheme';

// Register only the languages we actually need (instead of bundling all ~300)
import tsx from 'refractor/tsx';
import typescript from 'refractor/typescript';
import javascript from 'refractor/javascript';
import python from 'refractor/python';
import json from 'refractor/json';
import bash from 'refractor/bash';
import css from 'refractor/css';
import markdown from 'refractor/markdown';
import type { TracePoint } from '../../types';

SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('markdown', markdown);

interface TraceCardProps {
    trace: TracePoint;
    index: number;
    onUpdateNote: (id: string, note: string) => void;
    onRemove: (id: string) => void;
    onRelocate: (id: string) => void;
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

const TraceCard: React.FC<TraceCardProps> = ({ trace, index, onUpdateNote, onRemove, onRelocate, onEnterGroup, showEnterGroup }) => {
    const themeMode = useVSCodeTheme();
    const syntaxStyle = useMemo(() => {
        return themeMode === 'light' ? prism : vscDarkPlus;
    }, [themeMode]);

    const [editing, setEditing] = useState(false);
    const [isRelocating, setIsRelocating] = useState(false);
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

    // Context Menu State
    const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setMenuPos({ x: e.clientX, y: e.clientY });
    }, []);

    // Close menu on outside click
    React.useEffect(() => {
        if (!menuPos) return;
        const closeMenu = () => setMenuPos(null);
        window.addEventListener('click', closeMenu);
        return () => window.removeEventListener('click', closeMenu);
    }, [menuPos]);

    const updateHighlight = useCallback((color: 'red' | 'blue' | 'green' | 'orange' | 'purple' | null) => {
        postMessage({
            command: 'updateHighlight',
            id: trace.id,
            highlight: color,
        });
        setMenuPos(null);
    }, [trace.id]);

    return (
        <>
            <div
                className={`trace-card ${trace.highlight || ''} ${isRelocating ? 'relocating' : ''} ${trace.orphaned ? 'orphan' : ''}`}
                onContextMenu={handleContextMenu}
            >
                {/* Connector line */}
                <div className="connector-line" />

                {/* Header */}
                <div className="card-header" onClick={handleJump} title="Click to jump to code (Right-click for highlight)">
                    <span className="card-index">{index + 1}</span>
                    <span className="card-file">{fileName}</span>
                    <span className="card-line">
                        {trace.lineRange ? `L${trace.lineRange[0] + 1}–${trace.lineRange[1] + 1}` : 'N/A'}
                    </span>
                    {showEnterGroup && (
                        <button
                            className="enter-group-btn"
                            data-tooltip={trace.children?.length ? 'View child notes' : 'Add child note'}
                            data-tooltip-pos="bottom"
                            onClick={(e) => { e.stopPropagation(); onEnterGroup(trace.id); }}
                        >
                            {trace.children?.length ? `> ${trace.children.length} Childs` : '+ Childs'}
                        </button>
                    )}
                    {isRelocating ? (
                        <>
                            <button
                                className="relocate-confirm-btn"
                                data-tooltip="Confirm Relocation (Update with current selection)"
                                data-tooltip-pos="bottom-right"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRelocate(trace.id);
                                    setIsRelocating(false);
                                }}
                            >
                                ✓
                            </button>
                            <button
                                className="relocate-cancel-btn"
                                data-tooltip="Cancel Relocation"
                                data-tooltip-pos="bottom-right"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setIsRelocating(false);
                                }}
                            >
                                ✕
                            </button>
                        </>
                    ) : (
                        <button
                            className="relocate-btn"
                            data-tooltip="Reselect the codes"
                            data-tooltip-pos="bottom-right"
                            onClick={(e) => {
                                e.stopPropagation();
                                setIsRelocating(true);
                            }}
                        >
                            ✎
                        </button>
                    )}
                    <button
                        className="card-remove"
                        data-tooltip="Remove note"
                        data-tooltip-pos="bottom-right"
                        onClick={(e) => { e.stopPropagation(); onRemove(trace.id); }}
                    >
                        ✕
                    </button>
                </div>

                {/* Code block */}
                <div className="card-code">
                    <SyntaxHighlighter
                        language={mapLanguage(trace.lang)}
                        style={syntaxStyle}
                        customStyle={{
                            margin: 0,
                            padding: '12px',
                            fontSize: 'var(--vscode-editor-font-size, 12px)',
                            fontFamily: 'var(--vscode-editor-font-family, monospace)',
                            lineHeight: '1.5',
                            borderRadius: '0 0 4px 4px',
                            background: 'var(--vscode-editor-background)',
                            border: '1px solid var(--vscode-panel-border)',
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

            </div>

            {/* Context Menu Portal (or fixed overlay) */}
            {menuPos && (
                <div
                    className="context-menu"
                    style={{ top: menuPos.y, left: menuPos.x }}
                    onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
                >
                    <div className="color-option red" onClick={() => updateHighlight('red')} title="Red Highlight" />
                    <div className="color-option blue" onClick={() => updateHighlight('blue')} title="Blue Highlight" />
                    <div className="color-option green" onClick={() => updateHighlight('green')} title="Green Highlight" />
                    <div className="color-option orange" onClick={() => updateHighlight('orange')} title="Orange Highlight" />
                    <div className="color-option purple" onClick={() => updateHighlight('purple')} title="Purple Highlight" />
                    <div className="color-option none" onClick={() => updateHighlight(null)} title="Clear Highlight" />
                </div>
            )}
        </>
    );
};

export default React.memo(TraceCard);
