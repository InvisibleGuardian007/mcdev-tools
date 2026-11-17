import { useCallback, useEffect, useRef, useState } from 'react';
import { I18nText } from '../../i18n';
import { HostBridgeSessionSummary } from '../../types';
import { vscode } from '../../vscode';
import { createRequestId } from '../../utils/requestId';
import { DEBUG_SWITCHES_UI, describeDebugSwitchError } from './debugSwitchShared';

interface DebugSwitchesToolProps {
  session?: HostBridgeSessionSummary;
  t: I18nText;
}

export function DebugSwitchesTool({ session, t }: DebugSwitchesToolProps) {
  const [states, setStates] = useState<Record<string, boolean | null>>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closingAll, setClosingAll] = useState(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const stateRequestId = useRef('');

  const methodAvailable = session?.methods === undefined
    || session.methods.some(method => method.name === 'game/code/execute' && method.modes.includes('request'));
  const canUse = Boolean(
    session
    && session.connected
    && session.state === 'game_ready'
    && methodAvailable
  );

  const requestState = useCallback(() => {
    const current = sessionRef.current;
    if (!current || !canUse) {
      return;
    }
    const requestId = createRequestId('state');
    stateRequestId.current = requestId;
    setLoading(true);
    setError('');
    vscode.postMessage({
      type: 'debugSwitchesState',
      requestId,
      sessionId: current.id,
      connectionGeneration: current.connectionGeneration,
    });
  }, [canUse]);

  const markPending = (id: string, pending: boolean) => {
    setPendingIds(previous => pending
      ? (previous.includes(id) ? previous : previous.concat(id))
      : previous.filter(item => item !== id));
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') {
        return;
      }
      if (session?.id && message.sessionId && message.sessionId !== session.id) {
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
              // 渲染类开关读不到引擎值（null），保留上次切换结果，别刷新一次就变回“未知”
              if (typeof value === 'boolean') {
                next[item.id] = value;
              } else if (!(item.id in next)) {
                next[item.id] = null;
              }
            }
            return next;
          });
          setSettingsOpen(message.settingsOpen === true);
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
          markPending(message.id, false);
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
          setError(message.code === 'session-not-ready'
            ? t.debugSwitchesUnavailable
            : typeof message.message === 'string' && message.message
              ? message.message
              : t.debugSwitchesErrorGeneric);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session?.id, t]);

  useEffect(() => {
    setStates({});
    setPendingIds([]);
    setLoading(false);
    setError('');
    setNotice('');
    setSettingsOpen(false);
    requestState();
  }, [requestState, session?.id, session?.connectionGeneration]);

  const apply = (id: string, enabled: boolean) => {
    const current = sessionRef.current;
    if (!current || !canUse || closingAll || pendingIds.includes(id)) {
      return;
    }
    markPending(id, true);
    setNotice('');
    setError('');
    vscode.postMessage({
      type: 'debugSwitchSet',
      requestId: createRequestId('set'),
      sessionId: current.id,
      connectionGeneration: current.connectionGeneration,
      id,
      enabled,
    });
  };

  return (
    <div className="debug-switches-workspace">
      <div className="debug-switches-toolbar">
        <p className="debug-switches-hint">{t.debugSwitchesHint}</p>
        <div className="debug-switches-toolbar-actions">
          <button
            type="button"
            className="btn-link-compact"
            disabled={!canUse || closingAll}
            onClick={() => {
              const current = sessionRef.current;
              if (!current || !canUse || closingAll) {
                return;
              }
              setClosingAll(true);
              setNotice('');
              setError('');
              vscode.postMessage({
                type: 'debugSwitchesAllOff',
                requestId: createRequestId('off-all'),
                sessionId: current.id,
                connectionGeneration: current.connectionGeneration,
              });
            }}
          >
            <span className="codicon codicon-close-all" />
            {closingAll ? t.debugSwitchesLoading : t.debugSwitchesAllOff}
          </button>
          <button
            type="button"
            className="btn-link-compact"
            disabled={!canUse || loading}
            onClick={requestState}
          >
            <span className={`codicon ${loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-refresh'}`} />
            {loading ? t.debugSwitchesLoading : t.debugSwitchesRefresh}
          </button>
        </div>
      </div>

      {!canUse && <div className="debug-switches-banner">{t.debugSwitchesUnavailable}</div>}
      {settingsOpen && <div className="debug-switches-banner">{t.debugSwitchesSettingsOpenHint}</div>}
      {error && <div className="debug-switches-banner error">{error}</div>}
      {notice && <div className="debug-switches-banner ok">{notice}</div>}

      <div className="debug-switches-list">
        {DEBUG_SWITCHES_UI.map(item => {
          const state = states[item.id];
          const pending = pendingIds.includes(item.id);
          const stateClass = state === true ? 'on' : state === false ? 'off' : 'unknown';
          const stateText = state === true
            ? t.debugSwitchesOn
            : state === false
              ? t.debugSwitchesOff
              : t.debugSwitchesUnknown;
          return (
            <div className="debug-switches-row" key={item.id}>
              <div className="debug-switches-text">
                <span className="debug-switches-label">{item.label(t)}</span>
                <code className="debug-switches-key">{item.optionKey}</code>
              </div>
              <span className={`debug-switches-state ${stateClass}`}>{stateText}</span>
              <div className="debug-switches-actions">
                <button
                  type="button"
                  className={state === true ? 'active' : ''}
                  disabled={!canUse || pending || closingAll}
                  onClick={() => apply(item.id, true)}
                >
                  {t.debugSwitchesEnable}
                </button>
                <button
                  type="button"
                  className={state === false ? 'active' : ''}
                  disabled={!canUse || pending || closingAll}
                  onClick={() => apply(item.id, false)}
                >
                  {t.debugSwitchesDisable}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
