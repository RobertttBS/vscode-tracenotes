import React, { useEffect, useRef, useCallback } from 'react';
import { TracePoint } from '../../types';

const INITIAL_SCALE = 0.6;
const MIN_SCALE = 0.15;
const MAX_SCALE = 1.5;

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
    onNavigate: (groupId: string | null, focusId: string) => void;
}

const FloatCard: React.FC<FloatCardProps> = ({ trace, parentId, onNavigate }) => {
    const fileName = trace.filePath ? trace.filePath.split('/').pop() ?? trace.filePath : '';

    const classNames = [
        'float-card',
        trace.highlight ?? '',
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
    onNavigate: (groupId: string | null, focusId: string) => void;
}

const FloatTree: React.FC<FloatTreeProps> = ({ traces, parentId, onNavigate }) => {
    return (
        <>
            {traces.map((trace) => {
                return (
                    <div key={trace.id} className="float-trace-group">
                        <FloatCard
                            trace={trace}
                            parentId={parentId}
                            onNavigate={onNavigate}
                        />
                        {trace.children && trace.children.length > 0 && (
                            <div className="float-children">
                                <FloatTree
                                    traces={trace.children}
                                    parentId={trace.id}
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
    const scaleRef = useRef(INITIAL_SCALE);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

    const applyTransform = useCallback(() => {
        if (canvasRef.current) {
            canvasRef.current.style.transform =
                `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${scaleRef.current})`;
        }
    }, []);

    // Center on the current level after first render
    useEffect(() => {
        applyTransform();

        if (!currentGroupId || !overlayRef.current) { return; }

        // rAF ensures the browser has painted the scaled canvas before we measure
        requestAnimationFrame(() => {
            if (!overlayRef.current) { return; }

            // Find the parent card, then its .float-children container (= the active level)
            const parentCard = document.getElementById(`float-card-${currentGroupId}`);
            if (!parentCard) { return; }
            const groupDiv = parentCard.parentElement;
            const childrenContainer = groupDiv?.querySelector(':scope > .float-children') as HTMLElement | null;
            const target = childrenContainer ?? parentCard;

            // Use getBoundingClientRect for accurate post-transform positions
            const overlayRect = overlayRef.current.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();

            const vw = overlayRect.width;
            const vh = overlayRect.height;

            // Shift pan so target center lands at overlay center
            const targetCenterX = targetRect.left - overlayRect.left + targetRect.width / 2;
            const targetCenterY = targetRect.top - overlayRect.top + targetRect.height / 2;

            panRef.current.x += vw / 2 - targetCenterX;
            panRef.current.y += vh / 2 - targetCenterY;
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
        if (e.ctrlKey || e.metaKey) {
            // Zoom toward cursor position
            const oldScale = scaleRef.current;
            const delta = e.deltaY > 0 ? 0.97 : 1.03;
            const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * delta));
            const ratio = newScale / oldScale;
            panRef.current.x = e.clientX - (e.clientX - panRef.current.x) * ratio;
            panRef.current.y = e.clientY - (e.clientY - panRef.current.y) * ratio;
            scaleRef.current = newScale;
        } else {
            panRef.current.x -= e.deltaX;
            panRef.current.y -= e.deltaY;
        }
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
                style={{ transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${INITIAL_SCALE})` }}
            >
                <FloatTree
                    traces={traces}
                    parentId={null}
                    onNavigate={onNavigate}
                />
            </div>
        </div>
    );
};

export default FloatCanvas;
