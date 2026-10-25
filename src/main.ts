import './styles/main.css';
import { mountApp } from './app/app.js';
import { installErrorBoundary } from './ui/error-boundary.js';

const root = document.getElementById('app');
if (root === null) throw new Error('The page has no #app element to mount into.');

installErrorBoundary(window, document.body);
mountApp(root, { window, fetch: (input, init) => window.fetch(input, init) });
