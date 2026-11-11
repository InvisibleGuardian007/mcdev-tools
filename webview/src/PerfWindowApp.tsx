import { useEffect, useState } from 'react';
import { PerfMonitorTool } from './components/debugger/PerfMonitorTool';
import { i18n } from './i18n';
import { HostBridgeSnapshot } from './types';
import { vscode } from './vscode';
import './DebugApp.css';

const EMPTY_SNAPSHOT: HostBridgeSnapshot = { status: 'idle', sessions: [] };

/**
 * 独立「性能监测」窗口的根组件。
 * 只渲染性能监测工具本身：会话来自宿主推送的 hostBridgeState，
 * body[data-autostart] 决定拿到会话后是否立刻开始采样。
 */
function PerfWindowApp() {
  const language = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const t = i18n[language] || i18n.en;
  const autoStart = document.body.dataset.autostart !== 'false';
  const [snapshot, setSnapshot] = useState<HostBridgeSnapshot>(EMPTY_SNAPSHOT);
  const [selectedSessionId, setSelectedSessionId] = useState('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'hostBridgeState' && event.data.snapshot) {
        setSnapshot(event.data.snapshot as HostBridgeSnapshot);
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
      return snapshot.sessions.find(session => session.connected && session.state === 'game_ready')?.id
        ?? snapshot.sessions.find(session => session.connected)?.id
        ?? snapshot.sessions[0]?.id
        ?? '';
    });
  }, [snapshot.sessions]);

  const session = snapshot.sessions.find(item => item.id === selectedSessionId);

  return (
    <main className="perf-window">
      {snapshot.sessions.length > 1 && (
        <label className="perf-window-session">
          <span>{t.hostBridgeSession}</span>
          <select
            value={selectedSessionId}
            onChange={event => setSelectedSessionId(event.target.value)}
          >
            {snapshot.sessions.map(item => (
              <option key={item.id} value={item.id}>
                {item.worldName || item.worldFolderName || item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <PerfMonitorTool session={session} t={t} autoStart={autoStart} />
    </main>
  );
}

export default PerfWindowApp;
