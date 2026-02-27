import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    DndContext,
    closestCorners,
    pointerWithin,
    PointerSensor,
    useSensor,
    useSensors,
    DragStartEvent,
    DragEndEvent,
    Modifier,
    DragOverlay,
} from '@dnd-kit/core';

/**
 * Custom collision: prefer pointer position for immediacy,
 * fall back to closest corners so tall cards don't miss drops
 * when the cursor grazes the boundary edge.
 */
const customCollisionDetection = (args: Parameters<typeof pointerWithin>[0]) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
        return pointerCollisions;
    }
    return closestCorners(args);
};

const restrictToVerticalAxis: Modifier = ({ transform }) => {
    return {
        ...transform,
        x: 0,
    };
};
import {
    arrayMove,
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TraceCard from './TraceCard';
import { onMessage, postMessage } from '../utils/messaging';
import { useWebviewState } from '../hooks/useWebviewState';
import { TracePoint, MAX_DEPTH } from '../../types';

// Renders only static, non-heavy UI — no SyntaxHighlighter mount,
// no local state — so drag initiation stays at 60 fps.
const TraceCardPreview: React.FC<{ trace: TracePoint; index: number }> = ({ trace, index }) => {
    const fileName = trace.filePath
        ? trace.filePath.replace(/\\/g, '/').split('/').pop() || trace.filePath
        : null;

    return (
        <div className="trace-card">
            <div className="card-header" style={{ cursor: 'grabbing' }}>
                <span className="card-index">{index + 1}</span>
                {fileName && (
                    <>
                        <span className="card-file">{fileName}</span>
                        <span className="card-line">
                            {trace.lineRange
                                ? `L${trace.lineRange[0] + 1}–${trace.lineRange[1] + 1}`
                                : 'N/A'}
                        </span>
                    </>
                )}
            </div>
            {trace.content && (
                <div className="card-code">
                    <pre style={{
                        margin: 0,
                        padding: '12px',
                        fontSize: 'var(--vscode-editor-font-size, 12px)',
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        lineHeight: '1.5',
                        background: 'var(--vscode-editor-background)',
                        overflowX: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                    }}>
                        {trace.content}
                    </pre>
                </div>
            )}
            {trace.note && (
                <div className="card-note">
                    <div className="note-display">{trace.note}</div>
                </div>
            )}
        </div>
    );
};

/**
 * Defers rendering of children until the element scrolls into the viewport.
 * Shows a lightweight placeholder to preserve layout space.
 */
const LazyRender: React.FC<{ height?: number; forceVisible?: boolean; children: React.ReactNode }> = ({
    height = 120,
    forceVisible = false,
    children,
}) => {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (forceVisible) {
            setVisible(true);
            return;
        }
        const el = ref.current;
        if (!el) { return; }

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '200px' }, // pre-load slightly before visible
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [forceVisible]);

    if (!visible) {
        return (
            <div
                ref={ref}
                style={{
                    minHeight: height,
                    background: 'var(--vscode-editor-background, #1e1e1e)',
                    borderRadius: 6,
                    border: '1px solid var(--vscode-panel-border, #333)',
                    opacity: 0.4,
                }}
            />
        );
    }

    return <>{children}</>;
};

/** Wrapper that makes a TraceCard sortable via dnd-kit */
const SortableTraceCard: React.FC<{
    trace: TracePoint;
    index: number;
    isFocused: boolean;
    onUpdateNote: (id: string, note: string) => void;
    onRemove: (id: string) => void;
    onRelocate: (id: string) => void;
    onEnterGroup: (id: string) => void;
    showEnterGroup: boolean;
}> = ({ trace, index, isFocused, onUpdateNote, onRemove, onRelocate, onEnterGroup, showEnterGroup }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: trace.id,
    });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        // Disable transition on the dragged item so it doesn't fight the DragOverlay
        transition: isDragging ? undefined : transition,
        cursor: isDragging ? 'grabbing' : 'grab',
    };

    return (
        <div
            ref={setNodeRef}
            id={`trace-card-${trace.id}`}
            className={isFocused ? 'highlight-active' : ''}
            style={style}
            {...attributes}
            {...listeners}
        >
            {/* Ghost placeholder preserves layout; dashed border signals original position */}
            <div className={isDragging ? 'card-ghost' : undefined}>
                <LazyRender forceVisible={isFocused}>
                    <TraceCard
                        trace={trace}
                        index={index}
                        onUpdateNote={onUpdateNote}
                        onRemove={onRemove}
                        onRelocate={onRelocate}
                        onEnterGroup={onEnterGroup}
                        showEnterGroup={showEnterGroup}
                    />
                </LazyRender>
            </div>
        </div>
    );
};

