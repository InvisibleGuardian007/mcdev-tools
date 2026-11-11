import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DebugApp from './DebugApp';
import PerfWindowApp from './PerfWindowApp';

const view = document.body.dataset.view;
const RootApp = view === 'game-debugger' ? DebugApp : view === 'perf-monitor' ? PerfWindowApp : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>
);
