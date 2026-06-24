import React, { useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownNoteProps {
    note: string;
    /** Called with the toggled markdown text when a task-list checkbox is clicked */
    onToggleCheckbox: (newNote: string) => void;
    /** Click on the note body (used to enter edit mode) */
    onClick: () => void;
}

/**
 * Toggle the n-th GFM task-list checkbox (`- [ ]` / `- [x]`) in the raw
 * markdown. The index matches react-markdown's render order, which is the
 * document order of the source text.
 */
function toggleCheckboxInMarkdown(text: string, index: number): string {
    let count = 0;
    return text.replace(
        /^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]/gm,
        (match, prefix: string, state: string) => {
            if (count++ === index) {
                const next = state === ' ' ? 'x' : ' ';
                return `${prefix}[${next}]`;
            }
            return match;
        }
    );
}

const MarkdownNote: React.FC<MarkdownNoteProps> = ({ note, onToggleCheckbox, onClick }) => {
    // Reset every render: react-markdown renders checkboxes in document order,
    // so this counter assigns each one a stable source index.
    const checkboxIndex = useRef(0);
    checkboxIndex.current = 0;

    const handleToggle = useCallback((i: number) => {
        onToggleCheckbox(toggleCheckboxInMarkdown(note, i));
    }, [note, onToggleCheckbox]);

    return (
        <div
            className="note-display markdown-note"
            onClick={onClick}
            onPointerDown={(e) => e.stopPropagation()}
            title="Click to edit note"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    input: ({ node, ...props }) => {
                        if (props.type === 'checkbox') {
                            const i = checkboxIndex.current++;
                            return (
                                <input
                                    type="checkbox"
                                    checked={!!props.checked}
                                    onChange={() => handleToggle(i)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                            );
                        }
                        return <input {...props} />;
                    },
                }}
            >
                {note}
            </ReactMarkdown>
        </div>
    );
};

export default React.memo(MarkdownNote);
