import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    Modifier,
} from '@dnd-kit/core';

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
import { TracePoint, MAX_DEPTH } from '../../types';

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
                    marginBottom: 12,
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
    focusedId?: string;
    onUpdateNote: (id: string, note: string) => void;
    onRemove: (id: string) => void;
    onRelocate: (id: string) => void;
    onEnterGroup: (id: string) => void;
    showEnterGroup: boolean;
}> = ({ trace, index, focusedId, onUpdateNote, onRemove, onRelocate, onEnterGroup, showEnterGroup }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: trace.id,
    });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        cursor: 'grab',
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
            <LazyRender forceVisible={focusedId === trace.id}>
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
    );
};

import { ExportIcon, TrashIcon, ListIcon } from './icons';
import { TreeList } from './TreeList';

const Storyboard: React.FC = () => {
    const [traces, setTraces] = useState<TracePoint[]>([]);
    const [treeName, setTreeName] = useState<string>('Trace');
    const [focusedId, setFocusedId] = useState<string | undefined>();
    const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
    const [currentDepth, setCurrentDepth] = useState(0);
    const [breadcrumb, setBreadcrumb] = useState('');
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInputValue, setTitleInputValue] = useState('');
    
    // Tree Management
    const [viewMode, setViewMode] = useState<'trace' | 'list'>('trace');
    const [treeList, setTreeList] = useState<{ id: string; name: string; active: boolean }[]>([]);
    
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

    // Listen for messages from the extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'syncWorkspace': {
                    const payload = message.payload as any; // Type assertion since we might not have full types imported here
                    setTraces(payload.traces);
                    setTreeName(payload.treeName || 'Trace');
                    setCurrentGroupId(payload.activeGroupId);
                    setCurrentDepth(payload.activeDepth);
                    setBreadcrumb(payload.breadcrumb);
                    setTreeList(payload.treeList);
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

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) { return; }

        setTraces(prev => {
            // We need to reorder within the visible (current group) scope
            // But traces state holds the full tree, so we work with visibleTraces IDs
            const oldIndex = visibleTraces.findIndex(t => t.id === active.id);
            const newIndex = visibleTraces.findIndex(t => t.id === over.id);
            if (oldIndex < 0 || newIndex < 0) { return prev; }
            const newOrder = arrayMove(visibleTraces, oldIndex, newIndex);
            // Notify extension
            postMessage({
                command: 'reorderTraces',
                orderedIds: newOrder.map(t => t.id),
            });
            return prev; // Extension will sync back the full tree
        });
    }, [visibleTraces]);

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
                <span className="trace-count">
                    {visibleTraces.length} notes
                </span>
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
                        Select some code and run<br />
                        <strong>TraceNotes: Collect Trace</strong>
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="storyboard">
            {header}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis]}>
                <SortableContext items={visibleTraces.map(t => t.id)} strategy={verticalListSortingStrategy}>
                    {visibleTraces.map((trace, index) => (
                        <div
                            key={trace.id}
                            id={`trace-card-${trace.id}`}
                            className={focusedId === trace.id ? 'highlight-active' : ''}
                        >
                            <SortableTraceCard
                                trace={trace}
                                index={index}
                                focusedId={focusedId}
                                onUpdateNote={handleUpdateNote}
                                onRemove={handleRemove}
                                onRelocate={handleRelocate}
                                onEnterGroup={handleEnterGroup}
                                showEnterGroup={currentDepth < MAX_DEPTH - 1}
                            />
                        </div>
                    ))}
                </SortableContext>
            </DndContext>
        </div>
    );
};

export default Storyboard;
