import { useState, useEffect } from 'react';

export type ThemeMode = 'dark' | 'light' | 'high-contrast';

export function useVSCodeTheme(): ThemeMode {
    const [theme, setTheme] = useState<ThemeMode>(() => {
        if (document.body.classList.contains('vscode-light')) return 'light';
        if (document.body.classList.contains('vscode-high-contrast')) return 'high-contrast';
        return 'dark'; // Default
    });

    useEffect(() => {
        const observer = new MutationObserver(() => {
            if (document.body.classList.contains('vscode-light')) setTheme('light');
            else if (document.body.classList.contains('vscode-high-contrast')) setTheme('high-contrast');
            else setTheme('dark');
        });

        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return theme;
}
