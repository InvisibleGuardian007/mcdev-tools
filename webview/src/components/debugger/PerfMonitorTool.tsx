import { useEffect, useMemo, useRef, useState } from 'react';
import { I18nText } from '../../i18n';
import { HostBridgeSessionSummary, PerfMonitorSample, PerfMonitorState } from '../../types';
import { vscode } from '../../vscode';

interface PerfMonitorToolProps {
  session?: HostBridgeSessionSummary;
  t: I18nText;
  /** 独立性能窗口用：会话可用且尚未采样时自动开始监测 */
  autoStart?: boolean;
}

interface TrendChartProps {
  title: string;
  unit: string;
  color: string;
  samples: PerfMonitorSample[];
  value(sample: PerfMonitorSample): number | undefined;
  format(value: number): string;
  zeroBased?: boolean;
  emptyLabel: string;
}

const INTERVAL_OPTIONS = [500, 1000, 2000, 5000];
const MAX_RENDERED_POINTS = 640;
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 180;
const VIEW_PADDING = 6;

function createRequestId(): string {
  return `perf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatSignedMegabytes(bytes: number): string {
  const sign = bytes > 0 ? '+' : bytes < 0 ? '-' : '';
  return `${sign}${(Math.abs(bytes) / 1048576).toFixed(1)} MB`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatFps(value: number): string {
  return value.toFixed(1);
}

function formatWindow(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

interface ChartPoint {
  x: number;
  y: number;
}

function buildChartPaths(
  samples: PerfMonitorSample[],
  value: (sample: PerfMonitorSample) => number | undefined,
  zeroBased: boolean
): { line: string; area: string; max: number; min: number; points: ChartPoint[] } {
  const defined = samples
    .map(sample => value(sample))
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  if (defined.length === 0) {
    return { line: '', area: '', max: 0, min: 0, points: [] };
  }
  const rawMax = Math.max(...defined);
  const rawMin = Math.min(...defined);
  const top = rawMax <= 0 ? 1 : rawMax * 1.08;
  const bottom = zeroBased ? 0 : rawMin - (rawMax - rawMin) * 0.15 - (rawMax - rawMin === 0 ? 1 : 0);
  const span = top - bottom || 1;
  const plotHeight = VIEW_HEIGHT - VIEW_PADDING * 2;
  const step = samples.length > 1 ? VIEW_WIDTH / (samples.length - 1) : 0;

  let line = '';
  let area = '';
  let points: ChartPoint[] = [];
  let segment: ChartPoint[] = [];

  const flush = () => {
    if (segment.length === 0) {
      return;
    }
    points = points.concat(segment);
    const commands = segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
    line += commands.join(' ');
    const first = segment[0];
    const last = segment[segment.length - 1];
    area += `${commands.join(' ')} L${last.x.toFixed(2)} ${VIEW_HEIGHT - VIEW_PADDING} L${first.x.toFixed(2)} ${VIEW_HEIGHT - VIEW_PADDING} Z `;
    segment = [];
  };

  samples.forEach((sample, index) => {
    const current = value(sample);
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      flush();
      return;
    }
    const ratio = (current - bottom) / span;
    segment.push({
      x: index * step,
      y: VIEW_HEIGHT - VIEW_PADDING - Math.max(0, Math.min(1, ratio)) * plotHeight
    });
  });
  flush();

  return { line: line.trim(), area: area.trim(), max: rawMax, min: rawMin, points };
}

function TrendChart({ title, unit, color, samples, value, format, zeroBased, emptyLabel }: TrendChartProps) {
  const [hoverRatio, setHoverRatio] = useState<number | undefined>();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const rendered = useMemo(() => {
    if (samples.length <= MAX_RENDERED_POINTS) {
      return samples;
    }
    const stride = Math.ceil(samples.length / MAX_RENDERED_POINTS);
    const decimated = samples.filter((_, index) => index % stride === 0);
    const last = samples[samples.length - 1];
    if (decimated[decimated.length - 1] !== last) {
      decimated.push(last);
    }
    return decimated;
  }, [samples]);

  const chart = useMemo(
    () => buildChartPaths(rendered, value, zeroBased ?? true),
    [rendered, value, zeroBased]
  );

  const hoverIndex = hoverRatio === undefined || rendered.length === 0
    ? undefined
    : Math.min(rendered.length - 1, Math.max(0, Math.round(hoverRatio * (rendered.length - 1))));
  const hoverSample = hoverIndex === undefined ? undefined : rendered[hoverIndex];
  const hoverValue = hoverSample ? value(hoverSample) : undefined;

  return (
    <section className="perf-monitor-chart" aria-label={title}>
      <header className="perf-monitor-chart-head">
        <span className="perf-monitor-chart-title">
          <i style={{ background: color }} />
          {title}
        </span>
        <span className="perf-monitor-chart-range">
          {chart.points.length > 0
            ? `${format(chart.min)} ~ ${format(chart.max)} ${unit}`
            : emptyLabel}
        </span>
      </header>
      <div
        className="perf-monitor-chart-body"
        ref={containerRef}
        onMouseMove={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) {
            return;
          }
          setHoverRatio(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
        }}
        onMouseLeave={() => setHoverRatio(undefined)}
      >
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" role="img">
          {[0.25, 0.5, 0.75].map(ratio => (
            <line
              key={ratio}
              x1={0}
              x2={VIEW_WIDTH}
              y1={VIEW_HEIGHT * ratio}
              y2={VIEW_HEIGHT * ratio}
              className="perf-monitor-grid"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.area && <path d={chart.area} fill={color} opacity={0.16} />}
          {chart.line && (
            <path
              d={chart.line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hoverIndex !== undefined && (
            <line
              x1={(hoverIndex / Math.max(1, rendered.length - 1)) * VIEW_WIDTH}
              x2={(hoverIndex / Math.max(1, rendered.length - 1)) * VIEW_WIDTH}
              y1={0}
              y2={VIEW_HEIGHT}
              className="perf-monitor-hover-line"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {hoverSample && typeof hoverValue === 'number' && (
          <div
            className="perf-monitor-tooltip"
            style={{ left: `${((hoverIndex ?? 0) / Math.max(1, rendered.length - 1)) * 100}%` }}
          >
            <strong>
              {format(hoverValue)} {unit}
            </strong>
            <span>{new Date(hoverSample.time).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
    </section>
  );
}

export function PerfMonitorTool({ session, t, autoStart }: PerfMonitorToolProps) {
  const [state, setState] = useState<PerfMonitorState>();
  const [samples, setSamples] = useState<PerfMonitorSample[]>([]);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const autoStartedRef = useRef(false);

  const contextKey = session ? `${session.id}:${session.connectionGeneration}` : '';
  const methodAvailable = session?.methods === undefined
    || session.methods.some(method => method.name === 'game/code/execute' && method.modes.includes('request'));
  const canMonitor = Boolean(session?.connected && session.state === 'game_ready' && methodAvailable);
  const running = state?.status === 'running';
  const stats = state?.stats;
  const hasSamples = samples.length > 0;

  useEffect(() => {
    setState(undefined);
    setSamples([]);
    setPending(false);
    setError(undefined);
    setNotice(undefined);
    if (!session) {
      return;
    }
    vscode.postMessage({
      type: 'perfMonitorActivate',
      requestId: createRequestId(),
      sessionId: session.id,
      connectionGeneration: session.connectionGeneration,
    });
    return () => {
      vscode.postMessage({
        type: 'perfMonitorDeactivate',
        sessionId: session.id,
        connectionGeneration: session.connectionGeneration,
      });
    };
  }, [contextKey]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (
        !session
        || message?.sessionId !== session.id
        || message?.connectionGeneration !== session.connectionGeneration
      ) {
        return;
      }
      switch (message.type) {
        case 'perfMonitorState': {
          const next = message.state as PerfMonitorState | undefined;
          if (!next) {
            return;
          }
          setState(next);
          setSamples(next.samples ?? []);
          setIntervalMs(next.intervalMs ?? 1000);
          setPending(false);
          setError(undefined);
          if (message.retained === true) {
            setNotice(t.perfMonitorHistoryRestored);
          }
          // 独立性能窗口：首次拿到空闲状态就直接开始采样，省掉手点「开始监测」
          if (
            autoStart
            && !autoStartedRef.current
            && canMonitor
            && next.status === 'idle'
            && (next.sampleCount ?? 0) === 0
          ) {
            autoStartedRef.current = true;
            setPending(true);
            vscode.postMessage({
              type: 'perfMonitorStart',
              requestId: createRequestId(),
              sessionId: session.id,
              connectionGeneration: session.connectionGeneration,
              intervalMs: next.intervalMs ?? intervalMs,
            });
          }
          break;
        }
        case 'perfMonitorSamples': {
          const incoming = Array.isArray(message.samples) ? (message.samples as PerfMonitorSample[]) : [];
          if (incoming.length > 0) {
            setSamples(previous => {
              const next = previous.concat(incoming);
              return next.length > 7200 ? next.slice(next.length - 7200) : next;
            });
          }
          setState(previous => ({
            ...(previous ?? {
              status: 'running',
              intervalMs,
              fpsAvailable: false,
              sampleCount: 0,
              samples: [],
              stats: message.stats,
            }),
            status: 'running',
            sampleCount: typeof message.sampleCount === 'number' ? message.sampleCount : previous?.sampleCount ?? 0,
            stats: message.stats ?? previous?.stats,
            fpsAvailable: Boolean(message.fpsAvailable),
            fpsSource: message.fpsSource ?? previous?.fpsSource,
            fpsError: message.fpsError ?? previous?.fpsError,
            pid: message.pid ?? previous?.pid,
            pidSource: message.pidSource ?? previous?.pidSource,
            lastUpdated: message.lastUpdated ?? previous?.lastUpdated,
            lastError: typeof message.error === 'string' ? message.error : previous?.lastError,
          }));
          break;
        }
        case 'perfMonitorStopped': {
          const next = message.state as PerfMonitorState | undefined;
          if (next) {
            setState(next);
            setSamples(next.samples ?? []);
          }
          setPending(false);
          if (typeof message.reason === 'string' && message.reason !== 'stopped') {
            setError(message.reason);
          }
          break;
        }
        case 'perfMonitorError':
          setPending(false);
          setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
          break;
        case 'perfMonitorExported':
          setNotice(`${t.perfMonitorExported}: ${message.path}`);
          setPending(false);
          break;
        case 'perfMonitorExportFailed':
          setPending(false);
          setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
          break;
        case 'perfMonitorExportCancelled':
          setPending(false);
          break;
        case 'perfMonitorSaved':
          setPending(false);
          setNotice(`${t.perfMonitorSaved}: ${message.path}`);
          break;
        case 'perfMonitorSaveFailed':
          setPending(false);
          setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
          break;
        case 'perfMonitorAnalyzed': {
          setPending(false);
          const fallback = message.chatOpened === false ? ` ${t.perfMonitorAnalyzeFallback}` : '';
          setNotice(`${t.perfMonitorAnalyzed}: ${message.reportPath}${fallback}`);
          break;
        }
        case 'perfMonitorAnalyzeFailed':
          setPending(false);
          setError(typeof message.message === 'string' ? message.message : t.hostBridgeRequestFailed);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [
    contextKey,
    session,
    t.hostBridgeRequestFailed,
    t.perfMonitorExported,
    t.perfMonitorSaved,
    t.perfMonitorAnalyzed,
    t.perfMonitorAnalyzeFallback,
    t.perfMonitorHistoryRestored,
    intervalMs,
  ]);

  const send = (
    type:
      | 'perfMonitorStart'
      | 'perfMonitorStop'
      | 'perfMonitorReset'
      | 'perfMonitorExport'
      | 'perfMonitorSave'
      | 'perfMonitorAnalyze',
    extra?: Record<string, unknown>
  ) => {
    if (!session) {
      return;
    }
    vscode.postMessage({
      type,
      requestId: createRequestId(),
      sessionId: session.id,
      connectionGeneration: session.connectionGeneration,
      intervalMs,
      ...extra,
    });
  };

  const start = () => {
    if (!canMonitor || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    send('perfMonitorStart');
  };

  const stop = () => {
    if (pending) {
      return;
    }
    setPending(true);
    send('perfMonitorStop');
  };

  const reset = () => {
    if (pending) {
      return;
    }
    setPending(true);
    setSamples([]);
    send('perfMonitorReset');
  };

  const exportSamples = (format: 'csv' | 'json') => {
    if (!hasSamples || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    send('perfMonitorExport', { format });
  };

  const saveRecord = () => {
    if (!hasSamples || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    send('perfMonitorSave');
  };

  const analyzeWithAgent = () => {
    if (!hasSamples || pending) {
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    send('perfMonitorAnalyze');
  };

  const fpsValue = (sample: PerfMonitorSample) => sample.fps;
  const cpuValue = (sample: PerfMonitorSample) => sample.cpuPercent;
  const memoryValue = (sample: PerfMonitorSample) =>
    sample.workingSetBytes > 0 ? sample.workingSetBytes / 1048576 : undefined;

  const statusText = !canMonitor
    ? t.perfMonitorUnavailable
    : running
      ? t.perfMonitorRunning
      : t.perfMonitorIdle;

  return (
    <div className="perf-monitor-workspace">
      <div className="perf-monitor-toolbar">
        <label className="perf-monitor-interval">
          <span>{t.perfMonitorInterval}</span>
          <select
            value={intervalMs}
            disabled={running || pending}
            onChange={event => setIntervalMs(Number(event.target.value))}
          >
            {INTERVAL_OPTIONS.map(option => (
              <option key={option} value={option}>
                {option / 1000}
                {t.perfMonitorSecond}
              </option>
            ))}
          </select>
        </label>
        <div className="perf-monitor-actions">
          {running ? (
            <button type="button" className="perf-monitor-stop" disabled={pending} onClick={stop}>
              <span className="codicon codicon-debug-stop" />
              <span>{t.perfMonitorStop}</span>
            </button>
          ) : (
            <button type="button" className="perf-monitor-start" disabled={!canMonitor || pending} onClick={start}>
              <span className="codicon codicon-record" />
              <span>{t.perfMonitorStart}</span>
            </button>
          )}
          <button
            type="button"
            className="perf-monitor-secondary"
            disabled={pending || !hasSamples}
            onClick={reset}
            title={t.perfMonitorResetHint}
          >
            <span className="codicon codicon-clear-all" />
            <span>{t.perfMonitorReset}</span>
          </button>
          <button
            type="button"
            className="perf-monitor-secondary"
            disabled={pending || !hasSamples}
            onClick={() => exportSamples('csv')}
          >
            <span className="codicon codicon-export" />
            <span>{t.perfMonitorExportCsv}</span>
          </button>
          <button
            type="button"
            className="perf-monitor-secondary"
            disabled={pending || !hasSamples}
            onClick={() => exportSamples('json')}
          >
            <span className="codicon codicon-file-code" />
            <span>{t.perfMonitorExportJson}</span>
          </button>
          <button
            type="button"
            className="perf-monitor-secondary"
            disabled={pending || !hasSamples}
            onClick={saveRecord}
            title={t.perfMonitorSaveHint}
          >
            <span className="codicon codicon-save" />
            <span>{t.perfMonitorSave}</span>
          </button>
          <button
            type="button"
            className="perf-monitor-secondary perf-monitor-agent"
            disabled={pending || !hasSamples || !canMonitor}
            onClick={analyzeWithAgent}
            title={t.perfMonitorAnalyzeHint}
          >
            <span className="codicon codicon-comment-discussion" />
            <span>{t.perfMonitorAnalyze}</span>
          </button>
        </div>
      </div>

      <div className={`perf-monitor-status ${running ? 'running' : 'idle'}`}>
        <span className="perf-monitor-status-dot" />
        <strong>{statusText}</strong>
        <div className="perf-monitor-meta">
          {state?.pid !== undefined && (
            <span>
              {t.perfMonitorProcess}: {state.pid}
              {state.pidSource === 'discovered' ? ' (auto)' : ''}
            </span>
          )}
          {hasSamples && (
            <span>
              {t.perfMonitorSamples}: {samples.length}
            </span>
          )}
          {stats && stats.windowSeconds > 0 && (
            <span>
              {t.perfMonitorWindow}: {formatWindow(stats.windowSeconds)}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="perf-monitor-message error">
          <span className="codicon codicon-warning" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="perf-monitor-message notice">
          <span className="codicon codicon-check" />
          <span>{notice}</span>
        </div>
      )}
      {!error && running && state?.fpsError && (
        <div className="perf-monitor-message hint">
          <span className="codicon codicon-info" />
          <span>{t.perfMonitorFpsHint}</span>
        </div>
      )}

      <div className="perf-monitor-cards">
        <MetricCard
          title={t.perfMonitorFps}
          accent="#4ec9b0"
          primary={stats?.fps ? formatFps(stats.fps.current) : '--'}
          unit="FPS"
          rows={[
            [t.perfMonitorAverage, stats?.fps ? formatFps(stats.fps.average) : '--'],
            [t.perfMonitorLow1, stats?.fps ? formatFps(stats.fps.low1) : '--'],
            [t.perfMonitorMinimum, stats?.fps ? formatFps(stats.fps.min) : '--'],
            [t.perfMonitorMaximum, stats?.fps ? formatFps(stats.fps.max) : '--'],
          ]}
          footnote={state?.fpsSource ? `${t.perfMonitorFps}: ${state.fpsSource}` : undefined}
        />
        <MetricCard
          title={t.perfMonitorCpu}
          accent="#d7ba7d"
          primary={stats ? formatPercent(stats.cpu.current) : '--'}
          unit=""
          rows={[
            [t.perfMonitorAverage, stats ? formatPercent(stats.cpu.average) : '--'],
            [t.perfMonitorPeak, stats ? formatPercent(stats.cpu.peak) : '--'],
          ]}
          footnote={t.perfMonitorCpuHint}
        />
        <MetricCard
          title={t.perfMonitorMemory}
          accent="#569cd6"
          primary={stats ? formatMegabytes(stats.memory.current) : '--'}
          unit=""
          rows={[
            [t.perfMonitorAverage, stats ? formatMegabytes(stats.memory.average) : '--'],
            [t.perfMonitorPeak, stats ? formatMegabytes(stats.memory.peak) : '--'],
            [t.perfMonitorGrowth, stats ? formatSignedMegabytes(stats.memory.growth) : '--'],
          ]}
        />
      </div>

      <div className="perf-monitor-charts">
        <TrendChart
          title={t.perfMonitorChartFps}
          unit="FPS"
          color="#4ec9b0"
          samples={samples}
          value={fpsValue}
          format={formatFps}
          emptyLabel={t.perfMonitorFpsHint}
        />
        <TrendChart
          title={t.perfMonitorChartCpu}
          unit="%"
          color="#d7ba7d"
          samples={samples}
          value={cpuValue}
          format={formatPercent}
          emptyLabel={t.perfMonitorNoSamples}
        />
        <TrendChart
          title={t.perfMonitorChartMemory}
          unit="MB"
          color="#569cd6"
          samples={samples}
          value={memoryValue}
          format={value => value.toFixed(0)}
          zeroBased={false}
          emptyLabel={t.perfMonitorNoSamples}
        />
      </div>
    </div>
  );
}

interface MetricCardProps {
  title: string;
  accent: string;
  primary: string;
  unit: string;
  rows: [string, string][];
  footnote?: string;
}

function MetricCard({ title, accent, primary, unit, rows, footnote }: MetricCardProps) {
  return (
    <section className="perf-monitor-card" aria-label={title}>
      <header style={{ borderColor: accent }}>
        <span>{title}</span>
      </header>
      <div className="perf-monitor-card-primary" style={{ color: accent }}>
        <strong>{primary}</strong>
        {unit && <small>{unit}</small>}
      </div>
      <dl className="perf-monitor-card-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {footnote && <p className="perf-monitor-card-footnote">{footnote}</p>}
    </section>
  );
}
