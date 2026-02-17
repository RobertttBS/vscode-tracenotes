import React, { useState, useCallback } from 'react';
import { TrashIcon } from './icons';

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
    onClose: () => void;
}

export const TreeList: React.FC<TreeListProps> = ({ trees, onSelect, onCreate, onDelete, onImport, onClose }) => {
    const [isCreating, setIsCreating] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [newName, setNewName] = useState('');

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

    return (
        <div className="tree-list-view">
            <div className="storyboard-header">
                <span className="tree-title">Manage Traces</span>
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
                                    // Auto-reset after 3 seconds
                                    setTimeout(() => {
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
                <div style={{ display: 'flex', gap: '8px', padding: '0 12px 12px 12px' }}>
                    <button className="create-tree-btn" style={{ flex: 1 }} onClick={() => setIsCreating(true)}>
                        + New Trace
                    </button>
                    <button className="create-tree-btn" style={{ flex: 1 }} onClick={onImport} data-tooltip="Import Trace from Markdown" data-tooltip-pos="top">
                        Import Trace
                    </button>
                </div>
            )}
        </div>
    );
};
