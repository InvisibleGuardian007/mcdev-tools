import { CSSProperties, memo, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { I18nText } from '../../i18n';
import {
  HostBridgeSessionSummary,
  PythonProfilerCall,
  PythonProfilerCompletedState,
  PythonProfilerClock,
  PythonProfilerFunction,
  PythonProfilerHistoryDetail,
  PythonProfilerHistoryEntry,
  PythonProfilerResult,
  PythonProfilerTarget,
  PythonProfilerTargetState,
} from '../../types';
import { vscode } from '../../vscode';
import { createRequestId } from '../../utils/requestId';
import type { CaptureSync } from '../../WorkbenchApp';

interface PythonProfilerToolProps {
  session?: HostBridgeSessionSummary;
  t: I18nText;
  /** 集成面板的「开始/停止采集」信号 */
  sync?: CaptureSync;
  /** 采集由顶部操作条驱动：工具条里只留参数，不再放开始/停止按钮 */
  topBarCapture?: boolean;
}

type CaptureMode = 'timed' | 'manual';

/** 热点函数表格的列：可以拖动任意换位置 */
type ProfilerColumn = 'name' | 'bar' | 'calls' | 'self' | 'total';

const DEFAULT_COLUMN_ORDER: ProfilerColumn[] = ['name', 'bar', 'calls', 'self', 'total'];

/**
 * 表格最多渲染多少行：载荷现在保留每个 (端, mod) 的全部函数（几千行量级），
 * 列表没有虚拟滚动，全量铺 DOM 会明显卡顿；超出的部分只看报告 / 复制给 Agent 的正文。
 */
const MAX_VISIBLE_ROWS = 400;

/** 复制正文动辄几十万字，统计行用 k / M 计数，别铺一串数字 */
function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1000000) {
    const kilo = value / 1000;
    const text = kilo >= 100 ? String(Math.round(kilo)) : kilo.toFixed(1).replace('.0', '');
    return text + 'k';
  }
  const mega = value / 1000000;
  const text = mega >= 100 ? String(Math.round(mega)) : mega.toFixed(1).replace('.0', '');
  return text + 'M';
}

