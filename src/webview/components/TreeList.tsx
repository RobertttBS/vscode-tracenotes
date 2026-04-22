import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { TrashIcon, SearchIcon } from './icons';
import { SearchableTrace, SearchableTree } from '../../types';
import { FloatCard } from './FloatCanvas';

interface TreeItem {
    id: string;
    name: string;
    active: boolean;
}

interface TreeListProps {
    trees: TreeItem[];
    onSelect: (id: string) => void;
    onCreate: (name: string) => void;
    onDelete: (id: string) => void;
    onImport: () => void;
    onExport: () => void;
    onClose: () => void;
    allTreeData: SearchableTree[] | null;
    onNavigateToTrace: (treeId: string, groupId: string | null, focusId: string) => void;
    onRequestAllTrees: () => void;
}

function flattenTraces(traces: SearchableTrace[]): { trace: SearchableTrace; parentId: string | null }[] {
    const result: { trace: SearchableTrace; parentId: string | null }[] = [];
    const stack: { trace: SearchableTrace; parentId: string | null }[] = [];
    for (let i = traces.length - 1; i >= 0; i--) {
        stack.push({ trace: traces[i], parentId: null });
    }
    while (stack.length > 0) {
        const { trace, parentId } = stack.pop()!;
        result.push({ trace, parentId });
        if (trace.children?.length) {
            for (let i = trace.children.length - 1; i >= 0; i--) {
                stack.push({ trace: trace.children[i], parentId: trace.id });
            }
        }
    }
    return result;
}

