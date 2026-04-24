import { useCallback } from 'react';
import { useWebviewState } from './useWebviewState';
import { NavigationHistoryEntry } from '../../types';

const MAX_HISTORY = 20;

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

    const goBack = useCallback(
        (current: NavigationHistoryEntry): NavigationHistoryEntry | null => {
            if (backStack.length === 0) return null;
            const target = backStack[backStack.length - 1];
            setBackStack(prev => prev.slice(0, -1));
            setForwardStack(prev => [...prev, current]);
            return target;
        },
        [backStack, setBackStack, setForwardStack],
    );

    const goForward = useCallback(
        (current: NavigationHistoryEntry): NavigationHistoryEntry | null => {
            if (forwardStack.length === 0) return null;
            const target = forwardStack[forwardStack.length - 1];
            setForwardStack(prev => prev.slice(0, -1));
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
