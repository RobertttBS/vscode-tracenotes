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
    padding: 8px;
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--vscode-editor-background, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    margin: -8px -8px 12px;
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
    border: 1px solid var(--vscode-panel-border, #555);
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
    color: #9ebeffff;
    cursor: pointer;
    padding: 6px;
    min-height: 16px;
    line-height: 1.4;
    border: 1px solid var(--vscode-widget-border, #4e4e4eff);
    border-radius: 3px;
    margin-top: 2px;
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

/* ---- Back button ---- */
.back-button {
    background: none;
    border: 1px solid var(--vscode-panel-border, #555);
    color: var(--vscode-foreground, #ccc);
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    margin-right: 8px;
    flex-shrink: 0;
}

.back-button:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
    border-color: var(--vscode-focusBorder, #007fd4);
}

/* ---- Breadcrumb depth label ---- */
.breadcrumb-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #999);
    letter-spacing: 0.5px;
    white-space: nowrap;
    flex-shrink: 0;
}

/* ---- Enter group button (in header) ---- */
.enter-group-btn {
    background: none;
    border: 1px solid var(--vscode-panel-border, #555);
    color: var(--vscode-textLink-foreground, #3794ff);
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background 0.15s ease, border-color 0.15s ease;
}

.enter-group-btn:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
    border-color: var(--vscode-focusBorder, #007fd4);
}

/* ---- Reverse-sync active highlight ---- */


/* ---- Toolbar Button Base ---- */
.toolbar-btn {
    background: none;
    border: none;
    padding: 4px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.8;
    transition: background 0.15s ease, opacity 0.15s ease;
}

.toolbar-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    opacity: 1;
}

/* ---- Clear All Button ---- */
.clear-all-btn {
    color: #ff4d4d;
}

/* ---- Export Button ---- */
.export-btn {
    color: var(--vscode-textLink-foreground, #3794ff);
}

/* ---- Trace Card Highlights ---- */
.trace-card.red {
    border-color: #F14C4C;
    box-shadow: 0 0 4px rgba(241, 76, 76, 0.2);
}
.trace-card.blue {
    border-color: #3794FF;
    box-shadow: 0 0 4px rgba(55, 148, 255, 0.2);
}
.trace-card.green {
    border-color: #3AD900;
    box-shadow: 0 0 4px rgba(58, 217, 0, 0.2);
}
.trace-card.orange {
    border-color: #FF8800;
    box-shadow: 0 0 4px rgba(255, 136, 0, 0.2);
}
.trace-card.purple {
    border-color: #9D00FF;
    box-shadow: 0 0 4px rgba(157, 0, 255, 0.2);
}

/* ---- Context Menu ---- */
.context-menu {
    position: fixed;
    z-index: 1000;
    background: var(--vscode-menu-background, #252526);
    border: 1px solid var(--vscode-menu-border, #454545);
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    padding: 6px;
    border-radius: 4px;
    display: flex;
    gap: 6px;
}

.color-option {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: transform 0.1s;
    box-sizing: border-box;
    position: relative;
}

.color-option:hover {
    transform: scale(1.1);
    border-color: var(--vscode-focusBorder, #007fd4);
}

.color-option.red { background: #F14C4C; }
.color-option.blue { background: #3794FF; }
.color-option.green { background: #3AD900; }
.color-option.orange { background: #FF8800; }
.color-option.purple { background: #9D00FF; }

.color-option.none {
    background: transparent;
    border: 1px solid var(--vscode-descriptionForeground, #777);
    display: flex;
    align-items: center;
    justify-content: center;
}

.color-option.none::after {
    content: '✕';
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #777);
    font-weight: bold;
}

.color-option.none:hover {
    border-color: #ff4d4d;
}
.color-option.none:hover::after {
    color: #ff4d4d;
}

/* ---- Reverse-sync active highlight ---- */
/* Default (no color) -> Yellow */
.highlight-active .trace-card {
    border: 2px solid #c1c1c1ff !important;
    box-shadow: 0 0 8px rgba(255, 204, 0, 0.5);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

/* Colored overrides */
.highlight-active .trace-card.red {
    border-color: #F14C4C !important;
    box-shadow: 0 0 8px rgba(241, 76, 76, 0.5);
}
.highlight-active .trace-card.blue {
    border-color: #3794FF !important;
    box-shadow: 0 0 8px rgba(55, 148, 255, 0.5);
}
.highlight-active .trace-card.green {
    border-color: #3AD900 !important;
    box-shadow: 0 0 8px rgba(58, 217, 0, 0.5);
}
.highlight-active .trace-card.orange {
    border-color: #FF8800 !important;
    box-shadow: 0 0 8px rgba(255, 136, 0, 0.5);
}
.highlight-active .trace-card.purple {
    border-color: #9D00FF !important;
    box-shadow: 0 0 8px rgba(157, 0, 255, 0.5);
}
`
document.head.appendChild(style);

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<Storyboard />);
