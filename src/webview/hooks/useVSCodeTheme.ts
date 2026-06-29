import { useState, useEffect } from 'react';

/** True when VS Code is using a light theme; everything else uses the dark syntax style. */
export function useVSCodeTheme(): boolean {
    const [isLight, setIsLight] = useState(() => document.body.classList.contains('vscode-light'));

    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsLight(document.body.classList.contains('vscode-light'));
        });

        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return isLight;
}
