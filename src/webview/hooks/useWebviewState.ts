import { useState, useEffect, useRef } from 'react';
import { saveState, loadState } from '../utils/messaging';

/**
 * Drop-in replacement for `useState` that:
 *   1. Hydrates its initial value from the VS Code webview state cache (zero IPC).
 *   2. Debounces writes back to the cache (500 ms) to avoid serialising large
 *      state objects on every frame during heavy interactions like drag-and-drop.
 *
 * All keys share a single cache object so un-related keys cannot clobber each other.
 *
 * @param key          Unique string key within the shared cache object.
 * @param defaultValue Fallback used on the very first load (cache miss).
 */
export function useWebviewState<T>(
    key: string,
    defaultValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
    // Synchronously read from cache so React's first render already has data.
    const [state, setState] = useState<T>(() => {
        const cached = loadState<Record<string, unknown>>();
        const value = cached?.[key];
        return value !== undefined ? (value as T) : defaultValue;
    });

    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        // Clear any pending write before scheduling a new one.
        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
        }

        timerRef.current = setTimeout(() => {
            // Merge into the existing cache object so other keys are preserved.
            const current = loadState<Record<string, unknown>>() ?? {};
            saveState({ ...current, [key]: state });
            timerRef.current = undefined;
        }, 500);

        return () => {
            if (timerRef.current !== undefined) {
                clearTimeout(timerRef.current);
            }
        };
    }, [state, key]);

    return [state, setState];
}
