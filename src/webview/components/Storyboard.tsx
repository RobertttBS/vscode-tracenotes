import React, { useState, useEffect, useCallback } from 'react';
import {
    DndContext,
    closestCenter,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TraceCard from './TraceCard';
import { onMessage, postMessage } from '../utils/messaging';

interface TracePoint {
    id: string;
    filePath: string;
    lineRange: [number, number];
    content: string;
    lang: string;
    note: string;
    timestamp: number;
}

/** Wrapper that makes a TraceCard sortable via dnd-kit */
const SortableTraceCard: React.FC<{
    trace: TracePoint;
    index: number;
    onUpdateNote: (id: string, note: string) => void;
    onRemove: (id: string) => void;
}> = ({ trace, index, onUpdateNote, onRemove }) => {
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
            <TraceCard
                trace={trace}
                index={index}
                onUpdateNote={onUpdateNote}
                onRemove={onRemove}
            />
        </div>
    );
};

const Storyboard: React.FC = () => {
    const [traces, setTraces] = useState<TracePoint[]>([]);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    );

    // Listen for messages from the extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'addTrace':
                    setTraces(prev => [...prev, message.payload as TracePoint]);
                    break;
                case 'syncAll':
                    setTraces(message.payload as TracePoint[]);
                    break;
                case 'traceRemoved':
                    setTraces(prev =>
                        prev.filter(t => t.id !== (message.payload as { id: string }).id),
                    );
                    break;
            }
        });
        return unsubscribe;
    }, []);

    // Tell the extension we're ready to receive data
    useEffect(() => {
        postMessage({ command: 'ready' });
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) { return; }

        setTraces(prev => {
            const oldIndex = prev.findIndex(t => t.id === active.id);
            const newIndex = prev.findIndex(t => t.id === over.id);
            const newOrder = arrayMove(prev, oldIndex, newIndex);
            // Notify extension
            postMessage({
                command: 'reorderTraces',
                orderedIds: newOrder.map(t => t.id),
            });
            return newOrder;
        });
    }, []);

    const handleUpdateNote = useCallback((id: string, note: string) => {
        setTraces(prev => prev.map(t => (t.id === id ? { ...t, note } : t)));
        postMessage({ command: 'updateNote', id, note });
    }, []);

    const handleRemove = useCallback((id: string) => {
        setTraces(prev => prev.filter(t => t.id !== id));
        postMessage({ command: 'removeTrace', id });
    }, []);

    if (traces.length === 0) {
        return (
            <div className="empty-state">
                <div className="empty-icon">📌</div>
                <p>No traces yet.</p>
                <p className="empty-hint">
                    Select some code and run<br />
                    <strong>MindStack: Collect Trace</strong>
                </p>
            </div>
        );
    }

    return (
        <div className="storyboard">
            <div className="storyboard-header">
                <span className="trace-count">{traces.length} trace{traces.length > 1 ? 's' : ''}</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={traces.map(t => t.id)} strategy={verticalListSortingStrategy}>
                    {traces.map((trace, index) => (
                        <SortableTraceCard
                            key={trace.id}
                            trace={trace}
                            index={index}
                            onUpdateNote={handleUpdateNote}
                            onRemove={handleRemove}
                        />
                    ))}
                </SortableContext>
            </DndContext>
        </div>
    );
};

export default Storyboard;