import { ExportIcon, TrashIcon, ListIcon, PlusIcon } from './icons';
import { TreeList } from './TreeList';

const Storyboard: React.FC = () => {
    // Cached state: hydrated synchronously from vscode.getState(), debounced save on change
    const [traces, setTraces] = useWebviewState<TracePoint[]>('traces', []);
    const [treeName, setTreeName] = useWebviewState<string>('treeName', 'Trace');
    const [currentGroupId, setCurrentGroupId] = useWebviewState<string | null>('currentGroupId', null);
    const [currentDepth, setCurrentDepth] = useWebviewState<number>('currentDepth', 0);
    const [breadcrumb, setBreadcrumb] = useWebviewState<string>('breadcrumb', '');
    const [treeList, setTreeList] = useWebviewState<{ id: string; name: string; active: boolean }[]>('treeList', []);

    // Ephemeral state (not worth caching across tab switches)
    const [focusedId, setFocusedId] = useState<string | undefined>();
    const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInputValue, setTitleInputValue] = useState('');
    const [viewMode, setViewMode] = useState<'trace' | 'list'>('trace');
    const [activeId, setActiveId] = useState<string | null>(null);

    // Fix race condition in saveTitle
    const isEditingRef = useRef(false);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );

    // Recursively find a trace by id in the tree
    const findTraceById = useCallback((id: string, list: TracePoint[]): TracePoint | undefined => {
        for (const t of list) {
            if (t.id === id) { return t; }
            if (t.children?.length) {
                const found = findTraceById(id, t.children);
                if (found) { return found; }
            }
        }
        return undefined;
    }, []);

    // Derive visible traces from the full tree based on currentGroupId
    const visibleTraces = useMemo(() => {
        if (currentGroupId === null) { return traces; }
        const group = findTraceById(currentGroupId, traces);
        return group?.children ?? [];
    }, [traces, currentGroupId, findTraceById]);

    const activeIndex = activeId ? visibleTraces.findIndex(item => item.id === activeId) : null;
    const activeTrace = activeId ? visibleTraces.find(item => item.id === activeId) : null;

    // Listen for messages from the extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'syncWorkspace': {
                    const payload = message.payload as any;
                    setTraces(payload.traces);
                    setTreeName(payload.treeName || 'Trace');
                    setCurrentGroupId(payload.activeGroupId);
                    setCurrentDepth(payload.activeDepth);
                    setBreadcrumb(payload.breadcrumb);
                    setTreeList(payload.treeList);
                    if (payload.focusId) {
                        setFocusedId(payload.focusId);
                        setPendingFocusId(payload.focusId);
                    }
                    break;
                }
                case 'focusCard': {
                    const cardId = (message as { type: string; id: string | null }).id;
                    setFocusedId(cardId ?? undefined);
                    if (cardId) {
                        setTimeout(() => {
                            const el = document.getElementById(`trace-card-${cardId}`);
                            if (el) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }, 50);
                    }
                    break;
                }
            }
        });
        return unsubscribe;
    }, []);

    // Tell the extension we're ready to receive data and get the initial tree list
    useEffect(() => {
        postMessage({ command: 'ready' });
    }, []);

    // Scroll to a newly created card
    useEffect(() => {
        if (!pendingFocusId) { return; }
        
        // The DOM is already flushed by the time useEffect runs.
        const el = document.getElementById(`trace-card-${pendingFocusId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        
        // Clear it so it doesn't re-run if visibleTraces changes for another reason
        setPendingFocusId(null); 
        
    }, [pendingFocusId]);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);
        if (!over || active.id === over.id) { return; }

        // 1. Calculate purely for the extension message using current visible scope.
        const oldIndex = visibleTraces.findIndex(t => t.id === active.id);
        const newIndex = visibleTraces.findIndex(t => t.id === over.id);
        if (oldIndex < 0 || newIndex < 0) { return; }

        const messageOrder = arrayMove(visibleTraces, oldIndex, newIndex);

        // Notify extension so it can persist the new order.
        postMessage({
            command: 'reorderTraces',
            orderedIds: messageOrder.map(t => t.id),
        });

        // 2. Strict functional update — re-derive indices from `prev` so we never
        //    overwrite state that may have been updated by a background sync event
        //    while the drag was in progress.
        setTraces(prev => {
            if (currentGroupId === null) {
                // Root level: recalculate against `prev` directly.
                const prevOldIdx = prev.findIndex(t => t.id === active.id);
                const prevNewIdx = prev.findIndex(t => t.id === over.id);
                if (prevOldIdx < 0 || prevNewIdx < 0) { return prev; }
                return arrayMove(prev, prevOldIdx, prevNewIdx);
            }

            // Group level: recursively find the parent and swap its fresh children.
            const updateChildren = (list: TracePoint[]): TracePoint[] =>
                list.map(t => {
                    if (t.id === currentGroupId) {
                        const children = t.children || [];
                        const prevOldIdx = children.findIndex(c => c.id === active.id);
                        const prevNewIdx = children.findIndex(c => c.id === over.id);
                        if (prevOldIdx < 0 || prevNewIdx < 0) { return t; }
                        return { ...t, children: arrayMove(children, prevOldIdx, prevNewIdx) };
                    }
                    if (t.children?.length) {
                        return { ...t, children: updateChildren(t.children) };
                    }
                    return t;
                });
            return updateChildren(prev);
        });
    }, [visibleTraces, currentGroupId]);

    const handleUpdateNote = useCallback((id: string, note: string) => {
        // Recursively update note in the tree so child-level changes
        // produce new object references along the path → triggers re-render.
        const updateNoteInTree = (list: TracePoint[]): TracePoint[] => {
            let changed = false;
            const result = list.map(t => {
                if (t.id === id) {
                    changed = true;
                    return { ...t, note };
                }
                if (t.children?.length) {
                    const newChildren = updateNoteInTree(t.children);
                    if (newChildren !== t.children) {
                        changed = true;
                        return { ...t, children: newChildren };
                    }
                }
                return t;
            });
            return changed ? result : list;
        };
        setTraces(prev => updateNoteInTree(prev));
        postMessage({ command: 'updateNote', id, note });
    }, []);

    const handleRemove = useCallback((id: string) => {
        postMessage({ command: 'removeTrace', id });
    }, []);

    const handleRelocate = useCallback((id: string) => {
        postMessage({ command: 'relocateTrace', id });
    }, []);

    const handleEnterGroup = useCallback((id: string) => {
        postMessage({ command: 'enterGroup', id });
    }, []);

    const handleExitGroup = useCallback(() => {
        postMessage({ command: 'exitGroup' });
    }, []);

    const handleClearAll = useCallback(() => {
        postMessage({ command: 'clearCurrentLevel' });
    }, []);

    const handleExport = useCallback(() => {
        postMessage({ command: 'exportToMarkdown' });
    }, []);

    const handleAddTrace = useCallback(() => {
        postMessage({ command: 'addEmptyTrace' });
    }, []);
    
    // Title Editing
    const startEditingTitle = useCallback(() => {
        setTitleInputValue(treeName);
        isEditingRef.current = true;
        setIsEditingTitle(true);
    }, [treeName]);

    const saveTitle = useCallback(() => {
        if (!isEditingRef.current) return;
        isEditingRef.current = false;

        const newName = titleInputValue.trim();
        if (newName && newName !== treeName) {
            setTreeName(newName);
            postMessage({ command: 'renameTree', name: newName });
        }
        setIsEditingTitle(false);
    }, [titleInputValue, treeName]);

    const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            saveTitle();
        } else if (e.key === 'Escape') {
            setIsEditingTitle(false);
        }
    }, [saveTitle]);

    // Tree Management Handlers
    const handleSwitchTree = useCallback((id: string) => {
        postMessage({ command: 'switchTree', id });
        setViewMode('trace');
    }, []);

    const handleDeleteTree = useCallback((id: string) => {
        postMessage({ command: 'deleteTree', id });
    }, []);

    const handleCreateTree = useCallback((name: string) => {
        postMessage({ command: 'createTree', name });
        setViewMode('trace');
    }, []);

    const handleImportTrace = useCallback(() => {
        postMessage({ command: 'importTrace' });
        setViewMode('trace');
    }, []);

    if (viewMode === 'list') {
        return (
            <TreeList
                trees={treeList}
                onSelect={handleSwitchTree}
                onCreate={handleCreateTree}
                onDelete={handleDeleteTree}
                onImport={handleImportTrace}
                onClose={() => setViewMode('trace')}
            />
        );
    }

    const header = (
        <div className="storyboard-header">
            <button 
                className="toolbar-btn list-btn" 
                onClick={() => setViewMode('list')}
                data-tooltip="Manage Traces"
                data-tooltip-pos="bottom-left"
                style={{ marginRight: 8 }}
            >
                <ListIcon />
            </button>

            {currentGroupId ? (
                // Group Navigation Header
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                    <button className="back-button" onClick={handleExitGroup}>← Back</button>
                    {breadcrumb && <span className="breadcrumb-label">📍 {breadcrumb}</span>}
                </div>
            ) : (
                // Root Level: Show Editable Tree Title
                <div className="tree-title-container">
                    {isEditingTitle ? (
                        <input
                            className="tree-title-input"
                            value={titleInputValue}
                            onChange={(e) => setTitleInputValue(e.target.value)}
                            onBlur={saveTitle}
                            onKeyDown={handleTitleKeyDown}
                            autoFocus
                        />
                    ) : (
                        <div 
                            className="tree-title" 
                            onClick={startEditingTitle}
                            data-tooltip="Click to rename trace"
                            data-tooltip-pos="bottom-right"
                        >
                            {treeName}
                        </div>
                    )}
                </div>
            )}
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>

                <button
                    className="toolbar-btn add-btn"
                    onClick={handleAddTrace}
                    data-tooltip="Add Empty Note"
                    data-tooltip-pos="bottom-right"
                >
                    <PlusIcon />
                </button>
                <button
                    className="toolbar-btn export-btn"
                    onClick={handleExport}
                    data-tooltip="Export to Markdown"
                    data-tooltip-pos="bottom-right"
                >
                    <ExportIcon />
                </button>
                <button
                    className="toolbar-btn clear-all-btn"
                    onClick={handleClearAll}
                    data-tooltip="Clear Notes in Current Level"
                    data-tooltip-pos="bottom-right"
                >
                    <TrashIcon />
                </button>
            </div>
        </div>
    );

    if (visibleTraces.length === 0) {
        return (
            <div className="storyboard">
                {header}
                <div className="empty-state">
                    <div className="empty-icon">📌</div>
                    <p>{currentGroupId ? 'No child traces yet.' : 'No traces yet.'}</p>
                    <p className="empty-hint">
                        Select some code and press <kbd>Alt+C</kbd> (or <kbd>Opt+C</kbd>) <br />
                        or run <strong>TraceNotes: Collect Trace</strong>
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="storyboard">
            {header}
            <DndContext sensors={sensors} collisionDetection={customCollisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis]}>
                <SortableContext items={visibleTraces.map(t => t.id)} strategy={verticalListSortingStrategy}>
                    <div className="trace-list">
                        {visibleTraces.map((trace, index) => (
                            <SortableTraceCard
                                key={trace.id}
                                trace={trace}
                                index={index}
                                isFocused={focusedId === trace.id}
                                onUpdateNote={handleUpdateNote}
                                onRemove={handleRemove}
                                onRelocate={handleRelocate}
                                onEnterGroup={handleEnterGroup}
                                showEnterGroup={currentDepth < MAX_DEPTH - 1}
                            />
                        ))}
                    </div>
                </SortableContext>
                {/* dropAnimation={null}: overlay vanishes instantly on drop so the
                    re-rendered list takes over without a positional race condition. */}
                <DragOverlay dropAnimation={null}>
                    {activeId && activeTrace ? (
                        <div className="drag-overlay-active">
                            <TraceCardPreview
                                trace={activeTrace}
                                index={activeIndex ?? 0}
                            />
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>
        </div>
    );
};

export default Storyboard;
