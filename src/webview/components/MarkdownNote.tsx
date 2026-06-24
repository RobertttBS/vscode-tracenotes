import React, { useRef, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toggleCheckboxInMarkdown } from '../utils/toggleCheckboxInMarkdown';

interface MarkdownNoteProps {
    note: string;
    /** Called with the toggled markdown text when a task-list checkbox is clicked */
    onToggleCheckbox: (newNote: string) => void;
    /** Click on the note body (used to enter edit mode) */
    onClick: () => void;
}

// Stable across renders so react-markdown doesn't re-parse plugins each time.
const REMARK_PLUGINS = [remarkGfm];

const MarkdownNote: React.FC<MarkdownNoteProps> = ({ note, onToggleCheckbox, onClick }) => {
    // Reset every render: react-markdown renders checkboxes in document order,
    // so this counter assigns each one a stable source index.
    const checkboxIndex = useRef(0);
    checkboxIndex.current = 0;

    // Hold the latest toggle in a ref so `components` can stay referentially
    // stable. react-markdown uses each renderer as the element type, so a fresh
    // object every render would remount the checkbox/link nodes on each update.
    const toggleRef = useRef<(i: number) => void>(() => {});
    toggleRef.current = (i: number) => onToggleCheckbox(toggleCheckboxInMarkdown(note, i));

    const components = useMemo<Components>(() => ({
        input: ({ node, ...props }) => {
            if (props.type === 'checkbox') {
                const i = checkboxIndex.current++;
                return (
                    <input
                        type="checkbox"
                        checked={!!props.checked}
                        onChange={() => toggleRef.current(i)}
                        onClick={(e) => e.stopPropagation()}
                    />
                );
            }
            return <input {...props} />;
        },
        // Let the link open (VS Code handles webview anchor clicks)
        // without bubbling up and entering note edit mode.
        a: ({ node, ...props }) => (
            <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
            />
        ),
    }), []);

    return (
        <div
            className="note-display markdown-note"
            onClick={onClick}
            onPointerDown={(e) => e.stopPropagation()}
            title="Click to edit note"
        >
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
                {note}
            </ReactMarkdown>
        </div>
    );
};

export default React.memo(MarkdownNote);
