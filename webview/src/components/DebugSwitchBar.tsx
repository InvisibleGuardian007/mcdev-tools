import { useCallback, useEffect, useRef, useState } from 'react';
import { I18nText } from '../i18n';
import { vscode } from '../vscode';
import { createRequestId } from '../utils/requestId';
import { DEBUG_SWITCHES_UI, describeDebugSwitchError } from './debugger/debugSwitchShared';

interface DebugSwitchBarProps {
  t: I18nText;
}

/**
 * 侧边栏配置页里的调试开关快捷区。
 * 消息由 McDevToolsSidebarProvider 转给当前游戏会话，执行逻辑与调试面板里的页签共用。
 */
export function DebugSwitchBar({ t }: DebugSwitchBarProps) {
  const [states, setStates] = useState<Record<string, boolean | null>>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [closingAll, setClosingAll] = useState(false);
  const stateRequestId = useRef('');
  const readyRef = useRef(false);

  const requestState = useCallback(() => {
    const requestId = createRequestId('side-switch');
    stateRequestId.current = requestId;
    setLoading(true);
    setError('');
    vscode.postMessage({ type: 'debugSwitchesState', requestId });
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }
      switch (message.type) {
        case 'debugSwitchesStateResult': {
          if (message.requestId !== stateRequestId.current) {
            return;
          }
          const incoming = message.states && typeof message.states === 'object'
            ? message.states as Record<string, unknown>
            : {};
          setStates(previous => {
            const next: Record<string, boolean | null> = { ...previous };
            for (const item of DEBUG_SWITCHES_UI) {
              const value = incoming[item.id];
              if (typeof value === 'boolean') {
                next[item.id] = value;
              } else if (!(item.id in next)) {
                next[item.id] = null;
              }
            }
            return next;
          });
          const nextReady = message.error !== 'session-not-ready';
          readyRef.current = nextReady;
          setReady(nextReady);
          setLoading(false);
          setError(message.error === 'debug-channel-unavailable'
            ? t.debugSwitchesErrorChannel
            : '');
          break;
        }
        case 'debugSwitchSetResult': {
          if (typeof message.id !== 'string') {
            return;
          }
          setPendingIds(previous => previous.filter(item => item !== message.id));
          if (message.ok === true) {
            setStates(previous => ({
              ...previous,
              [message.id]: message.value === true ? true : message.value === false ? false : null,
            }));
            const via = message.via === 'option' ? t.debugSwitchesViaOption : t.debugSwitchesViaUi;
            setNotice(`${message.enabled === true ? t.debugSwitchesNoticeOn : t.debugSwitchesNoticeOff} · ${via}`);
            setError('');
          } else {
            setError(describeDebugSwitchError(
              typeof message.error === 'string' ? message.error : undefined,
              typeof message.detail === 'string' ? message.detail : undefined,
              t,
            ));
          }
          break;
        }
        case 'debugSwitchesAvailability': {
          const nextReady = message.ready === true;
          const changed = nextReady !== readyRef.current;
          readyRef.current = nextReady;
          setReady(nextReady);
          if (!nextReady) {
            setPendingIds([]);
          }
          if (changed && nextReady) {
            requestState();
          }
          break;
        }
        case 'debugSwitchesAllOffResult': {
          setClosingAll(false);
          const results = message.results && typeof message.results === 'object'
            ? message.results as Record<string, { ok?: boolean; error?: string; detail?: string }>
            : {};
          setStates(previous => {
            const next: Record<string, boolean | null> = { ...previous };
            for (const item of DEBUG_SWITCHES_UI) {
              if (results[item.id]?.ok === true) {
                next[item.id] = false;
              }
            }
            return next;
          });
          if (message.ok === true) {
            setNotice(t.debugSwitchesAllOffDone);
            setError('');
          } else {
            const failed = DEBUG_SWITCHES_UI.find(item => results[item.id]?.ok !== true);
            const failure = failed ? results[failed.id] : undefined;
            setError(describeDebugSwitchError(failure?.error, failure?.detail, t));
          }
          break;
        }
        case 'debugSwitchesError': {
          setLoading(false);
          setPendingIds([]);
          setClosingAll(false);
          if (message.code === 'session-not-ready') {
            readyRef.current = false;
            setReady(false);
            setError('');
          } else {
            setError(typeof message.message === 'string' && message.message
              ? message.message
              : t.debugSwitchesErrorGeneric);
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  useEffect(() => {
    requestState();
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        requestState();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [requestState]);

  const toggle = (id: string, enabled: boolean) => {
    if (!ready || pendingIds.includes(id)) {
      return;
    }
    setPendingIds(previous => previous.concat(id));
    setNotice('');
    setError('');
    vscode.postMessage({
      type: 'debugSwitchSet',
      requestId: createRequestId('side-switch'),
      id,
      enabled,
    });
  };

  return (
    <div className="debug-switch-bar">
      <div className="debug-switch-bar-head">
        <span className="debug-switch-bar-title">
          <span className="codicon codicon-symbol-boolean" />
          {t.debugSwitchesTab}
        </span>
        <span className="debug-switch-bar-tools">
          {!ready && !loading && (
            <span className="debug-switch-bar-offline">{t.debugSwitchBarOffline}</span>
          )}
          <button
            type="button"
            className="debug-switch-all-off"
            disabled={!ready || closingAll}
            onClick={() => {
              if (!ready || closingAll) {
                return;
              }
              setClosingAll(true);
              setNotice('');
              setError('');
              vscode.postMessage({ type: 'debugSwitchesAllOff', requestId: createRequestId('off-all') });
            }}
            title={t.debugSwitchesAllOff}
          >
            {closingAll ? t.debugSwitchesLoading : t.debugSwitchesAllOff}
          </button>
          <button
            type="button"
            className="debug-switch-refresh"
            disabled={loading}
            onClick={requestState}
            title={t.debugSwitchesRefresh}
            aria-label={t.debugSwitchesRefresh}
          >
            <span className={`codicon ${loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`} />
          </button>
        </span>
      </div>

      <div className="debug-switch-chips">
        {DEBUG_SWITCHES_UI.map(item => {
          const state = states[item.id];
          const pending = pendingIds.includes(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`debug-switch-chip${state === true ? ' on' : ''}`}
              disabled={!ready || pending || closingAll}
              title={`${item.label(t)} · ${item.optionKey}`}
              aria-pressed={state === true}
              onClick={() => toggle(item.id, state !== true)}
            >
              <span className="debug-switch-dot" />
              {item.shortLabel(t)}
            </button>
          );
        })}
      </div>

      {error && <div className="debug-switch-bar-error">{error}</div>}
      {notice && <div className="debug-switch-bar-notice">{notice}</div>}
    </div>
  );
}
