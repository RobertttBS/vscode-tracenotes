import React, { useEffect, useRef, useCallback } from 'react';
import { TracePoint } from '../../types';

const SCALE = 0.45;

interface FloatCanvasProps {
    traces: TracePoint[];
    currentGroupId: string | null;
    onNavigate: (groupId: string | null, focusId: string) => void;
    onClose: () => void;
}

// ─── FloatCard ────────────────────────────────────────────────────────────────

interface FloatCardProps {
    trace: TracePoint;
    parentId: string | null;
    isActiveGroup: boolean;
    isActiveLevel: boolean;
    onNavigate: (groupId: string | null, focusId: string) => void;
}

const FloatCard: React.FC<FloatCardProps> = ({ trace, parentId, isActiveGroup, isActiveLevel, onNavigate }) => {
    const fileName = trace.filePath ? trace.filePath.split('/').pop() ?? trace.filePath : '';

    const classNames = [
        'float-card',
        isActiveGroup ? 'float-card--active-group' : '',
        isActiveLevel ? 'float-card--active-level' : '',
    ].filter(Boolean).join(' ');

    return (
        <div
            id={`float-card-${trace.id}`}
            className={classNames}
            onClick={(e) => {
                e.stopPropagation();
                onNavigate(parentId, trace.id);
            }}
        >
            {fileName && (
                <div className="float-card-filename">{fileName}</div>
            )}
            {trace.content && (
                <pre className="float-card-code"><code>{trace.content}</code></pre>
            )}
            {trace.note && (
                <div className="float-card-note">{trace.note}</div>
            )}
        </div>
    );
};

// ─── FloatTree ────────────────────────────────────────────────────────────────

interface FloatTreeProps {
    traces: TracePoint[];
    parentId: string | null;
    currentGroupId: string | null;
    onNavigate: (groupId: string | null, focusId: string) => void;
}

const FloatTree: React.FC<FloatTreeProps> = ({ traces, parentId, currentGroupId, onNavigate }) => {
    return (
        <>
            {traces.map((trace) => {
                const isActiveGroup = trace.id === currentGroupId;
                // A trace is at the "active level" if its parent is the current group
                // (i.e., it's one of the traces visible in normal mode)
                const isActiveLevel = parentId === currentGroupId && !isActiveGroup;

                return (
                    <div key={trace.id} className="float-trace-group">
                        <FloatCard
                            trace={trace}
                            parentId={parentId}
                            isActiveGroup={isActiveGroup}
                            isActiveLevel={isActiveLevel}
                            onNavigate={onNavigate}
                        />
                        {trace.children && trace.children.length > 0 && (
                            <div className="float-children">
                                <FloatTree
                                    traces={trace.children}
                                    parentId={trace.id}
                                    currentGroupId={currentGroupId}
                                    onNavigate={onNavigate}
                                />
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
};

// ─── FloatCanvas ──────────────────────────────────────────────────────────────

const FloatCanvas: React.FC<FloatCanvasProps> = ({ traces, currentGroupId, onNavigate, onClose }) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const panRef = useRef({ x: 20, y: 20 });
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

    const applyTransform = useCallback(() => {
        if (canvasRef.current) {
            canvasRef.current.style.transform =
                `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${SCALE})`;
        }
    }, []);

    // Center on the current group after first render
    useEffect(() => {
        applyTransform();

        if (!currentGroupId) { return; }

        // Use rAF to ensure layout is complete before measuring
        requestAnimationFrame(() => {
            const target = document.getElementById(`float-card-${currentGroupId}`);
            if (!target || !overlayRef.current) { return; }

            const vw = overlayRef.current.clientWidth;
            const vh = overlayRef.current.clientHeight;
            // offsetLeft/offsetTop give unscaled position within the canvas
            const el = target as HTMLElement;
            let offsetLeft = el.offsetLeft;
            let offsetTop = el.offsetTop;
            let parent = el.offsetParent as HTMLElement | null;
            while (parent && parent !== canvasRef.current) {
                offsetLeft += parent.offsetLeft;
                offsetTop += parent.offsetTop;
                parent = parent.offsetParent as HTMLElement | null;
            }

            panRef.current = {
                x: vw / 2 - offsetLeft * SCALE - (el.offsetWidth * SCALE) / 2,
                y: vh / 2 - offsetTop * SCALE - (el.offsetHeight * SCALE) / 2,
            };
            applyTransform();
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Escape key to close
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { onClose(); }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        e.preventDefault();
        panRef.current.x -= e.deltaX;
        panRef.current.y -= e.deltaY;
        applyTransform();
    }, [applyTransform]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        // Only initiate drag on the overlay background, not on cards
        if ((e.target as HTMLElement).closest('.float-card')) { return; }
        isDraggingRef.current = true;
        dragStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            panX: panRef.current.x,
            panY: panRef.current.y,
        };
        if (overlayRef.current) {
            overlayRef.current.classList.add('dragging');
        }
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isDraggingRef.current) { return; }
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        panRef.current.x = dragStartRef.current.panX + dx;
        panRef.current.y = dragStartRef.current.panY + dy;
        applyTransform();
    }, [applyTransform]);

    const stopDrag = useCallback(() => {
        isDraggingRef.current = false;
        if (overlayRef.current) {
            overlayRef.current.classList.remove('dragging');
        }
    }, []);

    return (
        <div
            ref={overlayRef}
            className="float-overlay"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={stopDrag}
            onMouseLeave={stopDrag}
        >
            <button
                className="toolbar-btn float-close-btn"
                onClick={onClose}
                data-tooltip="Close Overview (Esc)"
                data-tooltip-pos="bottom-right"
                aria-label="Close float overview"
            >
                ✕
            </button>

            <div
                ref={canvasRef}
                className="float-canvas"
                style={{ transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${SCALE})` }}
            >
                <FloatTree
                    traces={traces}
                    parentId={null}
                    currentGroupId={currentGroupId}
                    onNavigate={onNavigate}
                />
            </div>
        </div>
    );
};

export default FloatCanvas;
