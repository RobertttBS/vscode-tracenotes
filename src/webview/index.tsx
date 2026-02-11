import React from 'react';
import { createRoot } from 'react-dom/client';
import Storyboard from './components/Storyboard';

// Global styles for the webview
const style = document.createElement('style');
style.textContent = `
/* ---- Layout ---- */
.storyboard {
    padding: 8px;
}

.storyboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 12px;
}

.trace-count {
    font-size: 11px;
    opacity: 0.7;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

/* ---- Empty State ---- */
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    opacity: 0.6;
}

.empty-icon {
    font-size: 32px;
    margin-bottom: 12px;
}

.empty-hint {
    font-size: 12px;
    margin-top: 8px;
    line-height: 1.5;
}

/* ---- Trace Card ---- */
.trace-card {
    position: relative;
    margin-bottom: 12px;
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 6px;
    overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
    transition: border-color 0.15s ease;
}

.trace-card:hover {
    border-color: var(--vscode-focusBorder, #007fd4);
}

/* Connector line */
.connector-line {
    position: absolute;
    left: 16px;
    top: -12px;
    width: 2px;
    height: 12px;
    background: var(--vscode-panel-border, #444);
}

.trace-card:first-child .connector-line {
    display: none;
}

/* Header */
.card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--vscode-sideBarSectionHeader-background, #252526);
    cursor: pointer;
    user-select: none;
}

.card-header:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.card-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
}

.card-file {
    font-size: 12px;
    font-weight: 500;
    color: var(--vscode-textLink-foreground, #3794ff);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
}

.card-line {
    font-size: 11px;
    opacity: 0.6;
    flex-shrink: 0;
}

.card-remove {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.4;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: 3px;
    flex-shrink: 0;
}

.card-remove:hover {
    opacity: 1;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
}

/* Code block */
.card-code {
    max-height: 200px;
    overflow-y: auto;
}

.card-code pre {
    margin: 0 !important;
}

/* Note */
.card-note {
    padding: 6px 8px;
    border-top: 1px solid var(--vscode-panel-border, #333);
}

.note-display {
    font-size: 12px;
    cursor: pointer;
    padding: 2px 0;
    min-height: 16px;
    line-height: 1.4;
}

.note-placeholder {
    opacity: 0.4;
    font-style: italic;
}

.note-input {
    width: 100%;
    padding: 4px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    resize: vertical;
    min-height: 20px;
    box-sizing: border-box;
    outline: none;
}

.note-input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
}

/* ---- Reverse-sync active highlight ---- */
.highlight-active .trace-card {
    border-color: #ffcc00;
    box-shadow: 0 0 8px rgba(255, 204, 0, 0.5);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
`;
document.head.appendChild(style);

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<Storyboard />);
