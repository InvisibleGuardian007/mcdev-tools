import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DebugApp from './DebugApp';
import PerfWindowApp from './PerfWindowApp';
import StudioApp from './StudioApp';

const view = document.body.dataset.view;
const RootApp = view === 'game-debugger'
  ? DebugApp
  : view === 'perf-monitor'
    ? PerfWindowApp
    : view === 'studio'
      ? StudioApp
      : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>
);
