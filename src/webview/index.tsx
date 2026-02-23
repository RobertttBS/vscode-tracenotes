import React from 'react';
import { createRoot } from 'react-dom/client';
import Storyboard from './components/Storyboard';

import './webview.css';

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<Storyboard />);
