import { useState } from 'react';
import { saveState, loadState } from '../utils/messaging';

// Module-level cache to prevent race conditions between multiple hook instances
let stateCache: Record<string, any> = loadState<Record<string, any>>() ?? {};
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
        const value = stateCache[key];
        return value !== undefined ? (value as T) : defaultValue;
    });

    // Update the local React state AND the module cache immediately
    const setWebviewState: React.Dispatch<React.SetStateAction<T>> = (value) => {
        setState((prev) => {
            const nextValue = typeof value === 'function' 
                ? (value as (prev: T) => T)(prev) 
                : value;
            
            // Sync to module-level cache immediately so other hooks see it
            stateCache[key] = nextValue;
            
            // Schedule a single debounced write to the VS Code API
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                saveState(stateCache);
            }, 500);

            return nextValue;
        });
    };

    return [state, setWebviewState];
}
