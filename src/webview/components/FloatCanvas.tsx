import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { TracePoint } from '../../types';

const INITIAL_SCALE = 0.6;
const MIN_SCALE = 0.15;
const MAX_SCALE = 1.5;
const PAN_MARGIN = 100; // px of canvas content always kept within the viewport

interface FloatCanvasProps {
    traces: TracePoint[];
    currentGroupId: string | null;
    onNavigate: (groupId: string | null, focusId: string) => void;
    onClose: () => void;
}

// ─── FloatCard ────────────────────────────────────────────────────────────────

export interface FloatCardTrace {
    id: string;
    filePath: string;
    content: string;
    note: string;
    highlight?: TracePoint['highlight'];
}

interface FloatCardProps {
    trace: FloatCardTrace;
    parentId: string | null;
    onNavigate: (groupId: string | null, focusId: string) => void;
    highlightQuery?: string;
    idPrefix?: string;
    headerSlot?: React.ReactNode;
}

export const FloatCard: React.FC<FloatCardProps> = React.memo(({ trace, parentId, onNavigate, highlightQuery, idPrefix = 'float-card', headerSlot }) => {
    const fileName = trace.filePath ? trace.filePath.split('/').pop() ?? trace.filePath : '';

    const classNames = [
        'float-card',
        trace.highlight ?? '',
    ].filter(Boolean).join(' ');

    return (
        <div
            id={`${idPrefix}-${trace.id}`}
            className={classNames}
            onClick={(e) => {
                e.stopPropagation();
                onNavigate(parentId, trace.id);
            }}
        >
            {headerSlot}
            {fileName && (
                <div className="float-card-filename">{fileName}</div>
            )}
            {trace.content && (
                <pre className="float-card-code"><code>
                    {highlightQuery ? highlightMatch(trace.content, highlightQuery) : trace.content}
                </code></pre>
            )}
            {trace.note && (
                <div className="float-card-note">
                    {highlightQuery ? highlightMatch(trace.note, highlightQuery) : trace.note}
                </div>
            )}
        </div>
    );
});

// ─── FloatTree ────────────────────────────────────────────────────────────────

interface FloatTreeProps {
    traces: TracePoint[];
    parentId: string | null;
    onNavigate: (groupId: string | null, focusId: string) => void;
}

