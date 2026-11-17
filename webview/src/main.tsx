import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DebugApp from './DebugApp';
import PerfWindowApp from './PerfWindowApp';
import StudioApp from './StudioApp';
import { reportWebviewError } from './components/ErrorBoundary';

// 面板整块变白/变黑时，多半是渲染期抛了没被兜住的异常：这里补一层全局上报，
// 错误会由宿主写进日志（.mcdev/host-surface.log 或系统临时目录）。
window.addEventListener('error', event => {
  reportWebviewError('window.error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', event => {
  reportWebviewError('unhandledrejection', event.reason);
});

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
