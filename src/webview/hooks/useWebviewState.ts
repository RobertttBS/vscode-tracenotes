import { useState, useCallback } from 'react';
import { saveState, loadState } from '../utils/messaging';

// Module-level cache hydrated from the webview's persisted state. The keyset is a
// fixed set of literals (one per useWebviewState call site), so no eviction is needed.
const stateCache = new Map<string, any>(
    Object.entries(loadState<Record<string, any>>() ?? {})
);
let timeout: ReturnType<typeof setTimeout> | undefined;

/**
 * Enhanced useWebviewState
 * Synchronously hydrates from cache, avoids race conditions via a shared memory cache.
 */
export function useWebviewState<T>(
    key: string,
    defaultValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
    const [state, setState] = useState<T>(() => {
        const value = stateCache.get(key);
        return value !== undefined ? (value as T) : defaultValue;
    });

    // Update the local React state AND the module cache immediately.
    // Memoized so consumers (e.g. useNavigationHistory) can rely on a stable
    // setter identity — without this, every parent render created a new fn ref
    // and cascaded through memoized children, defeating React.memo on TraceCards.
    const setWebviewState = useCallback<React.Dispatch<React.SetStateAction<T>>>((value) => {
        setState((prev) => {
            const nextValue = typeof value === 'function'
                ? (value as (prev: T) => T)(prev)
                : value;

            stateCache.set(key, nextValue);

            // Schedule a single debounced write to the VS Code API
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                saveState(Object.fromEntries(stateCache));
            }, 500);

            return nextValue;
        });
    }, [key]);

    return [state, setWebviewState];
}