const FloatTree: React.FC<FloatTreeProps> = React.memo(({ traces, parentId, onNavigate }) => {
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
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function flattenTraces(traces: TracePoint[]): { trace: TracePoint; parentId: string | null }[] {
    const result: { trace: TracePoint; parentId: string | null }[] = [];
    // Reverse root array so first root ends up on top of the stack (pre-order DFS)
    const stack: { trace: TracePoint; parentId: string | null }[] =
        [...traces].reverse().map(t => ({ trace: t, parentId: null }));
    while (stack.length > 0) {
        const item = stack.pop()!;
        result.push(item);
        if (item.trace.children && item.trace.children.length > 0) {
            // Push children in reverse so first child is processed first
            for (let i = item.trace.children.length - 1; i >= 0; i--) {
                stack.push({ trace: item.trace.children[i], parentId: item.trace.id });
            }
        }
    }
    return result;
}

export function highlightMatch(text: string, query: string): React.ReactNode {
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    const parts: React.ReactNode[] = [];
    let last = 0;
    let idx = lower.indexOf(q);
    while (idx !== -1) {
        if (idx > last) { parts.push(text.slice(last, idx)); }
        parts.push(<mark key={idx} className="float-search-highlight">{text.slice(idx, idx + q.length)}</mark>);
        last = idx + q.length;
        idx = lower.indexOf(q, last);
    }
    if (last < text.length) { parts.push(text.slice(last)); }
    return parts;
}

// ─── FloatCanvas ──────────────────────────────────────────────────────────────

const FloatCanvas: React.FC<FloatCanvasProps> = ({ traces, currentGroupId, onNavigate, onClose }) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const panRef = useRef({ x: 20, y: 20 });
    const scaleRef = useRef(INITIAL_SCALE);
    const isDraggingRef = useRef(false);
    const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const dimCacheRef = useRef({ vw: 0, vh: 0, canvasW: 0, canvasH: 0 });
    const rafIdRef = useRef<number | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);

    const filteredCards = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) { return null; }
        return flattenTraces(traces).filter(({ trace }) =>
            (trace.note ?? '').toLowerCase().includes(q) || (trace.content ?? '').toLowerCase().includes(q)
        );
    }, [searchQuery, traces]);

    const applyTransform = useCallback(() => {
        if (canvasRef.current) {
            canvasRef.current.style.transform =
                `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${scaleRef.current})`;
        }
    }, []);

    const updateDimCache = useCallback(() => {
        if (!overlayRef.current || !canvasRef.current) { return; }
        dimCacheRef.current = {
            vw: overlayRef.current.offsetWidth,
            vh: overlayRef.current.offsetHeight,
            canvasW: canvasRef.current.offsetWidth,
            canvasH: canvasRef.current.offsetHeight,
        };
    }, []);

    const clampPan = useCallback(() => {
        const { vw, vh, canvasW, canvasH } = dimCacheRef.current;
        const cw = canvasW * scaleRef.current;
        const ch = canvasH * scaleRef.current;
        panRef.current.x = Math.min(vw - PAN_MARGIN, Math.max(PAN_MARGIN - cw, panRef.current.x));
        panRef.current.y = Math.min(vh - PAN_MARGIN, Math.max(PAN_MARGIN - ch, panRef.current.y));
    }, []);

    const scheduleDraw = useCallback(() => {
        if (rafIdRef.current !== null) { return; }
        rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            clampPan();
            applyTransform();
        });
    }, [clampPan, applyTransform]);

    // Center on the current level after first render
    useEffect(() => {
        applyTransform();

        // rAF ensures the browser has painted the scaled canvas before we measure
        requestAnimationFrame(() => {
            // Populate dimension cache once the canvas is fully laid out
            updateDimCache();

            if (!currentGroupId || !overlayRef.current) { return; }

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

    // Keep dimension cache fresh on viewport resize (debounced — resize fires continuously)
    useEffect(() => {
        let t: ReturnType<typeof setTimeout>;
        const onResize = () => { clearTimeout(t); t = setTimeout(updateDimCache, 100); };
        window.addEventListener('resize', onResize);
        return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
    }, [updateDimCache]);

    // Cancel any pending rAF on unmount
    useEffect(() => {
        return () => { if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); } };
    }, []);

    // Escape key: first clear search, then close
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (searchQuery) {
                    setSearchQuery('');
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose, searchQuery]);

    // Auto-focus search input on mount
    useEffect(() => {
        searchInputRef.current?.focus();
    }, []);

    // Refresh dimension cache when returning from search mode (canvas remounts)
    useEffect(() => {
        if (filteredCards === null) {
            requestAnimationFrame(() => updateDimCache());
        }
    }, [filteredCards, updateDimCache]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (filteredCards !== null) { return; }
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
        } else if (e.shiftKey && e.deltaX === 0) {
            // Windows does not remap shift+scroll to horizontal; do it manually
            panRef.current.x -= e.deltaY;
        } else {
            panRef.current.x -= e.deltaX;
            panRef.current.y -= e.deltaY;
        }
        scheduleDraw();
    }, [scheduleDraw, filteredCards]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        // Only initiate drag on the overlay background, not on cards or search UI
        if (filteredCards !== null) { return; }
        if ((e.target as HTMLElement).closest('.float-card')) { return; }
        // Suppress Windows browser auto-scroll mode triggered by middle mouse button
        if (e.button === 1) { e.preventDefault(); }
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
        if (!isDraggingRef.current || filteredCards !== null) { return; }
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        panRef.current.x = dragStartRef.current.panX + dx;
        panRef.current.y = dragStartRef.current.panY + dy;
        scheduleDraw();
    }, [scheduleDraw, filteredCards]);

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
                data-tooltip="Close (Esc)"
                data-tooltip-pos="bottom-right"
                aria-label="Close"
            >
                ✕
            </button>

            <div className="float-search-bar">
                <input
                    ref={searchInputRef}
                    className="float-search-input"
                    type="text"
                    placeholder="Search notes and code…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                />
                {searchQuery && (
                    <button
                        className="toolbar-btn float-search-clear"
                        onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        aria-label="Clear search"
                    >
                        ✕
                    </button>
                )}
            </div>

            {filteredCards === null ? (
                <div
                    ref={canvasRef}
                    className="float-canvas"
                    style={{ transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${INITIAL_SCALE})` }}
                >
                    <FloatTree traces={traces} parentId={null} onNavigate={onNavigate} />
                </div>
            ) : filteredCards.length === 0 ? (
                <div className="float-search-empty">
                    No results for &ldquo;{searchQuery}&rdquo;
                </div>
            ) : (
                <div
                    className="float-search-results"
                    onWheel={(e) => e.stopPropagation()}
                >
                    {filteredCards.map(({ trace, parentId }) => (
                        <FloatCard key={trace.id} trace={trace} parentId={parentId} onNavigate={onNavigate} highlightQuery={searchQuery} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default FloatCanvas;
