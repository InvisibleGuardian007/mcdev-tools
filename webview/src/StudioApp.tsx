import { useRef, useState } from 'react';
import { WorkbenchApp, CaptureScope, CaptureSync } from './WorkbenchApp';
import { STUDIO_TOOLS } from './tools';
import { i18n } from './i18n';

function StudioApp() {
  const language = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const t = i18n[language] || i18n.en;
  const nonceRef = useRef(0);
  const [sync, setSync] = useState<CaptureSync>();
  // 「开始采集」只启动这里选中的采集器；停止则一律停在跑的（见两个工具的 sync 处理）
  const [scope, setScope] = useState<CaptureScope>('both');

  const trigger = (kind: CaptureSync['kind']) => {
    nonceRef.current += 1;
    setSync({ kind, scope, nonce: nonceRef.current });
  };

  return (
    <WorkbenchApp
      tools={STUDIO_TOOLS}
      title={t.studioTitle}
      icon="codicon-dashboard"
      sync={sync}
      topBarCapture
      actions={({ session }) => {
        const ready = Boolean(session?.connected && session.state === 'game_ready');
        return (
          <div className="studio-actions">
            <select
              className="studio-action studio-action--scope"
              value={scope}
              disabled={!ready}
              onChange={event => setScope(event.target.value as CaptureScope)}
              title={t.studioScopeHint}
              aria-label={t.studioScopeHint}
            >
              <option value="both">{t.studioScopeBoth}</option>
              <option value="cpu">{t.studioScopeCpu}</option>
              <option value="memory">{t.studioScopeMemory}</option>
            </select>
            <button
              type="button"
              className="studio-action studio-action--start"
              disabled={!ready}
              onClick={() => trigger('start')}
              title={t.studioStartHint}
            >
              <span className="codicon codicon-record" />
              <span>{t.studioStart}</span>
            </button>
            <button
              type="button"
              className="studio-action studio-action--stop"
              disabled={!ready}
              onClick={() => trigger('stop')}
              title={t.studioStopAllHint}
            >
              <span className="codicon codicon-debug-stop" />
              <span>{t.studioStopAll}</span>
            </button>
            <span className="studio-actions-hint">
              <span className="codicon codicon-info" />
              <span>{t.studioActionsHint}</span>
            </span>
          </div>
        );
      }}
    />
  );
}

export default StudioApp;
