import { ReactNode, useEffect, useState } from 'react';
import { SessionPicker } from './components/debugger/SessionPicker';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nText, i18n } from './i18n';
import { HostBridgeSessionSummary, HostBridgeSnapshot } from './types';
import { vscode } from './vscode';
import './DebugApp.css';

/** 顶部那条采集按钮这次要覆盖哪几个采集器 */
export type CaptureScope = 'both' | 'cpu' | 'memory';

/** 面板之间共享的「开始/停止采集」信号，nonce 变化即触发一次 */
export interface CaptureSync {
  kind: 'start' | 'stop';
  /** 缺省按 both 处理，兼容「没有下拉」的调用方 */
  scope?: CaptureScope;
  nonce: number;
}

export interface DebugToolContext {
  session?: HostBridgeSessionSummary;
  t: I18nText;
  sync?: CaptureSync;
  /**
   * 采集是否由顶部操作条驱动（集成面板）。
   * 注意不能拿 sync 有没有值来判断：sync 只在第一次点按钮之后才有，
   * 用它当标志会让工具在首次打开时仍然渲染自己的开始/停止按钮。
   */
  topBarCapture?: boolean;
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
  /** 顶部操作条负责启停采集时置 true，工具条里就不再重复放按钮 */
  topBarCapture?: boolean;
}

const EMPTY_SNAPSHOT: HostBridgeSnapshot = { status: 'idle', sessions: [] };

export function WorkbenchApp({ tools, title, icon = 'codicon-debug-console', actions, sync, topBarCapture }: WorkbenchAppProps) {
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
  // 游戏正在被我们拉起来时 pid 还没上报，先别急着提示「没连上」。
  const starting = snapshot.sessions.some(session => session.connected
    && (session.state === 'starting' || session.state === 'process_started'));
  const unboundGamePids = starting ? [] : (snapshot.gameProcesses?.unboundMinecraftPids ?? []);

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
          <div className="debug-session-buttons">
            {dock && (
              <button
                type="button"
                className="btn-icon host-bridge-icon-button debug-workbench-dock-button"
                onClick={() => vscode.postMessage({ type: 'toggleDebuggerSurface' })}
                title={dock === 'view' ? t.workbenchOpenInEditor : t.workbenchDockToSidebar}
                aria-label={dock === 'view' ? t.workbenchOpenInEditor : t.workbenchDockToSidebar}
              >
                <span className={`codicon ${dock === 'view' ? 'codicon-link-external' : 'codicon-layout-sidebar-right'}`} />
                {/* 窄面板里图标太隐晦，补一个文字标签，让「切到编辑器页签 / 停靠回侧边栏」看得见 */}
                <span className="debug-workbench-dock-label">
                  {dock === 'view' ? t.workbenchDockLabelEditor : t.workbenchDockLabelSidebar}
                </span>
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
        </div>
      </header>

      {unboundGamePids.length > 0 && (
        <div className="debug-workbench-hint is-warning" role="status">
          <span className="codicon codicon-warning" />
          <span className="debug-workbench-hint-text">
            {t.hostBridgeUnboundGame.replace('{pids}', unboundGamePids.join(', '))}
          </span>
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
      )}

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
            <ErrorBoundary name={activeTool.id} key={`${activeTool.id}:${selectedSessionId}`}>
              {activeTool.render({ session: selectedSession, t, sync, topBarCapture })}
            </ErrorBoundary>
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
      // state 是断开前最后一次上报的：socket 已经断了就别再说「存档不可用」，
      // 那只是这条会话已经死了（真正的存档异常只有连接还在时才算）。
      return session.connected
        ? { label: t.hostBridgeUnavailable, tone: 'warning' }
        : { label: t.hostBridgeDisconnected, tone: 'error' };
    case 'exiting':
      return { label: t.hostBridgeExiting, tone: 'warning' };
    case 'exited':
      return { label: t.hostBridgeExited, tone: 'neutral' };
  }
  return { label: t.hostBridgeIdle, tone: 'neutral' };
}
