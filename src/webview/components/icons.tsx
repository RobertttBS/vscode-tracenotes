import React from 'react';

export const ExportIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {/* The horizontal "tray" at the bottom */}
        <path d="M2 14.5h12" />
        {/* The vertical arrow stem */}
        <path d="M8 1v10" />
        {/* The arrow head */}
        <path d="M4 7l4 4 4-4" />
    </svg>
);

export const TrashIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11 1.5v1h3.5v1h-1v10.5l-1 1H3.5l-1-1V3.5h-1v-1H5v-1h6zM4.5 3.5v10h7v-10h-7zM6 5v7h1V5H6zm3 0v7h1V5H9z" />
    </svg>
);

export const ListIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path 
            fillRule="evenodd" 
            clipRule="evenodd" 
            d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"
            fill="#9ca3af"  // light gray (Tailwind gray-400 equivalent)
        />
    </svg>
);

export const PlusIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
    </svg>
);

export const NestingIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 10 20 15 15 20"></polyline>
        <path d="M4 4v7a4 4 0 0 0 4 4h12"></path>
    </svg>
);

export const BackIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 10 4 15 9 20"></polyline>
        <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
    </svg>
);
