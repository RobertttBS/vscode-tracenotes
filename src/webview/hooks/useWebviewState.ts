import { useState } from 'react';
import { saveState, loadState } from '../utils/messaging';

// Module-level LRU cache (Map preserves insertion order; delete+reinsert = promote to MRU)
const stateCache = new Map<string, any>(
    Object.entries(loadState<Record<string, any>>() ?? {})
);
let timeout: ReturnType<typeof setTimeout> | undefined;

const MAX_CACHE_KEYS = 50;

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

    // Update the local React state AND the module cache immediately
    const setWebviewState: React.Dispatch<React.SetStateAction<T>> = (value) => {
        setState((prev) => {
            const nextValue = typeof value === 'function'
                ? (value as (prev: T) => T)(prev)
                : value;

            // Promote to MRU by reinserting; evict LRU entry when at capacity
            stateCache.delete(key);
            if (stateCache.size >= MAX_CACHE_KEYS) {
                stateCache.delete(stateCache.keys().next().value);
            }
            stateCache.set(key, nextValue);

            // Schedule a single debounced write to the VS Code API
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                saveState(Object.fromEntries(stateCache));
            }, 500);

            return nextValue;
        });
    };

    return [state, setWebviewState];
}
