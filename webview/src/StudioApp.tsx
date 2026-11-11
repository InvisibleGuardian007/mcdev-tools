import { useRef, useState } from 'react';
import { WorkbenchApp, CaptureSync } from './WorkbenchApp';
import { STUDIO_TOOLS } from './tools';
import { i18n } from './i18n';

function StudioApp() {
  const language = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  const t = i18n[language] || i18n.en;
  const nonceRef = useRef(0);
  const [sync, setSync] = useState<CaptureSync>();

  const trigger = (kind: CaptureSync['kind']) => {
    nonceRef.current += 1;
    setSync({ kind, nonce: nonceRef.current });
  };

  return (
    <WorkbenchApp
      tools={STUDIO_TOOLS}
      title={t.studioTitle}
      icon="codicon-dashboard"
      sync={sync}
      actions={({ session }) => {
        const ready = Boolean(session?.connected && session.state === 'game_ready');
        return (
          <div className="studio-actions">
            <button
              type="button"
              className="studio-action studio-action--start"
              disabled={!ready}
              onClick={() => trigger('start')}
              title={t.studioStartAllHint}
            >
              <span className="codicon codicon-record" />
              <span>{t.studioStartAll}</span>
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
