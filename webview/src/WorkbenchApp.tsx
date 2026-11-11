import { ReactNode, useEffect, useState } from 'react';
import { SessionPicker } from './components/debugger/SessionPicker';
import { I18nText, i18n } from './i18n';
import { HostBridgeSessionSummary, HostBridgeSnapshot } from './types';
import { vscode } from './vscode';
import './DebugApp.css';

/** 面板之间共享的「同时开始/停止采集」信号，nonce 变化即触发一次 */
export interface CaptureSync {
  kind: 'start' | 'stop';
  nonce: number;
}

export interface DebugToolContext {
  session?: HostBridgeSessionSummary;
  t: I18nText;
  sync?: CaptureSync;
}

export interface DebugToolDefinition {
  id: string;
  icon: string;
  label(t: I18nText): string;
  render(context: DebugToolContext): ReactNode;
}

export interface WorkbenchAppProps {
  tools: DebugToolDefinition[];
  title: string | ((t: I18nText) => string);
  icon?: string;
  /** 顶部操作条，用来放「开始采集 / 停止采集」这类跨页签按钮 */
  actions?: ReactNode | ((context: { session?: HostBridgeSessionSummary; t: I18nText }) => ReactNode);
  sync?: CaptureSync;
}

const EMPTY_SNAPSHOT: HostBridgeSnapshot = { status: 'idle', sessions: [] };

export function WorkbenchApp({ tools, title, icon = 'codicon-debug-console', actions, sync }: WorkbenchAppProps) {
  const language = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const t = i18n[language] || i18n.en;
  const [snapshot, setSnapshot] = useState<HostBridgeSnapshot>(EMPTY_SNAPSHOT);
  const [dock, setDock] = useState<'view' | 'panel' | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [activeToolId, setActiveToolId] = useState(tools[0]?.id ?? '');
  const resolvedTitle = typeof title === 'function' ? title(t) : title;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'hostBridgeState' && event.data.snapshot) {
        setSnapshot(event.data.snapshot as HostBridgeSnapshot);
      }
      if (event.data?.type === 'debuggerSurface' && (event.data.dock === 'view' || event.data.dock === 'panel')) {
        setDock(event.data.dock as 'view' | 'panel');
      }
    };
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    setSelectedSessionId(previous => {
      if (snapshot.sessions.some(session => session.id === previous)) {
        return previous;
      }
      return snapshot.sessions.find(session => session.connected)?.id
        ?? snapshot.sessions[0]?.id
        ?? '';
    });
  }, [snapshot.sessions]);

  const selectedSession = snapshot.sessions.find(session => session.id === selectedSessionId);
  const activeTool = tools.find(tool => tool.id === activeToolId) ?? tools[0];
  const status = getStatus(selectedSession, snapshot, t);

  if (!activeTool) {
    return null;
  }

  return (
    <main className="debug-workbench">
      <header className="debug-workbench-header">
        <div className="debug-workbench-title">
          <span className={`codicon ${icon}`} />
          <h1>{resolvedTitle}</h1>
        </div>
        <div className="debug-session-controls">
          <SessionPicker
            sessions={snapshot.sessions}
            selectedId={selectedSessionId}
            onSelect={setSelectedSessionId}
            t={t}
          />
          <div className={`host-bridge-status ${status.tone}`} aria-live="polite">
            <span className="host-bridge-status-dot" />
            <span>{status.label}</span>
          </div>
          {dock && (
            <button
              type="button"
              className="btn-icon host-bridge-icon-button debug-workbench-dock-button"
              onClick={() => vscode.postMessage({ type: 'toggleDebuggerSurface' })}
              title={dock === 'view' ? t.workbenchOpenInEditor : t.workbenchDockToSidebar}
              aria-label={dock === 'view' ? t.workbenchOpenInEditor : t.workbenchDockToSidebar}
            >
              <span className={`codicon ${dock === 'view' ? 'codicon-link-external' : 'codicon-layout-sidebar-right'}`} />
            </button>
          )}
          <button
            type="button"
            className="btn-icon host-bridge-icon-button"
            onClick={() => vscode.postMessage({ type: 'hostBridgeRefresh' })}
            title={t.hostBridgeRefresh}
            aria-label={t.hostBridgeRefresh}
          >
            <span className="codicon codicon-refresh" />
          </button>
        </div>
      </header>

      {actions && (
        <div className="debug-workbench-actions">
          {typeof actions === 'function' ? actions({ session: selectedSession, t }) : actions}
        </div>
      )}

      <div className="debug-workbench-body">
        <nav className="debug-tool-nav" aria-label={resolvedTitle}>
          {tools.map(tool => (
            <button
              type="button"
              key={tool.id}
              className={tool.id === activeTool.id ? 'active' : ''}
              aria-current={tool.id === activeTool.id ? 'page' : undefined}
              onClick={() => setActiveToolId(tool.id)}
              title={tool.label(t)}
            >
              <span className={`codicon ${tool.icon}`} />
              <span>{tool.label(t)}</span>
            </button>
          ))}
        </nav>
        <section className="debug-tool-page" aria-label={activeTool.label(t)}>
          <div className={`debug-tool-page-content debug-tool-page-content--${activeTool.id}`}>
            {activeTool.render({ session: selectedSession, t, sync })}
          </div>
        </section>
      </div>
    </main>
  );
}

export function getStatus(
  session: HostBridgeSessionSummary | undefined,
  snapshot: HostBridgeSnapshot,
  t: I18nText
): { label: string; tone: 'neutral' | 'warning' | 'success' | 'error' } {
  if (!session) {
    if (snapshot.status === 'error') {
      return { label: snapshot.error || t.hostBridgeError, tone: 'error' };
    }
    return snapshot.status === 'listening'
      ? { label: t.hostBridgeWaiting, tone: 'neutral' }
      : { label: t.hostBridgeIdle, tone: 'neutral' };
  }
  if (session.state === 'starting') {
    return { label: t.hostBridgeStarting, tone: 'warning' };
  }
  switch (session.state) {
    case 'process_started':
      return session.connected
        ? { label: t.hostBridgeProcessStarted, tone: 'warning' }
        : { label: t.hostBridgeDisconnected, tone: 'error' };
    case 'game_ready':
      return session.connected
        ? { label: t.hostBridgeReady, tone: 'success' }
        : { label: t.hostBridgeDisconnected, tone: 'error' };
    case 'game_unavailable':
      return { label: t.hostBridgeUnavailable, tone: 'warning' };
    case 'exiting':
      return { label: t.hostBridgeExiting, tone: 'warning' };
    case 'exited':
      return { label: t.hostBridgeExited, tone: 'neutral' };
  }
  return { label: t.hostBridgeIdle, tone: 'neutral' };
}