export function PythonProfilerTool({ session, t, sync, topBarCapture }: PythonProfilerToolProps) {
  const [target, setTarget] = useState<PythonProfilerTarget>('all');
  const [clock, setClock] = useState<'CPU' | 'WALL'>('WALL');
  const [mode, setMode] = useState<CaptureMode>('manual');
  const [duration, setDuration] = useState('300');
  const [states, setStates] = useState<Partial<Record<PythonProfilerTarget, PythonProfilerTargetState>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [showHistory, setShowHistory] = useState(false);
  /** 采集历史区的高度（px）；null＝用 CSS 默认（46%），可拖动改，双击复位 */
  const [historyHeight, setHistoryHeight] = useState<number | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLElement>(null);
  const resizingHistory = useRef(false);
  /** 拖动「采集历史 ↔ 结果区」之间那条横条：把历史区拉高/压低，结果区跟着变大变小 */
  const resizeHistory = (clientY: number) => {
    const element = historyRef.current;
    const workspace = workspaceRef.current;
    if (!element || !workspace) {
      return;
    }
    const top = element.getBoundingClientRect().top;
    const maximum = Math.max(140, workspace.getBoundingClientRect().height * 0.7);
    setHistoryHeight(Math.max(90, Math.min(maximum, clientY - top)));
  };
  const [history, setHistory] = useState<PythonProfilerHistoryEntry[]>([]);
  const [historyCurrentId, setHistoryCurrentId] = useState<string>();
  /** 正在回看的历史采集（只读）；undefined = 看当前采集 */
  const [review, setReview] = useState<PythonProfilerHistoryDetail>();
  const [compareBaseId, setCompareBaseId] = useState('');
  const [compareHeadId, setCompareHeadId] = useState('');
  const [comparison, setComparison] = useState<{ summary: string; copied: boolean }>();
  // 当前只看哪个 mod 的函数（'' = 全部）；只影响显示与「复制给 Agent」的范围
  const [modFilter, setModFilter] = useState('');
  // 「复制给 Agent」正文的条数：默认每段总耗时前 50，勾「全部」就整份复制
  // （调用关系那一节不进复制正文，见宿主侧 renderMarkdown 的 includeCalls）
  const [copyLimitText, setCopyLimitText] = useState('50');
  const [copyAll, setCopyAll] = useState(false);
  // 「Hot Classes / Modules」：none = 不生成（Agent 自己聚合）、both = 汇总 + 函数表、only = 只给汇总
  const [classesMode, setClassesMode] = useState<'none' | 'both' | 'only'>('both');
  const [, setClockTick] = useState(0);
  // 游戏退出后会话会从列表里消失，但上一次采集的结果还要能看、能分析：
  // 记住最后见到的会话标识，后续请求继续沿用它（宿主按 sessionId 保存结果与历史）。
  const lastContext = useRef<{ id: string; connectionGeneration: number }>();
  useEffect(() => {
    if (session) {
      lastContext.current = { id: session.id, connectionGeneration: session.connectionGeneration };
    }
  }, [session?.id, session?.connectionGeneration]);
  const linkSession = session ?? lastContext.current;
  const contextKey = linkSession ? `${linkSession.id}:${linkSession.connectionGeneration}` : '';
  const targetState = states[target];
  const completed = targetState?.completed;
  const result = completed?.result;
  // 历史回看：把落盘的函数明细包成一次「只读采集结果」，直接复用结果面板
  const reviewResult = useMemo<PythonProfilerResult | undefined>(() => {
    if (!review) {
      return undefined;
    }
    const fnTarget: 'client' | 'server' = review.target === 'server' ? 'server' : 'client';
    const mapped = review.functions.map((item, index) => ({
      id: index + 1,
      // 「全部」的历史里两端混在一起，逐条用条目里存的 target；旧文件没有就退回采集目标
      target: item.target ?? fnTarget,
      module: item.module,
      line: item.line,
      name: item.name,
      calls: item.calls,
      actualCalls: item.calls,
      selfTime: item.selfTime,
      totalTime: item.totalTime,
      contextId: 0,
      contextName: '',
      isProject: item.isProject !== false,
    }));
    return {
      clock: review.clock,
      elapsedSeconds: review.elapsedSeconds,
      totalFunctions: review.functionCount,
      truncated: false,
      mods: [],
      functions: mapped,
      // 历史里存了调用边（下标）就还原成调用关系，回看时「调用来源 / 下级调用」不再是空的
      calls: (review.calls ?? [])
        .filter(call => call.caller >= 0 && call.caller < mapped.length
          && call.callee >= 0 && call.callee < mapped.length)
        .map(call => ({
          callerId: mapped[call.caller].id,
          calleeId: mapped[call.callee].id,
          calls: call.calls,
          selfTime: call.selfTime,
          totalTime: call.totalTime,
        })),
    };
  }, [review]);
  const activeResult = reviewResult ?? result;
  const methodAvailable = session?.methods === undefined
    || session.methods.some(method => method.name === 'game/code/execute' && method.modes.includes('request'));
  const canProfile = Boolean(session?.connected && session.state === 'game_ready' && methodAvailable);
  const anyTargetActive = Object.values(states).some(state => (
    state?.status === 'running' || state?.status === 'collecting'
  ));

  useEffect(() => {
    setStates({});
    setPending(false);
    setError(undefined);
    setHistory([]);
    setHistoryCurrentId(undefined);
    setComparison(undefined);
    setCompareBaseId('');
    setCompareHeadId('');
    if (!linkSession) {
      return;
    }
    vscode.postMessage({
      type: 'pythonProfilerState',
      requestId: createRequestId(),
      sessionId: linkSession.id,
      connectionGeneration: linkSession.connectionGeneration,
    });
  }, [contextKey]);

  // 换会话或来了新的一次采集，就回到「全部 MOD」，避免沿用上一次的筛选
  useEffect(() => {
    setModFilter('');
  }, [contextKey, completed?.capturedAt]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      // 有会话时按会话过滤；游戏没启动时（历史请求用空 sessionId）也要收得到回包
      const fromLink = linkSession !== undefined
        && message?.sessionId === linkSession.id
        && message?.connectionGeneration === linkSession.connectionGeneration;
      const fromAnonymous = !linkSession && message?.sessionId === '';
      if (!fromLink && !fromAnonymous) {
        return;
      }
      if (message.type === 'pythonProfilerState' && Array.isArray(message.states)) {
        const next: Partial<Record<PythonProfilerTarget, PythonProfilerTargetState>> = {};
        for (const state of message.states as PythonProfilerTargetState[]) {
          if (isTarget(state.target)) {
            next[state.target] = state;
          }
        }
        setStates(next);
        setPending(false);
        setError(undefined);
      } else if (message.type === 'pythonProfilerResult' && isTarget(message.target) && message.state) {
        const captured = message.state as PythonProfilerCompletedState;
        setStates(previous => ({
          ...previous,
          [message.target]: {
            target: message.target,
            status: 'idle',
            clock: captured.clock,
            completed: captured,
          },
        }));
        setPending(false);
        const savedPath = captured.report?.markdownPath;
        if (captured.historyError) {
          setError(`${t.pythonProfilerHistorySaveFailed}: ${captured.historyError}`);
        } else if (savedPath) {
          setError(undefined);
          setNotice(`${t.pythonProfilerAutoSaved} ${shortenPath(savedPath)}`);
        }
      } else if (message.type === 'pythonProfilerError') {
        setPending(false);
        setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
      } else if (message.type === 'pythonProfilerInvalidated' && isTarget(message.target)) {
        setStates(previous => ({ ...previous, [message.target]: undefined }));
        setPending(false);
      } else if (message.type === 'pythonProfilerPromptOpened') {
        setPending(false);
        setError(undefined);
        const openedLength = typeof message.promptLength === 'number' ? message.promptLength : 0;
        setNotice(t.pythonProfilerPromptOpened.replace('{chars}', formatCount(openedLength)));
      } else if (message.type === 'pythonProfilerAnalyzed') {
        setPending(false);
        setError(undefined);
        const modScope = typeof message.mod === 'string' && message.mod
          ? `${t.pythonProfilerMod} ${message.mod} · `
          : '';
        const limitScope = typeof message.copyLimit === 'number' && message.copyLimit > 0
          ? ` · ${t.pythonProfilerCopyLimit} ${message.copyLimit}`
          : ` · ${t.pythonProfilerCopyAll}`;
        setNotice(modScope + (message.promptCopied === false
          ? t.pythonProfilerAnalyzeFallback
          : t.pythonProfilerAnalyzed + limitScope));
      } else if (message.type === 'pythonProfilerAnalyzeFailed') {
        setPending(false);
        setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
      } else if (message.type === 'pythonProfilerHistory' && Array.isArray(message.entries)) {
        const entries = message.entries as PythonProfilerHistoryEntry[];
        const currentId = typeof message.currentId === 'string' ? message.currentId : undefined;
        setHistory(entries);
        setHistoryCurrentId(currentId);
        const fallbackHead = currentId && entries.some(entry => entry.id === currentId)
          ? currentId
          : entries[0]?.id;
        setCompareHeadId(previous => (
          previous && entries.some(entry => entry.id === previous) ? previous : fallbackHead ?? ''
        ));
        setCompareBaseId(previous => {
          if (previous && entries.some(entry => entry.id === previous) && previous !== fallbackHead) {
            return previous;
          }
          return entries.find(entry => entry.id !== fallbackHead)?.id ?? '';
        });
      } else if (message.type === 'pythonProfilerHistoryLoaded' && message.entry) {
        setPending(false);
        setError(undefined);
        setReview(message.entry as PythonProfilerHistoryDetail);
        // 收起历史列表，把整块高度让给结果（否则结果区只剩 400 多像素）
        setShowHistory(false);
      } else if (message.type === 'pythonProfilerCompared') {
        setPending(false);
        setError(undefined);
        setComparison({
          summary: typeof message.summary === 'string' ? message.summary : '',
          copied: message.copied !== false,
        });
        setNotice(message.copied === false
          ? t.pythonProfilerCompareCopyFallback
          : t.pythonProfilerCompared);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [contextKey, linkSession?.id, linkSession?.connectionGeneration, t.hostBridgeRequestFailed, t.pythonProfilerAnalyzed, t.pythonProfilerAnalyzeFallback]);

  useEffect(() => {
    if (targetState?.status !== 'running') {
      return;
    }
    const timer = window.setInterval(() => setClockTick(value => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [targetState?.status, targetState?.startedAt]);

  useEffect(() => {
    if (targetState?.status === 'running' || targetState?.status === 'collecting') {
      setClock(targetState.clock);
    }
  }, [targetState?.clock, targetState?.status]);

  const statusLabel = getStatusLabel(targetState, t);
  const elapsed = getElapsed(targetState);

  const start = () => {
    // 顶部按钮没有 disabled 态，这里兜住「已经在采」时的重复点击
    if (!session || !canProfile || pending) {
      return;
    }
    if (targetState?.status === 'running' || targetState?.status === 'collecting') {
      return;
    }
    const seconds = mode === 'timed' ? Number(duration) : undefined;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      setError(`${t.pythonProfilerDuration}: > 0`);
      return;
    }
    setPending(true);
    setError(undefined);
    vscode.postMessage({
      type: 'pythonProfilerStart',
      requestId: createRequestId(),
      sessionId: session.id,
      connectionGeneration: session.connectionGeneration,
      target,
      clock,
      durationSeconds: seconds,
    });
  };

  const stop = () => {
    if (!linkSession || pending || targetState?.status !== 'running') {
      return;
    }
    setPending(true);
    setError(undefined);
    vscode.postMessage({
      type: 'pythonProfilerStop',
      requestId: createRequestId(),
      sessionId: linkSession.id,
      connectionGeneration: linkSession.connectionGeneration,
      target,
    });
  };

  // 游戏没启动时也要能翻历史：这时用空 sessionId，宿主会退到工作区目录读 .mcdev 下的记录
  const anonymousLink = { id: '', connectionGeneration: 0 };

  const requestHistory = () => {
    const link = linkSession ?? anonymousLink;
    vscode.postMessage({
      type: 'pythonProfilerHistory',
      requestId: createRequestId(),
      sessionId: link.id,
      connectionGeneration: link.connectionGeneration,
      target,
    });
  };

  /** 回看某一次历史采集：只读展示，不影响当前采集结果 */
  const reviewCapture = (historyId: string) => {
    const link = linkSession ?? anonymousLink;
    vscode.postMessage({
      type: 'pythonProfilerHistoryLoad',
      requestId: createRequestId(),
      sessionId: link.id,
      connectionGeneration: link.connectionGeneration,
      target,
      historyId,
    });
  };

  const compareCaptures = () => {
    if (pending || !compareBaseId || !compareHeadId || compareBaseId === compareHeadId) {
      return;
    }
    const link = linkSession ?? anonymousLink;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    vscode.postMessage({
      type: 'pythonProfilerCompare',
      requestId: createRequestId(),
      sessionId: link.id,
      connectionGeneration: link.connectionGeneration,
      target,
      baseId: compareBaseId,
      headId: compareHeadId,
    });
  };

  // 切换会话、换目标、展开面板、产生新采集时都刷新列表：不必先展开也知道存了几份
  useEffect(() => {
    requestHistory();
  }, [showHistory, contextKey, target, completed?.capturedAt]);

  // 0 表示「全部」：宿主按这个值决定每段保留多少条
  const copyLimit = copyAll
    ? 0
    : Math.min(Math.max(Math.floor(Number(copyLimitText) || 50), 1), 100000);

  // 先让宿主把正文生成出来并直接打开编辑器标签页里的预览面板；用户确认后才真正写剪贴板
  const requestPrompt = (scopeMod?: string, historyId?: string, classes = classesMode) => {
    if (pending || (!completed?.result && !historyId)) {
      return;
    }
    // 没会话时只能按历史条目出报告（活采集的结果还留在宿主里，但没有会话就取不到）
    if (!linkSession && !historyId) {
      return;
    }
    const link = linkSession ?? anonymousLink;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    vscode.postMessage({
      type: 'pythonProfilerPreparePrompt',
      requestId: createRequestId(),
      sessionId: link.id,
      connectionGeneration: link.connectionGeneration,
      target,
      mod: scopeMod || undefined,
      historyId,
      copyLimit,
      classes,
    });
  };

  const analyzeWithAgent = (entryId?: string) => {
    // 回看历史时也能复制：带上 historyId，宿主按落盘记录重新出报告
    requestPrompt(modFilter || undefined, entryId ?? review?.id);
  };


  // 集成面板的「开始采集 / 停止采集」：nonce 变化才算一次新指令。
  // 开始时只看顶部下拉选的范围（选「仅内存」就别跟着起性能采样）；
  // 停止时一律先试一遍——stop() 自己会判断有没有在采，不会误伤，
  // 这样下拉切走之后也不会剩下一个没按钮可停的采集。
  // 初值取挂载时的 nonce：页签切走再切回来会重新挂载，不能把上一条指令当成新指令再执行一遍
  const syncNonceRef = useRef(sync?.nonce ?? 0);
  useEffect(() => {
    if (!sync || sync.nonce === syncNonceRef.current) {
      return;
    }
    syncNonceRef.current = sync.nonce;
    if (sync.kind === 'start') {
      if ((sync.scope ?? 'both') !== 'memory') {
        start();
      }
      return;
    }
    stop();
  }, [sync?.nonce]);

  const reportAction = (
    type: 'pythonProfilerSaveReport' | 'pythonProfilerOpenReport' | 'pythonProfilerRevealReport',
    kind?: 'markdown' | 'svg'
  ) => {
    if (!linkSession) {
      return;
    }
    if (type === 'pythonProfilerSaveReport') {
      setPending(true);
      setError(undefined);
    }
    vscode.postMessage({
      type,
      requestId: createRequestId(),
      sessionId: linkSession.id,
      connectionGeneration: linkSession.connectionGeneration,
      target,
      kind,
    });
  };

  return (
    <div className="python-profiler-workspace" ref={workspaceRef}>
      <div className="python-profiler-toolbar">
        <ControlGroup label={t.pythonProfilerTarget}>
          <SegmentedControl
            value={target}
            options={[
              ['client', t.hostBridgeClient],
              ['server', t.hostBridgeServer],
              ['all', t.pythonProfilerAll],
            ]}
            disabled={anyTargetActive}
            onChange={value => {
              setTarget(value as PythonProfilerTarget);
            }}
          />
        </ControlGroup>
        <ControlGroup label={t.pythonProfilerClock} hint={t.pythonProfilerClockHint}>
          <SegmentedControl
            value={clock}
            options={[
              ['CPU', t.pythonProfilerCpu],
              ['WALL', t.pythonProfilerWall],
            ]}
            onChange={value => setClock(value as 'CPU' | 'WALL')}
            disabled={targetState?.status !== 'idle' && targetState !== undefined}
          />
        </ControlGroup>
        <ControlGroup label={t.pythonProfilerMode}>
          <SegmentedControl
            value={mode}
            options={[
              ['timed', t.pythonProfilerTimed],
              ['manual', t.pythonProfilerManual],
            ]}
            onChange={value => setMode(value as CaptureMode)}
            disabled={targetState?.status !== 'idle' && targetState !== undefined}
          />
        </ControlGroup>
        {mode === 'timed' && (
          <label className="python-profiler-duration">
            <span>{t.pythonProfilerDuration}</span>
            <span className="python-profiler-number-field">
              <input
                type="text"
                inputMode="decimal"
                value={duration}
                disabled={targetState?.status !== 'idle' && targetState !== undefined}
                onChange={event => setDuration(event.target.value)}
              />
              <small>{t.pythonProfilerSeconds}</small>
              <span className="python-profiler-stepper">
                <button
                  type="button"
                  disabled={targetState?.status !== 'idle' && targetState !== undefined}
                  onClick={() => setDuration(adjustDuration(duration, -1))}
                  title={`-1 ${t.pythonProfilerSeconds}`}
                  aria-label={`-1 ${t.pythonProfilerSeconds}`}
                ><span className="codicon codicon-remove" /></button>
                <button
                  type="button"
                  disabled={targetState?.status !== 'idle' && targetState !== undefined}
                  onClick={() => setDuration(adjustDuration(duration, 1))}
                  title={`+1 ${t.pythonProfilerSeconds}`}
                  aria-label={`+1 ${t.pythonProfilerSeconds}`}
                ><span className="codicon codicon-add" /></button>
              </span>
            </span>
          </label>
        )}
        {/* 集成面板顶部已经有「开始采集（性能+内存）/ 停止采集」，这里再放一个就是重复的两颗按钮 */}
        {topBarCapture ? (
          <span className="capture-synced-hint">
            <span className="codicon codicon-info" />
            <span>{t.captureFromTopBar}</span>
          </span>
        ) : (
          <div className="python-profiler-action">
            {targetState?.status === 'running' ? (
              <button type="button" className="python-profiler-stop" disabled={pending} onClick={stop}>
                <span className="codicon codicon-debug-stop" />
                <span>{t.pythonProfilerStop}</span>
              </button>
            ) : (
              <button
                type="button"
                className="python-profiler-start"
                disabled={!canProfile || pending || targetState?.status === 'collecting'}
                onClick={start}
              >
                <span className="codicon codicon-record" />
                <span>{t.pythonProfilerStart}</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className={`python-profiler-status ${targetState?.status ?? 'idle'}`}>
        <span className="python-profiler-status-dot" />
        <strong>{canProfile ? statusLabel : (activeResult ? t.pythonProfilerSessionEnded : t.pythonProfilerUnavailable)}</strong>
        {elapsed !== undefined && <time>{formatTime(elapsed)}</time>}
        {activeResult && (
          <span className="python-profiler-result-meta">
            {formatTime(activeResult.elapsedSeconds)} · {activeResult.totalFunctions} {t.pythonProfilerFunction.toLowerCase()}
            {activeResult.truncated ? ` · ${t.pythonProfilerTruncated}` : ''}
          </span>
        )}
        {completed && !completed.report && (
          <button
            type="button"
            className="python-profiler-save-report"
            disabled={pending}
            onClick={() => reportAction('pythonProfilerSaveReport')}
          >
            <span className="codicon codicon-save" />
            <span>{t.pythonProfilerSaveReport}</span>
          </button>
        )}
        {activeResult && (
          <div className="python-profiler-copy-limit" title={t.pythonProfilerCopyLimitHint}>
            <label>
              <span>{t.pythonProfilerCopyLimit}</span>
              <input
                type="number"
                min={1}
                step={50}
                value={copyLimitText}
                disabled={copyAll || pending}
                aria-label={t.pythonProfilerCopyLimit}
                onChange={event => setCopyLimitText(event.target.value)}
                onBlur={() => setCopyLimitText(String(copyLimit || 50))}
              />
            </label>
            <label className="python-profiler-copy-all">
              <input
                type="checkbox"
                checked={copyAll}
                onChange={event => setCopyAll(event.target.checked)}
              />
              <span>{t.pythonProfilerCopyAll}</span>
            </label>
            <label title={t.pythonProfilerClassesHint}>
              <span>{t.pythonProfilerClassesLabel}</span>
              <select
                value={classesMode}
                onChange={event => setClassesMode(event.target.value === 'none' || event.target.value === 'only' ? event.target.value : 'both')}
              >
                <option value="both">{t.pythonProfilerClassesBoth}</option>
                <option value="only">{t.pythonProfilerClassesOnly}</option>
                <option value="none">{t.pythonProfilerClassesNone}</option>
              </select>
            </label>
          </div>
        )}
        {activeResult && (
          <button
            type="button"
            className="python-profiler-analyze"
            disabled={pending}
            onClick={() => analyzeWithAgent()}
            title={`${modFilter
              ? `${t.pythonProfilerAnalyzeHint} · ${t.pythonProfilerMod} ${modFilter}`
              : t.pythonProfilerAnalyzeHint} · ${copyAll ? t.pythonProfilerCopyAll : `${t.pythonProfilerCopyLimit} ${copyLimit}`}`}
          >
            <span className="codicon codicon-copy" />
            <span>{modFilter ? `${t.pythonProfilerAnalyzeMod} ${modFilter}` : t.pythonProfilerAnalyze}</span>
          </button>
        )}
        <button
          type="button"
          className={`python-profiler-history-toggle${showHistory ? ' active' : ''}`}
          aria-pressed={showHistory}
          onClick={() => setShowHistory(value => !value)}
          title={t.pythonProfilerHistoryHint}
        >
          <span className="codicon codicon-history" aria-hidden="true" />
          <span>{t.pythonProfilerHistory}</span>
          {history.length > 0 && <small>{history.length}</small>}
        </button>
        {completed?.report && (
          <div className="python-profiler-report-actions">
            <button type="button" onClick={() => reportAction('pythonProfilerOpenReport', 'markdown')} title={t.pythonProfilerOpenMarkdown}>
              <span className="codicon codicon-markdown" />
            </button>
            <button type="button" onClick={() => reportAction('pythonProfilerOpenReport', 'svg')} title={t.pythonProfilerOpenSvg}>
              <span className="codicon codicon-graph" />
            </button>
            <button type="button" onClick={() => reportAction('pythonProfilerRevealReport')} title={t.pythonProfilerRevealReport}>
              <span className="codicon codicon-folder-opened" />
            </button>
          </div>
        )}
      </div>

      {(error || completed?.reportError) && (
        <div className="python-profiler-error" role="alert">
          <span className="codicon codicon-error" />
          <span>{error || `${t.pythonProfilerReportFailed}: ${completed?.reportError}`}</span>
        </div>
      )}

      {notice && !error && (
        <div className="python-profiler-notice" role="status">
          <span className="codicon codicon-check" />
          <span>{notice}</span>
        </div>
      )}

      {showHistory && (
        <section
          className="python-profiler-history"
          aria-label={t.pythonProfilerHistory}
          ref={historyRef}
          style={historyHeight === null ? undefined : { maxHeight: `${Math.round(historyHeight)}px` }}
        >
          <header>
            <h2>{t.pythonProfilerHistory}<small>{history.length}</small></h2>
            <span className="python-profiler-history-hint">{t.pythonProfilerHistoryHint}</span>
            <button
              type="button"
              className="btn-icon"
              onClick={requestHistory}
              title={t.pythonProfilerHistoryRefresh}
            >
              <span className="codicon codicon-refresh" aria-hidden="true" />
            </button>
          </header>
          {history.length === 0 ? (
            <p className="python-profiler-history-empty">{t.pythonProfilerHistoryEmpty}</p>
          ) : (
            <ul className="python-profiler-history-list">
              {history.map(entry => (
                <li
                  key={entry.id}
                  className={`python-profiler-history-row${review?.id === entry.id ? ' is-reviewing' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={t.pythonProfilerHistoryOpen}
                  onClick={() => reviewCapture(entry.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      reviewCapture(entry.id);
                    }
                  }}
                >
                  <span className="python-profiler-history-time">{formatHistoryTime(entry.capturedAt)}</span>
                  <span className="python-profiler-history-meta">
                    {entry.target}/{entry.clock} · {formatTime(entry.elapsedSeconds)} · {entry.functionCount} fn
                    {entry.worldName ? ` · ${entry.worldName}` : ''}
                  </span>
                  <span className="python-profiler-history-top" title={historyTopFunction(entry)}>
                    {historyTopFunction(entry)}
                  </span>
                  {entry.id === historyCurrentId && (
                    <em className="python-profiler-history-current">{t.pythonProfilerHistoryCurrent}</em>
                  )}
                  <span className="python-profiler-history-chips">
                    <button
                      type="button"
                      className="python-profiler-history-agent"
                      title={t.pythonProfilerAnalyzeHint}
                      aria-label={t.pythonProfilerAnalyze}
                      onClick={event => {
                        event.stopPropagation();
                        analyzeWithAgent(entry.id);
                      }}
                    >
                      <span className="codicon codicon-copy" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={entry.id === compareBaseId ? 'active' : ''}
                      aria-pressed={entry.id === compareBaseId}
                      title={t.pythonProfilerCompareBase}
                      onClick={event => {
                        event.stopPropagation();
                        setCompareBaseId(entry.id);
                      }}
                    >A</button>
                    <button
                      type="button"
                      className={entry.id === compareHeadId ? 'active' : ''}
                      aria-pressed={entry.id === compareHeadId}
                      title={t.pythonProfilerCompareHead}
                      onClick={event => {
                        event.stopPropagation();
                        setCompareHeadId(entry.id);
                      }}
                    >B</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <footer>
            <span className="python-profiler-history-selection">
              <strong>A</strong> {historyLabel(history.find(item => item.id === compareBaseId))}
              <span className="codicon codicon-arrow-right" aria-hidden="true" />
              <strong>B</strong> {historyLabel(history.find(item => item.id === compareHeadId))}
            </span>
            <button
              type="button"
              className="python-profiler-compare"
              disabled={pending || !compareBaseId || !compareHeadId || compareBaseId === compareHeadId}
              onClick={compareCaptures}
              title={t.pythonProfilerCompareHint}
            >
              <span className="codicon codicon-diff" aria-hidden="true" />
              <span>{t.pythonProfilerCompare}</span>
            </button>
          </footer>
          {comparison && (
            <pre className="python-profiler-compare-summary" aria-label={t.pythonProfilerCompare}>
              {comparison.summary}
            </pre>
          )}
        </section>
      )}

      {showHistory && (
        <div
          className="python-profiler-history-splitter"
          role="separator"
          aria-orientation="horizontal"
          tabIndex={0}
          title={t.pythonProfilerResizeHint}
          onDoubleClick={() => setHistoryHeight(null)}
          onKeyDown={event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
              return;
            }
            event.preventDefault();
            const current = historyRef.current?.getBoundingClientRect().height ?? 160;
            setHistoryHeight(Math.max(90, current + (event.key === 'ArrowUp' ? -40 : 40)));
          }}
          onPointerDown={event => {
            resizingHistory.current = true;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeHistory(event.clientY);
          }}
          onPointerMove={event => {
            if (resizingHistory.current) {
              resizeHistory(event.clientY);
            }
          }}
          onPointerUp={event => {
            resizingHistory.current = false;
            try {
              event.currentTarget.releasePointerCapture(event.pointerId);
            } catch {
              // 已释放
            }
          }}
          onPointerCancel={() => {
            resizingHistory.current = false;
          }}
        />
      )}

      {review && (
        <div className="python-profiler-review" role="status">
          <span className="codicon codicon-history" aria-hidden="true" />
          <span>
            {t.pythonProfilerReviewBanner.replace('{time}', formatHistoryTime(review.capturedAt))}
          </span>
          <button
            type="button"
            className="btn-icon"
            onClick={() => setReview(undefined)}
            title={t.pythonProfilerReviewExit}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      )}

      {activeResult ? (
        <PythonProfilerResults
          result={activeResult}
          bridgeSession={linkSession}
          target={target}
          t={t}
          modFilter={modFilter}
          onModFilterChange={setModFilter}
        />
      ) : (
        <div className="python-profiler-empty">
          <span className="codicon codicon-pulse" />
          <span>{canProfile ? t.pythonProfilerIdle : t.pythonProfilerUnavailable}</span>
        </div>
      )}


    </div>
  );
}

export const PythonProfilerResults = memo(function PythonProfilerResults({
  result,
  bridgeSession,
  target,
  t,
  modFilter,
  onModFilterChange,
}: {
  result: NonNullable<PythonProfilerCompletedState['result']>;
  /** 复用「上一次见过的会话标识」：游戏退出后仍能跳源码 */
  bridgeSession?: { id: string; connectionGeneration: number };
  target: PythonProfilerTarget;
  t: I18nText;
  modFilter: string;
  onModFilterChange: (mod: string) => void;
}) {
  const [selectedFunctionId, setSelectedFunctionId] = useState<number>();
  const [functionsPaneWidth, setFunctionsPaneWidth] = useState(60);
  const [includeEngine, setIncludeEngine] = useState(false);
  const resultsLayout = useRef<HTMLDivElement>(null);
  const resizingFunctionsPane = useRef(false);
  /** 窄屏（上下堆叠）时函数列表的像素高度；null = 用比例默认值 */
  const [functionsRowHeight, setFunctionsRowHeight] = useState<number | null>(null);
  const resizingFunctionsRow = useRef(false);
  /** 「热点函数」整块浮起来时的位置（相对视口）；null＝照常占一行 */
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const draggingFloat = useRef<{ dx: number; dy: number } | null>(null);
  /** 「函数名/路径」这一列的像素宽度；null＝默认比例。窄屏下拖表头第一格右边缘可改 */
  const [nameColPx, setNameColPx] = useState<number | null>(null);
  const resizingNameCol = useRef<{ startX: number; startWidth: number } | null>(null);
  /** 列顺序（拖表头任意列可换位置，包括把「函数」列拖到最右） */
  const [columnOrder, setColumnOrder] = useState<ProfilerColumn[]>(DEFAULT_COLUMN_ORDER);
  const columnDrag = useRef<{ key: ProfilerColumn; startX: number } | null>(null);
  /** 容器太窄时两个面板上下堆叠（用 class 驱动，不依赖媒体查询，避免 Webview 尺寸判断失效） */
  // 首帧就按窗口宽度猜一次，避免窄面板先闪一帧左右分栏（那帧里详情只有 178px 宽）
  const [stacked, setStacked] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth <= 820
  );
  const visibleColumns = stacked ? columnOrder.filter(key => key !== 'calls') : columnOrder;
  const columnTrack = (key: ProfilerColumn): string => {
    if (key === 'name') {
      return stacked ? 'var(--python-profiler-name-col, minmax(0, 1.1fr))' : 'minmax(220px, 1.35fr)';
    }
    if (key === 'bar') {
      return stacked ? 'minmax(0, 0.9fr)' : 'minmax(150px, 1fr)';
    }
    return key === 'calls' ? '58px' : '82px';
  };
  const gridTracks = visibleColumns.map(columnTrack).join(' ');
  const beginColumnDrag = (key: ProfilerColumn, event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('.python-profiler-col-resizer')) {
      return;
    }
    columnDrag.current = { key, startX: event.clientX };
  };
  const endColumnDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = columnDrag.current;
    columnDrag.current = null;
    if (!drag || Math.abs(event.clientX - drag.startX) < 20) {
      return;
    }
    const header = event.currentTarget.closest('.python-profiler-table-header');
    const cells = header ? Array.from(header.querySelectorAll<HTMLElement>('.python-profiler-col-header')) : [];
    if (cells.length === 0) {
      return;
    }
    const target = cells.findIndex(cell => {
      const box = cell.getBoundingClientRect();
      return event.clientX < box.left + box.width / 2;
    });
    const visible = columnOrder.filter(key => !stacked || key !== 'calls');
    const anchor = target < 0 ? undefined : visible[target];
    setColumnOrder(previous => {
      const order = previous.filter(key => key !== drag.key);
      const at = anchor ? order.indexOf(anchor) : order.length;
      order.splice(at < 0 ? order.length : at, 0, drag.key);
      return order;
    });
  };
  const lastLayoutProbe = useRef('');
  useEffect(() => {
    const element = resultsLayout.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const measure = (target: Element | null) => {
      if (!target) {
        return null;
      }
      const box = target.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
    };
    const apply = () => {
      const box = element.getBoundingClientRect();
      setStacked(box.width > 0 && box.width <= 820);
      // 面板高度变小后要把握好的像素高度收回来，否则下面的「调用详情」会被顶出可视区且拖不到
      if (box.height > 0) {
        setFunctionsRowHeight(previous => {
          if (previous === null) {
            return previous;
          }
          // 容器矮的时候先给「调用详情」留出 120px，再谈函数区最小高度：
          // 否则钳出来的行高之和超过容器，两块谁都滚不到底
          const available = Math.max(80, box.height - 12 - 120);
          const minimum = Math.min(available, Math.max(80, Math.min(200, box.height * 0.3)));
          const clamped = Math.max(minimum, Math.min(available, previous));
          return Math.abs(clamped - previous) < 1 ? previous : clamped;
        });
      }
      const style = getComputedStyle(element);
      const probe = {
        version: '0.1.77',
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        container: measure(element),
        functions: measure(element.querySelector('.python-profiler-functions')),
        details: measure(element.querySelector('.python-profiler-call-details')),
        splitter: measure(element.querySelector('.python-profiler-splitter')),
        classes: element.className,
        columns: style.gridTemplateColumns,
        rows: style.gridTemplateRows,
      };
      const signature = JSON.stringify(probe);
      if (signature !== lastLayoutProbe.current) {
        lastLayoutProbe.current = signature;
        vscode.postMessage({ type: 'layoutProbe', data: probe });
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const engineCount = useMemo(
    () => result.functions.filter(item => item.isProject === false).length,
    [result]
  );
  // 一律前端按归一化后的 mod 根目录重新聚合：宿主载荷可能是旧版（还带 client/common 后缀），
  // 那样会在筛选条里冒出好几条同名胶囊，也和下面的过滤规则对不上。
  const mods = useMemo(() => {
    const groups = new Map<string, { name: string; functions: number; calls: number; selfTime: number; totalTime: number }>();
    for (const item of result.functions) {
      const name = profilerModName(item);
      if (!name) continue;
      const entry = groups.get(name) ?? { name, functions: 0, calls: 0, selfTime: 0, totalTime: 0 };
      entry.functions += 1;
      entry.calls += item.calls;
      entry.selfTime += item.selfTime;
      entry.totalTime += item.totalTime;
      groups.set(name, entry);
    }
    return Array.from(groups.values()).sort((left, right) => (
      right.selfTime - left.selfTime
      || right.totalTime - left.totalTime
      || left.name.localeCompare(right.name)
    ));
  }, [result]);
  // 选中的 mod 从列表里消失（重新采集 / 换会话）就退回全部
  useEffect(() => {
    if (modFilter && !mods.some(item => item.name === modFilter)) {
      onModFilterChange('');
    }
  }, [modFilter, mods, onModFilterChange]);
  // 只看某个 mod 时，调用详情也只在这个 mod 内展开，避免把引擎/别的 mod 混进因果链
  const scopedFunctions = useMemo(
    () => (modFilter ? result.functions.filter(item => profilerModName(item) === modFilter) : result.functions),
    [modFilter, result]
  );
  // 默认只列 mod 自己的函数，引擎 / 原版函数由开关显式打开
  const functions = useMemo(() => {
    const scoped = includeEngine
      ? scopedFunctions
      : scopedFunctions.filter(item => item.isProject !== false);
    return scoped.slice().sort((left, right) => right.totalTime - left.totalTime);
  }, [includeEngine, scopedFunctions]);
  const maximumTotalTime = Math.max(0, ...functions.map(item => item.totalTime));
  const visibleFunctions = useMemo(() => functions.slice(0, MAX_VISIBLE_ROWS), [functions]);
  useEffect(() => {
    if (!functions.some(item => item.id === selectedFunctionId)) {
      setSelectedFunctionId(functions[0]?.id);
    }
  }, [functions, selectedFunctionId]);
  const selectedFunction = functions.find(item => item.id === selectedFunctionId);
  const relationships = useMemo(
    // 关系在完整函数表里查：调用者/被调用者可能被 MOD 筛选或引擎折叠隐藏了，但仍然要能显示出来
    () => getRelationships(selectedFunction, result.functions, result.calls),
    [result, selectedFunction]
  );
  const openFunction = (item: PythonProfilerFunction) => {
    if (!bridgeSession) {
      return;
    }
    vscode.postMessage({
      type: 'pythonProfilerOpenFunction',
      requestId: createRequestId(),
      sessionId: bridgeSession.id,
      connectionGeneration: bridgeSession.connectionGeneration,
      target,
      functionId: item.id,
    });
  };
  const paneWidthLimits = () => {
    const bounds = resultsLayout.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return { minimum: 24, maximum: 76 };
    }
    const minimum = Math.min(42, (280 / bounds.width) * 100);
    const maximum = Math.max(minimum, 100 - ((280 + 5) / bounds.width) * 100);
    return { minimum, maximum };
  };
  const resizeFunctionsPane = (clientX: number) => {
    const bounds = resultsLayout.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) {
      return;
    }
    const { minimum, maximum } = paneWidthLimits();
    const next = ((clientX - bounds.left) / bounds.width) * 100;
    setFunctionsPaneWidth(Math.max(minimum, Math.min(maximum, next)));
  };
  // 窄屏时两个面板改为上下堆叠，分隔条变成可上下拖动
  const stackedLayout = () => stacked;
  const paneHeightLimits = () => {
    const bounds = resultsLayout.current?.getBoundingClientRect();
    const height = bounds && bounds.height > 0 ? bounds.height : 0;
    if (height <= 0) {
      return { minimum: 96, maximum: 480 };
    }
    const available = Math.max(80, height - 12 - 120);
    const minimum = Math.min(available, Math.max(80, Math.min(200, height * 0.3)));
    return { minimum, maximum: available };
  };
  const currentPaneHeight = () => {
    if (functionsRowHeight !== null) {
      return functionsRowHeight;
    }
    const bounds = resultsLayout.current?.getBoundingClientRect();
    return bounds && bounds.height > 0 ? bounds.height * 0.46 : 0;
  };
  const resizeFunctionsRow = (clientY: number) => {
    const element = resultsLayout.current;
    const bounds = element?.getBoundingClientRect();
    if (!element || !bounds || bounds.height <= 0) {
      return;
    }
    const { minimum, maximum } = paneHeightLimits();
    const offset = clientY - bounds.top + element.scrollTop;
    setFunctionsRowHeight(Math.max(minimum, Math.min(maximum, offset)));
  };
  /** ↑/↓ 按钮：每次 60px 步进，找不到抓手时也能调 */
  const nudgeRowHeight = (delta: number) => {
    const { minimum, maximum } = paneHeightLimits();
    setFunctionsRowHeight(Math.max(minimum, Math.min(maximum, currentPaneHeight() + delta)));
  };
  /** 拖表头第一列右边缘：改「函数名/路径/上下文」这一列的宽度 */
  const beginNameColResize = (event: React.PointerEvent<HTMLElement>) => {
    const cell = event.currentTarget.closest('.python-profiler-name-header');
    const container = resultsLayout.current;
    if (!cell || !container) {
      return;
    }
    event.preventDefault();
    resizingNameCol.current = {
      startX: event.clientX,
      startWidth: cell.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveNameColResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = resizingNameCol.current;
    if (!drag) {
      return;
    }
    const width = resultsLayout.current?.getBoundingClientRect().width ?? 0;
    const maximum = Math.max(160, width - 200);
    const next = Math.max(120, Math.min(maximum, drag.startWidth + (event.clientX - drag.startX)));
    setNameColPx(Math.round(next));
  };
  const endNameColResize = (event: React.PointerEvent<HTMLElement>) => {
    if (!resizingNameCol.current) {
      return;
    }
    resizingNameCol.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已释放
    }
  };
  /** 拖「热点函数」标题左侧的把手：整块浮起来，可摆到面板任意位置 */
  const beginFloatMove = (event: React.PointerEvent<HTMLElement>) => {
    const section = event.currentTarget.closest('.python-profiler-functions') as HTMLElement | null;
    if (!section || (event.target as HTMLElement).closest('button')) {
      return;
    }
    event.preventDefault();
    const box = section.getBoundingClientRect();
    draggingFloat.current = { dx: event.clientX - box.left, dy: event.clientY - box.top };
    setFloatPos(prev => prev ?? { x: Math.round(box.left), y: Math.round(box.top) });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveFloat = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggingFloat.current) {
      return;
    }
    const width = event.currentTarget.closest('.python-profiler-functions')?.getBoundingClientRect().width ?? 320;
    const x = Math.max(0, Math.min(window.innerWidth - width, event.clientX - draggingFloat.current.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 60, event.clientY - draggingFloat.current.dy));
    setFloatPos({ x: Math.round(x), y: Math.round(y) });
  };
  const endFloatMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!draggingFloat.current) {
      return;
    }
    draggingFloat.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已释放
    }
  };
  /** 「调用详情」标题栏也能当抓手拖动 */
  const beginRowResize = (event: React.PointerEvent<HTMLElement>) => {
    if (!stacked) {
      return;
    }
    event.preventDefault();
    resizingFunctionsRow.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeFunctionsRow(event.clientY);
  };
  const moveRowResize = (event: React.PointerEvent<HTMLElement>) => {
    if (resizingFunctionsRow.current) {
      resizeFunctionsRow(event.clientY);
    }
  };
  const endRowResize = (event: React.PointerEvent<HTMLElement>) => {
    if (!resizingFunctionsRow.current) {
      return;
    }
    resizingFunctionsRow.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已释放时忽略
    }
  };
  return (
    <div
      className={`python-profiler-results${stacked ? ' is-stacked' : ''}${floatPos ? ' is-functions-floating' : ''}`}
      ref={resultsLayout}
      style={{
        '--python-profiler-functions-width': `${functionsPaneWidth}%`,
        ...(stacked && functionsRowHeight !== null && !floatPos
          ? { gridTemplateRows: `${Math.round(functionsRowHeight)}px 12px minmax(120px, 1fr)` }
          : {}),
        ...(stacked && nameColPx !== null
          ? { '--python-profiler-name-col': `${Math.round(nameColPx)}px` }
          : {}),
        '--python-profiler-tracks': gridTracks,

      } as CSSProperties}
    >
      <section
        className={`python-profiler-functions${floatPos ? ' is-floating' : ''}`}
        aria-label={t.pythonProfilerHotFunctions}
        style={floatPos ? { left: `${floatPos.x}px`, top: `${floatPos.y}px` } : undefined}
      >
        <header
          onPointerDown={beginFloatMove}
          onPointerMove={moveFloat}
          onPointerUp={endFloatMove}
          onPointerCancel={endFloatMove}
          onDoubleClick={() => setFloatPos(null)}
        >
          <span
            className="python-profiler-float-handle"
            role="button"
            tabIndex={0}
            title={t.pythonProfilerFloatHint}
            onPointerDown={beginFloatMove}
            onPointerMove={moveFloat}
            onPointerUp={endFloatMove}
            onPointerCancel={endFloatMove}
            onDoubleClick={() => setFloatPos(null)}
          >
            <span className="codicon codicon-move" aria-hidden="true" />
          </span>
          <h2>{t.pythonProfilerHotFunctions}</h2>
          <button
            type="button"
            className={`python-profiler-scope${includeEngine ? ' active' : ''}`}
            aria-pressed={includeEngine}
            disabled={engineCount === 0}
            title={engineCount > 0 ? t.pythonProfilerScopeHint : t.pythonProfilerScopeEmpty}
            onClick={() => setIncludeEngine(value => !value)}
          >
            <span className="codicon codicon-filter" aria-hidden="true" />
            <span>{includeEngine ? t.pythonProfilerScopeAll : t.pythonProfilerScopeMod}</span>
            <small>{engineCount}</small>
          </button>
          {floatPos && (
            <button
              type="button"
              className="python-profiler-float-reset"
              title={t.pythonProfilerFloatReset}
              aria-label={t.pythonProfilerFloatReset}
              onClick={() => setFloatPos(null)}
            >
              <span className="codicon codicon-pin" aria-hidden="true" />
            </button>
          )}
          {stacked && (
            <span className="python-profiler-height-controls">
              <button
                type="button"
                title={t.pythonProfilerShrinkFunctions}
                aria-label={t.pythonProfilerShrinkFunctions}
                onClick={() => nudgeRowHeight(-60)}
              >
                <span className="codicon codicon-chevron-up" aria-hidden="true" />
              </button>
              <button
                type="button"
                title={t.pythonProfilerExpandFunctions}
                aria-label={t.pythonProfilerExpandFunctions}
                onClick={() => nudgeRowHeight(60)}
              >
                <span className="codicon codicon-chevron-down" aria-hidden="true" />
              </button>
            </span>
          )}
          <span className="python-profiler-navigation-hint">{t.pythonProfilerDoubleClickHint}</span>
        </header>
        {mods.length > 1 && (
          <div className="python-profiler-mod-filter" role="group" aria-label={t.pythonProfilerMod}>
            <button
              type="button"
              className={`python-profiler-mod-chip${modFilter ? '' : ' active'}`}
              aria-pressed={!modFilter}
              title={t.pythonProfilerModHint}
              onClick={() => onModFilterChange('')}
            >
              <span className="codicon codicon-library" aria-hidden="true" />
              <span>{t.pythonProfilerModAll}</span>
              <small>{mods.length}</small>
            </button>
            {mods.map(mod => (
              <button
                key={mod.name}
                type="button"
                className={`python-profiler-mod-chip${modFilter === mod.name ? ' active' : ''}`}
                aria-pressed={modFilter === mod.name}
                title={`${mod.name} · ${mod.functions} ${t.pythonProfilerFunction} · ${t.pythonProfilerSelfTime} ${formatTime(mod.selfTime)} · ${t.pythonProfilerTotalTime} ${formatTime(mod.totalTime)}`}
                onClick={() => onModFilterChange(modFilter === mod.name ? '' : mod.name)}
              >
                <span className="codicon codicon-package" aria-hidden="true" />
                <span className="python-profiler-mod-name">{mod.name}</span>
                <small>{mod.functions}</small>
              </button>
            ))}
          </div>
        )}
        <div className="python-profiler-table-header" aria-hidden="true">
          {visibleColumns.map(key => (
            <span
              key={key}
              className={`python-profiler-col-header${key === 'name' ? ' python-profiler-name-header' : ''}${key === 'bar' ? ' python-profiler-distribution-header' : ''}`}
              title={t.pythonProfilerColumnDragHint}
              onPointerDown={event => beginColumnDrag(key, event)}
              onPointerUp={endColumnDrag}
              onPointerCancel={() => {
                columnDrag.current = null;
              }}
            >
              {key === 'name' && (
                <>
                  {t.pythonProfilerFunction}
                  {stacked && (
                    <i
                      className="python-profiler-col-resizer"
                      role="separator"
                      aria-orientation="vertical"
                      title={t.pythonProfilerResizeColumnHint}
                      onDoubleClick={() => setNameColPx(null)}
                      onPointerDown={beginNameColResize}
                      onPointerMove={moveNameColResize}
                      onPointerUp={endNameColResize}
                      onPointerCancel={endNameColResize}
                    />
                  )}
                </>
              )}
              {key === 'bar' && (
                <>
                  <span>{t.pythonProfilerDistribution}</span>
                  <i className="total" />
                  <small>{t.pythonProfilerTotalTime}</small>
                  <i className="self" />
                  <small>{t.pythonProfilerSelfTime}</small>
                </>
              )}
              {key === 'calls' && t.pythonProfilerCalls}
              {key === 'self' && t.pythonProfilerSelfTime}
              {key === 'total' && t.pythonProfilerTotalTime}
            </span>
          ))}
        </div>
        <div className="python-profiler-table" role="listbox">
          {visibleFunctions.map(item => (
            <button
              type="button"
              role="option"
              aria-selected={item.id === selectedFunctionId}
              className={item.id === selectedFunctionId ? 'selected' : ''}
              key={item.id}
              onClick={() => setSelectedFunctionId(item.id)}
              onDoubleClick={() => openFunction(item)}
            >
              {visibleColumns.map(key => {
                if (key === 'name') {
                  return (
                    <span key="name" className="python-profiler-function-name">
                      <strong>{item.name}</strong>
                      <small title={formatLocation(item)}>{formatLocation(item)}</small>
                      <span className="python-profiler-function-context" title={formatContext(item, t)}>
                        <span className={`codicon ${item.target === 'client' ? 'codicon-device-desktop' : 'codicon-server'}`} />
                        <span>{formatContext(item, t)}</span>
                      </span>
                    </span>
                  );
                }
                if (key === 'bar') {
                  return (
                    <span
                      key="bar"
                      className="python-profiler-time-bar"
                      style={timeBarStyle(item, maximumTotalTime)}
                      title={`${t.pythonProfilerTotalTime}: ${formatProfileTime(item.totalTime, item.calls, result.clock, t)} | ${t.pythonProfilerSelfTime}: ${formatProfileTime(item.selfTime, item.calls, result.clock, t)}`}
                    >
                      <span className="total" />
                      <span className="self" />
                    </span>
                  );
                }
                if (key === 'calls') {
                  return <span key="calls">{item.calls}</span>;
                }
                if (key === 'self') {
                  return <span key="self">{formatProfileTime(item.selfTime, item.calls, result.clock, t)}</span>;
                }
                return <span key="total">{formatProfileTime(item.totalTime, item.calls, result.clock, t)}</span>;
              })}
            </button>
          ))}
        </div>
        {functions.length > visibleFunctions.length && (
          <div className="python-profiler-rows-hint">
            {t.pythonProfilerRowsHidden
              .replace('{shown}', String(visibleFunctions.length))
              .replace('{total}', String(functions.length))}
          </div>
        )}
      </section>
      <div
        className="python-profiler-splitter"
        role="separator"
        tabIndex={0}
        aria-orientation={stackedLayout() ? 'horizontal' : 'vertical'}
        aria-valuemin={stackedLayout() ? Math.round(paneHeightLimits().minimum) : 24}
        aria-valuemax={stackedLayout() ? Math.round(paneHeightLimits().maximum) : 76}
        aria-valuenow={stackedLayout() ? Math.round(currentPaneHeight()) : Math.round(functionsPaneWidth)}
        title={t.pythonProfilerResizeHint}
        onDoubleClick={() => {
          if (stackedLayout()) {
            setFunctionsRowHeight(null);
          } else {
            setFunctionsPaneWidth(60);
          }
        }}
        onKeyDown={event => {
          if (stackedLayout()) {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
              return;
            }
            event.preventDefault();
            const { minimum, maximum } = paneHeightLimits();
            const delta = event.key === 'ArrowUp' ? -24 : 24;
            setFunctionsRowHeight(currentPaneHeight() + delta < minimum
              ? minimum
              : Math.min(maximum, currentPaneHeight() + delta));
            return;
          }
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
          }
          event.preventDefault();
          const { minimum, maximum } = paneWidthLimits();
          setFunctionsPaneWidth(value => Math.max(
            minimum,
            Math.min(maximum, value + (event.key === 'ArrowLeft' ? -2 : 2))
          ));
        }}
        onPointerDown={event => {
          const stacked = stackedLayout();
          resizingFunctionsPane.current = !stacked;
          resizingFunctionsRow.current = stacked;
          event.currentTarget.setPointerCapture(event.pointerId);
          if (stacked) {
            resizeFunctionsRow(event.clientY);
          } else {
            resizeFunctionsPane(event.clientX);
          }
        }}
        onPointerMove={event => {
          if (resizingFunctionsRow.current) {
            resizeFunctionsRow(event.clientY);
          } else if (resizingFunctionsPane.current) {
            resizeFunctionsPane(event.clientX);
          }
        }}
        onPointerUp={event => {
          resizingFunctionsPane.current = false;
          resizingFunctionsRow.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          resizingFunctionsPane.current = false;
          resizingFunctionsRow.current = false;
        }}
      />
      <section className="python-profiler-call-details" aria-label={t.pythonProfilerCallDetails}>
        <header
          className={stacked ? 'is-resize-handle' : undefined}
          title={stacked ? t.pythonProfilerResizeHint : undefined}
          onPointerDown={beginRowResize}
          onPointerMove={moveRowResize}
          onPointerUp={endRowResize}
          onPointerCancel={endRowResize}
        >
          <h2>{t.pythonProfilerCallDetails}</h2>
        </header>
        {selectedFunction ? (
          <div className="python-profiler-call-content">
            <div className="python-profiler-selected-function">
              <span className="codicon codicon-symbol-function" />
              <div>
                <strong>{selectedFunction.name}</strong>
                <small title={formatLocation(selectedFunction)}>{formatLocation(selectedFunction)}</small>
                <small title={formatContext(selectedFunction, t)}>{formatContext(selectedFunction, t)}</small>
              </div>
              <button
                type="button"
                className="python-profiler-open-function"
                title={t.pythonProfilerOpenFunction}
                aria-label={t.pythonProfilerOpenFunction}
                onClick={() => openFunction(selectedFunction)}
              >
                <span className="codicon codicon-go-to-file" />
              </button>
            </div>
            <CallSection
              label={t.pythonProfilerCallers}
              relationships={relationships.callers}
              empty={t.pythonProfilerNoCalls}
              t={t}
              clock={result.clock}
              onSelect={setSelectedFunctionId}
              onOpen={openFunction}
            />
            <CallSection
              label={t.pythonProfilerCallees}
              relationships={relationships.callees}
              empty={t.pythonProfilerNoCalls}
              t={t}
              clock={result.clock}
              onSelect={setSelectedFunctionId}
              onOpen={openFunction}
            />
          </div>
        ) : (
          <div className="python-profiler-detail-empty">{t.pythonProfilerSelectFunction}</div>
        )}
      </section>
    </div>
  );
});

function ControlGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [tipStyle, setTipStyle] = useState<CSSProperties>();
  // 气泡挂到 body 上做固定定位，避免被工具条的 overflow 裁掉；上下按视口剩余空间自动翻转
  const showTip = () => {
    if (!hint) {
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const maxWidth = Math.min(340, Math.max(180, window.innerWidth - 24));
    const left = Math.min(Math.max(8, rect.left - 10), Math.max(8, window.innerWidth - maxWidth - 8));
    const assumedHeight = 120;
    const placeAbove = rect.bottom + 8 + assumedHeight > window.innerHeight - 8 && rect.top > assumedHeight;
    setTipStyle(placeAbove
      ? { left, top: Math.max(8, rect.top - 8), maxWidth, transform: 'translateY(-100%)' }
      : { left, top: rect.bottom + 8, maxWidth });
  };
  const hideTip = () => setTipStyle(undefined);
  return (
    <div className="python-profiler-control-group">
      <span>
        {label}
        {hint && (
          <span
            ref={anchorRef}
            className="python-profiler-hint"
            role="img"
            aria-label={hint}
            tabIndex={0}
            onMouseEnter={showTip}
            onMouseLeave={hideTip}
            onFocus={showTip}
            onBlur={hideTip}
          >
            <span className="codicon codicon-question" aria-hidden="true" />
          </span>
        )}
      </span>
      {children}
      {hint && tipStyle
        ? createPortal(
          <span className="python-profiler-hint-tip" role="tooltip" style={tipStyle}>
            {hint}
          </span>,
          document.body
        )
        : null}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: [string, string][];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return (
    <div className="debug-segmented">
      {options.map(([option, label]) => (
        <button
          type="button"
          className={value === option ? 'active' : ''}
          aria-pressed={value === option}
          disabled={disabled}
          key={option}
          onClick={() => onChange(option)}
        >{label}</button>
      ))}
    </div>
  );
}

interface Relationship {
  function: PythonProfilerFunction;
  call: PythonProfilerCall;
}

function CallSection({
  label,
  relationships,
  empty,
  t,
  clock,
  onSelect,
  onOpen,
}: {
  label: string;
  relationships: Relationship[];
  empty: string;
  t: I18nText;
  clock: PythonProfilerClock;
  onSelect(functionId: number): void;
  onOpen(item: PythonProfilerFunction): void;
}) {
  return (
    <div className="python-profiler-call-section">
      <h3>{label}</h3>
      {relationships.length === 0 ? <p>{empty}</p> : relationships.map(relationship => (
        <button
          type="button"
          className="python-profiler-call-row"
          key={`${relationship.call.callerId}:${relationship.call.calleeId}`}
          onClick={() => onSelect(relationship.function.id)}
          onDoubleClick={() => onOpen(relationship.function)}
        >
          <span title={`${relationship.function.name} · ${formatContext(relationship.function, t)}`}>
            {relationship.function.name} · {formatContext(relationship.function, t)}
          </span>
          <small>{relationship.call.calls} ×</small>
          <time>{formatProfileTime(relationship.call.totalTime, relationship.call.calls, clock, t)}</time>
        </button>
      ))}
    </div>
  );
}

function getRelationships(
  selected: PythonProfilerFunction | undefined,
  functions: PythonProfilerFunction[],
  calls: PythonProfilerCall[]
): { callers: Relationship[]; callees: Relationship[] } {
  if (!selected) {
    return { callers: [], callees: [] };
  }
  const byId = new Map(functions.map(item => [item.id, item]));
  const callers: Relationship[] = [];
  const callees: Relationship[] = [];
  for (const call of calls) {
    if (call.calleeId === selected.id) {
      const fn = byId.get(call.callerId);
      if (fn) callers.push({ function: fn, call });
    }
    if (call.callerId === selected.id) {
      const fn = byId.get(call.calleeId);
      if (fn) callees.push({ function: fn, call });
    }
  }
  callers.sort((left, right) => right.call.totalTime - left.call.totalTime);
  callees.sort((left, right) => right.call.totalTime - left.call.totalTime);
  return { callers, callees };
}

function getStatusLabel(state: PythonProfilerTargetState | undefined, t: I18nText): string {
  if (state?.status === 'running') return t.pythonProfilerRunning;
  if (state?.status === 'collecting') return t.pythonProfilerCollecting;
  return state?.completed ? t.hostBridgeResult : t.pythonProfilerIdle;
}

function adjustDuration(value: string, delta: number): string {
  const parsed = Number(value);
  const next = Math.max(0.001, (Number.isFinite(parsed) ? parsed : 10) + delta);
  return Number(next.toFixed(3)).toString();
}

function getElapsed(state: PythonProfilerTargetState | undefined): number | undefined {
  if (state?.status !== 'running' || !state.startedAt) return undefined;
  const startedAt = Date.parse(state.startedAt);
  return Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : undefined;
}

function formatTime(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(3)} s`;
  if (seconds >= 0.001) return `${(seconds * 1000).toFixed(2)} ms`;
  if (seconds > 0 && seconds < 0.000001) return '<1µs';
  return `${(seconds * 1_000_000).toFixed(0)} µs`;
}

function formatProfileTime(seconds: number, calls: number, clock: PythonProfilerClock, t: I18nText): string {
  return clock === 'CPU' && calls > 0 && seconds <= 0
    ? t.pythonProfilerBelowResolution
    : formatTime(seconds);
}

/** 函数归属的 mod：优先用宿主回传的 mod，其次按模块路径首段兜底（与宿主同一规则） */
function profilerModName(item: PythonProfilerFunction): string {
  if (item.isProject === false) {
    return '';
  }
  const declared = (item.mod ?? '').trim();
  const raw = declared || ((item.module ?? '').replace(/\\/g, '/').split('/').filter(Boolean)[0] ?? '');
  if (!raw || /^[a-zA-Z]:$/.test(raw)) {
    return '';
  }
  // 与宿主同一规则：只保留 mod 根目录名（去掉 client/common 之类子目录后缀）
  const root = raw.split(/[./]/)[0].trim();
  return root || raw;
}

function formatLocation(item: PythonProfilerFunction): string {
  return item.line > 0 ? `${item.module}:${item.line}` : item.module;
}

function formatContext(item: PythonProfilerFunction, t: I18nText): string {
  const side = item.target === 'client' ? t.hostBridgeClient : t.hostBridgeServer;
  return `${side} · ${item.contextName || 'Thread'} #${item.contextId}`;
}

function timeBarStyle(item: PythonProfilerFunction, maximum: number): CSSProperties {
  const denominator = maximum > 0 ? maximum : 1;
  return {
    '--python-profile-total': `${Math.max(0, Math.min(100, item.totalTime / denominator * 100))}%`,
    '--python-profile-self': `${Math.max(0, Math.min(100, item.selfTime / denominator * 100))}%`,
  } as CSSProperties;
}

function formatHistoryTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  const date = new Date(parsed);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function historyLabel(entry: PythonProfilerHistoryEntry | undefined): string {
  if (!entry) {
    return '—';
  }
  return `${formatHistoryTime(entry.capturedAt)} · ${entry.target}/${entry.clock} · ${formatTime(entry.elapsedSeconds)}`;
}

function historyTopFunction(entry: PythonProfilerHistoryEntry): string {
  const top = entry.top;
  return top ? `${top.module}:${top.line} ${top.name}` : '';
}

/** 报告绝对路径太长，提示里只显示 .mcdev 之后的部分 */
function shortenPath(full: string): string {
  const index = full.lastIndexOf('.mcdev');
  if (index >= 0) {
    return full.slice(index).replace(/\\/g, '/');
  }
  const slash = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  return slash >= 0 ? full.slice(slash + 1) : full;
}

function isTarget(value: unknown): value is PythonProfilerTarget {
  return value === 'client' || value === 'server' || value === 'all';
}

