import { useCallback } from 'react';
import { useWebviewState } from './useWebviewState';
import { NavigationHistoryEntry } from '../../types';

const MAX_HISTORY = 20;

type EntryValidator = (entry: NavigationHistoryEntry) => boolean;

export function useNavigationHistory() {
    const [backStack, setBackStack] = useWebviewState<NavigationHistoryEntry[]>('navBackStack', []);
    const [forwardStack, setForwardStack] = useWebviewState<NavigationHistoryEntry[]>('navForwardStack', []);

    const pushNavigation = useCallback((current: NavigationHistoryEntry) => {
        setBackStack(prev => {
            const next = [...prev, current];
            return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
        });
        setForwardStack([]);
    }, [setBackStack, setForwardStack]);

    // Scans from the top of the stack, skipping invalid entries in one pass.
    // Invalid entries are discarded (not moved to the other stack).
    const goBack = useCallback(
        (current: NavigationHistoryEntry, isValid: EntryValidator): NavigationHistoryEntry | null => {
            let i = backStack.length - 1;
            while (i >= 0 && !isValid(backStack[i])) i--;
            if (i < 0) {
                if (backStack.length > 0) setBackStack([]);
                return null;
            }
            const target = backStack[i];
            setBackStack(prev => prev.slice(0, i));
            setForwardStack(prev => [...prev, current]);
            return target;
        },
        [backStack, setBackStack, setForwardStack],
    );

    const goForward = useCallback(
        (current: NavigationHistoryEntry, isValid: EntryValidator): NavigationHistoryEntry | null => {
            let i = forwardStack.length - 1;
            while (i >= 0 && !isValid(forwardStack[i])) i--;
            if (i < 0) {
                if (forwardStack.length > 0) setForwardStack([]);
                return null;
            }
            const target = forwardStack[i];
            setForwardStack(prev => prev.slice(0, i));
            setBackStack(prev => {
                const next = [...prev, current];
                return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            });
            return target;
        },
        [forwardStack, setBackStack, setForwardStack],
    );

    return {
        canGoBack: backStack.length > 0,
        canGoForward: forwardStack.length > 0,
        pushNavigation,
        goBack,
        goForward,
    };
}