export const TreeList: React.FC<TreeListProps> = ({
    trees, onSelect, onCreate, onDelete, onImport, onExport, onClose,
    allTreeData, onNavigateToTrace, onRequestAllTrees,
}) => {
    const [isCreating, setIsCreating] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [newName, setNewName] = useState('');
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        return () => {
            if (deleteConfirmTimerRef.current) { clearTimeout(deleteConfirmTimerRef.current); }
        };
    }, []);

    useEffect(() => {
        if (isSearchMode) {
            searchInputRef.current?.focus();
        }
    }, [isSearchMode]);

    const handleCreate = useCallback(() => {
        if (!newName.trim()) return;
        onCreate(newName.trim());
        setNewName('');
        setIsCreating(false);
    }, [newName, onCreate]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleCreate();
        } else if (e.key === 'Escape') {
            setIsCreating(false);
            setNewName('');
        }
    }, [handleCreate]);

    const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setSearchQuery('');
            setIsSearchMode(false);
        }
    }, []);

    const toggleSearchMode = useCallback(() => {
        if (isSearchMode) {
            setSearchQuery('');
            setIsSearchMode(false);
        } else {
            setIsSearchMode(true);
            onRequestAllTrees();
        }
    }, [isSearchMode, onRequestAllTrees]);

    const flattenedTrees = useMemo(() => {
        if (!allTreeData) { return null; }
        return allTreeData.map(tree => ({
            treeId: tree.id,
            treeName: tree.name,
            entries: flattenTraces(tree.traces),
        }));
    }, [allTreeData]);

    const filteredResults = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q || !flattenedTrees) { return null; }
        const results: {
            treeId: string;
            treeName: string;
            trace: SearchableTrace;
            parentId: string | null;
        }[] = [];
        for (const { treeId, treeName, entries } of flattenedTrees) {
            for (const { trace, parentId } of entries) {
                const matched =
                    (trace.note ?? '').toLowerCase().includes(q) ||
                    (trace.content ?? '').toLowerCase().includes(q);
                if (matched) {
                    results.push({ treeId, treeName, trace, parentId });
                }
            }
        }
        return results;
    }, [searchQuery, flattenedTrees]);

    if (isSearchMode) {
        return (
            <div className="tree-list-view">
                <div className="storyboard-header">
                    <span className="tree-title">Search All Traces</span>
                    <button
                        className="toolbar-btn float-btn"
                        onClick={toggleSearchMode}
                        title="Exit search"
                        style={{ marginRight: 4 }}
                    >
                        <SearchIcon />
                    </button>
                    <button className="close-btn" onClick={onClose} title="Close">✕</button>
                </div>

                <div style={{ padding: '8px 12px' }}>
                    <div className="float-search-bar" style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', width: '100%', boxSizing: 'border-box' }}>
                        <input
                            ref={searchInputRef}
                            className="float-search-input"
                            placeholder="Search notes and code…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                        />
                        {searchQuery && (
                            <button
                                className="float-search-clear"
                                onClick={() => setSearchQuery('')}
                                title="Clear"
                            >✕</button>
                        )}
                    </div>
                </div>

                <div className="tree-search-results-container">
                    {searchQuery.trim() && allTreeData === null ? (
                        <div className="float-search-empty" style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', padding: '16px 12px', textAlign: 'center' }}>
                            Loading…
                        </div>
                    ) : filteredResults === null ? null : filteredResults.length === 0 ? (
                        <div className="float-search-empty" style={{ position: 'relative', top: 'auto', left: 'auto', transform: 'none', padding: '16px 12px', textAlign: 'center' }}>
                            No results for &ldquo;{searchQuery}&rdquo;
                        </div>
                    ) : (
                        filteredResults.map(({ treeId, treeName, trace, parentId }) => (
                            <FloatCard
                                key={`${treeId}-${trace.id}`}
                                trace={trace}
                                parentId={parentId}
                                idPrefix={`tree-search-${treeId}`}
                                highlightQuery={searchQuery.trim()}
                                onNavigate={(groupId, focusId) => onNavigateToTrace(treeId, groupId, focusId)}
                                headerSlot={<div className="tree-search-result-tree"><span className="tree-name-badge">{treeName}</span></div>}
                            />
                        ))
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="tree-list-view">
            <div className="storyboard-header">
                <span className="tree-title">Manage Traces</span>
                <button
                    className="toolbar-btn float-btn"
                    onClick={toggleSearchMode}
                    title="Search all traces"
                    style={{ marginRight: 4 }}
                >
                    <SearchIcon />
                </button>
                <button className="close-btn" onClick={onClose} title="Close">✕</button>
            </div>

            <div className="tree-list-content">
                {trees.map(tree => (
                    <div
                        key={tree.id}
                        className={`tree-item ${tree.active ? 'active' : ''}`}
                        onClick={() => onSelect(tree.id)}
                    >
                        <div className="tree-item-name">
                            {tree.active && <span className="active-indicator">●</span>}
                            {tree.name}
                        </div>
                        <button
                            className={`tree-delete-btn ${deleteConfirmId === tree.id ? 'confirming' : ''}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (deleteConfirmId === tree.id) {
                                    onDelete(tree.id);
                                    setDeleteConfirmId(null);
                                } else {
                                    setDeleteConfirmId(tree.id);
                                    if (deleteConfirmTimerRef.current) { clearTimeout(deleteConfirmTimerRef.current); }
                                    deleteConfirmTimerRef.current = setTimeout(() => {
                                        deleteConfirmTimerRef.current = undefined;
                                        setDeleteConfirmId(prev => prev === tree.id ? null : prev);
                                    }, 3000);
                                }
                            }}
                            title={deleteConfirmId === tree.id ? "Click again to confirm delete" : "Delete Trace"}
                        >
                            {deleteConfirmId === tree.id ? (
                                <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#ff4d4d' }}>Confirm</span>
                            ) : (
                                <TrashIcon />
                            )}
                        </button>
                    </div>
                ))}
            </div>

            {isCreating ? (
                <div className="create-tree-form">
                    <input
                        className="create-tree-input"
                        placeholder="Trace Name..."
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                    <button className="create-tree-confirm" onClick={handleCreate}>Create</button>
                    <button className="create-tree-cancel" onClick={() => setIsCreating(false)}>Cancel</button>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '0 12px 12px 12px' }}>
                    <button className="create-tree-btn" onClick={() => setIsCreating(true)}>
                        + New Trace
                    </button>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="create-tree-btn" style={{ flex: 1 }} onClick={onImport} data-tooltip="Import from Markdown or data.json" data-tooltip-pos="top">
                            Import
                        </button>
                        <button className="create-tree-btn" style={{ flex: 1 }} onClick={onExport} data-tooltip="Export all trees to data.json" data-tooltip-pos="top">
                            Export
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
