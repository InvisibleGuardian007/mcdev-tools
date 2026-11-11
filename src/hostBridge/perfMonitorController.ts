import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessMetricsSampler, resolveNativeBinDirectory } from '../native/processMetrics';
import { HostBridgeManager } from './manager';
import {
    emptyPerfMonitorStats,
    PerfMonitorSample,
    PerfMonitorSeries,
    PerfMonitorStats
} from './perfMonitor';
import {
    getRememberedPerfSeries,
    PerfRecordPayload,
    rememberPerfSeries,
    savePerfRecord,
    savePerfReport
} from './perfMonitorRecords';
import { HostBridgeSnapshot } from './types';
import { copyToClipboard } from '../utils/clipboard';

export const PERF_MONITOR_DEFAULT_INTERVAL_MS = 1_000;
export const PERF_MONITOR_MIN_INTERVAL_MS = 500;
export const PERF_MONITOR_MAX_INTERVAL_MS = 10_000;

const FPS_TIMEOUT_MS = 3_000;
const FPS_RETRY_MS = 10_000;
const PID_DISCOVERY_TTL_MS = 5_000;
const GAME_PROCESS_NAME = 'Minecraft.Windows.exe';
/** 采样过程中每隔一段时间把记录覆盖写入工作区，避免面板切走后数据只剩在内存里。 */
const PERF_AUTOSAVE_MS = 30_000;

/**
 * Client side snippet used to read the frame rate. The documented entry point is
 * `clientApi.GetEngineCompFactory().CreateGame(levelId).GetFps()`; older builds only
 * expose a module level helper, so the snippet tries the component first and falls
 * back to the flat names. The monitor keeps working when nothing answers.
 */
const FPS_PROBE_CODE = [
    '_r=[None,None]',
    'try:',
    ' import mod.client.extraClientApi as _c',
    'except Exception:',
    ' _c=None',
    'if _c is not None:',
    ' try:',
    '  _factory=_c.GetEngineCompFactory()',
    ' except Exception:',
    '  _factory=None',
    ' if _factory is not None:',
    '  try:',
    '   _level=_c.GetLevelId()',
    '  except Exception:',
    '   _level=\'\'',
    "  for _lv in (_level,''):",
    '   try:',
    '    _comp=_factory.CreateGame(_lv)',
    '   except Exception:',
    '    continue',
    "   _get=getattr(_comp,'GetFps',None)",
    '   if not callable(_get):',
    '    continue',
    '   try:',
    '    _v=_get()',
    '   except Exception:',
    '    continue',
    '   if isinstance(_v,(int,float)) and not isinstance(_v,bool) and _v>0:',
    "    _r=['GameComponentClient.GetFps',float(_v)]",
    '    break',
    ' if _r[0] is None:',
    "  for _n in ('GetFps','GetFrameRate','GetCurrentFps'):",
    '   _get=getattr(_c,_n,None)',
    '   if not callable(_get):',
    '    continue',
    '   try:',
    '    _v=_get()',
    '   except Exception:',
    '    continue',
    '   if isinstance(_v,(int,float)) and not isinstance(_v,bool) and _v>0:',
    '    _r=[_n,float(_v)]',
    '    break',
    '_result=_r'
].join('\n');

export interface PerfMonitorState {
    status: 'idle' | 'running';
    intervalMs: number;
    startedAt?: string;
    pid?: number;
    pidSource?: 'session' | 'discovered';
    fpsAvailable: boolean;
    fpsSource?: string;
    fpsError?: string;
    lastError?: string;
    sampleCount: number;
    stats: PerfMonitorStats;
    samples: PerfMonitorSample[];
    lastUpdated?: string;
}

interface PerfMonitorRuntime {
    key: string;
    sessionId: string;
    connectionGeneration: number;
    intervalMs: number;
    series: PerfMonitorSeries;
    startedAt: number;
    pid?: number;
    pidSource?: 'session' | 'discovered';
    fpsAvailable: boolean;
    fpsSource?: string;
    fpsError?: string;
    fpsRetryAt: number;
    lastError?: string;
    previousCpuSeconds?: number;
    previousCpuAt?: number;
    timer?: NodeJS.Timeout;
    tickBusy: boolean;
    stopped: boolean;
    lastUpdated?: number;
    /** 上次自动保存到磁盘的时间，用于节流。 */
    lastPersistAt?: number;
}

interface FpsReading {
    source: string;
    value: number;
}

function runtimeKey(sessionId: string, connectionGeneration: number): string {
    return `${sessionId}:${connectionGeneration}`;
}

function boundedString(value: unknown, limit: number): string {
    return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : '';
}

function clampInterval(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return PERF_MONITOR_DEFAULT_INTERVAL_MS;
    }
    return Math.min(PERF_MONITOR_MAX_INTERVAL_MS, Math.max(PERF_MONITOR_MIN_INTERVAL_MS, Math.round(numeric)));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out while contacting the game')), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export function parseFpsProbeResult(result: unknown): FpsReading | undefined {
    if (!Array.isArray(result) || result.length < 2) {
        return undefined;
    }
    const source = result[0];
    const raw = result[1];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (typeof source !== 'string' || source.length === 0 || !Number.isFinite(value)) {
        return undefined;
    }
    return { source, value };
}

/** Reads the PID column of `tasklist /FO CSV` output for the Bedrock client. */
export function parseTasklistPid(output: string, processName = GAME_PROCESS_NAME): number | undefined {
    const wanted = processName.toLowerCase();
    for (const line of output.split(/\r?\n/)) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (!match) {
            continue;
        }
        if (match[1].toLowerCase() !== wanted) {
            continue;
        }
        const pid = Number(match[2]);
        if (Number.isInteger(pid) && pid > 0) {
            return pid;
        }
    }
    return undefined;
}

export class PerfMonitorController implements vscode.Disposable {
    private readonly runtimes = new Map<string, PerfMonitorRuntime>();
    private readonly activeWebviews = new Set<vscode.Webview>();
    private sampler?: ProcessMetricsSampler;
    private samplerPromise?: Promise<ProcessMetricsSampler | undefined>;
    private samplerError?: string;
    private discoveredPid?: { pid: number; at: number };
    private disposed = false;
    private disposePromise?: Promise<void>;

    constructor(
        private readonly extensionRoot: string,
        private readonly hostBridgeManager: HostBridgeManager
    ) {}

    public async handleMessage(webview: vscode.Webview, message: any): Promise<void> {
        if (typeof message?.type !== 'string' || !message.type.startsWith('perfMonitor')) {
            return;
        }
        if (this.disposed) {
            return;
        }
        try {
            await this.handleActiveMessage(webview, message);
        } catch (error) {
            const requestId = boundedString(message.requestId, 128);
            const sessionId = boundedString(message.sessionId, 128);
            const connectionGeneration = Number.isInteger(message.connectionGeneration)
                ? Number(message.connectionGeneration)
                : -1;
            await webview
                .postMessage({
                    type: 'perfMonitorError',
                    requestId,
                    sessionId,
                    connectionGeneration,
                    message: errorMessage(error)
                })
                .then(undefined, () => undefined);
        }
    }

    private async handleActiveMessage(webview: vscode.Webview, message: any): Promise<void> {
        if (message.type === 'perfMonitorActivate') {
            this.activeWebviews.add(webview);
            const sessionId = boundedString(message.sessionId, 128);
            const connectionGeneration = Number.isInteger(message.connectionGeneration)
                ? Number(message.connectionGeneration)
                : -1;
            if (sessionId && connectionGeneration >= 0) {
                await this.postState(webview, boundedString(message.requestId, 128), sessionId, connectionGeneration);
            }
            return;
        }
        if (message.type === 'perfMonitorDeactivate') {
            this.activeWebviews.delete(webview);
            return;
        }

        const requestId = boundedString(message.requestId, 128);
        const sessionId = boundedString(message.sessionId, 128);
        const connectionGeneration = Number.isInteger(message.connectionGeneration)
            ? Number(message.connectionGeneration)
            : -1;
        if (!requestId || !sessionId || connectionGeneration < 0) {
            return;
        }

        switch (message.type) {
            case 'perfMonitorState':
                await this.postState(webview, requestId, sessionId, connectionGeneration);
                return;
            case 'perfMonitorStart':
                await this.start(webview, sessionId, connectionGeneration, clampInterval(message.intervalMs));
                await this.postState(webview, requestId, sessionId, connectionGeneration);
                return;
            case 'perfMonitorStop':
                await this.stop(runtimeKey(sessionId, connectionGeneration));
                await this.postState(webview, requestId, sessionId, connectionGeneration);
                return;
            case 'perfMonitorReset': {
                const runtime = this.runtimes.get(runtimeKey(sessionId, connectionGeneration));
                runtime?.series.reset();
                if (runtime) {
                    runtime.previousCpuSeconds = undefined;
                    runtime.previousCpuAt = undefined;
                    runtime.lastUpdated = undefined;
                }
                await this.postState(webview, requestId, sessionId, connectionGeneration);
                return;
            }
            case 'perfMonitorExport':
                await this.export(webview, requestId, sessionId, connectionGeneration, message.format);
                return;
            case 'perfMonitorSave':
                await this.saveRecord(webview, requestId, sessionId, connectionGeneration);
                return;
            case 'perfMonitorAnalyze':
                await this.analyze(webview, requestId, sessionId, connectionGeneration);
                return;
            default:
                return;
        }
    }

    public reconcile(snapshot: HostBridgeSnapshot): void {
        for (const runtime of Array.from(this.runtimes.values())) {
            const session = snapshot.sessions.find(item => item.id === runtime.sessionId);
            if (
                !session
                || session.connectionGeneration !== runtime.connectionGeneration
                || !session.connected
                || session.state === 'exited'
                || session.state === 'exiting'
            ) {
                void this.stop(runtime.key, 'the game session is gone', true);
                continue;
            }
            if (runtime.stopped) {
                continue;
            }
            const sessionPid = session.minecraftPid;
            if (typeof sessionPid === 'number' && sessionPid > 0 && sessionPid !== runtime.pid) {
                runtime.pid = sessionPid;
                runtime.pidSource = 'session';
                runtime.previousCpuSeconds = undefined;
                runtime.previousCpuAt = undefined;
            }
        }
    }

    private async start(
        webview: vscode.Webview,
        sessionId: string,
        connectionGeneration: number,
        intervalMs: number
    ): Promise<void> {
        const session = this.hostBridgeManager
            .getSnapshot()
            .sessions.find(item => item.id === sessionId);
        if (!session) {
            throw new Error('The game session is no longer available');
        }
        if (session.connectionGeneration !== connectionGeneration) {
            throw new Error('The game session has been reconnected, please refresh the panel');
        }
        if (!session.connected) {
            throw new Error('The game session is not connected');
        }

        const sampler = await this.ensureSampler();
        if (!sampler) {
            throw new Error(this.samplerError ?? 'Unable to load the native process counters');
        }

        const pid = await this.resolvePid(session.minecraftPid);
        if (!pid) {
            throw new Error(`Unable to find a running ${GAME_PROCESS_NAME} process`);
        }

        const key = runtimeKey(sessionId, connectionGeneration);
        const previous = this.runtimes.get(key);
        if (previous) {
            this.stopRuntime(previous);
        }

        // 先沿用当前 runtime 的环形缓冲，其次复用记住的历史记录，这样切走页签、
        // 关掉面板再打开都能接着看、接着记，不会从空白开始。
        const series = previous?.series ?? getRememberedPerfSeries(key) ?? new PerfMonitorSeries();
        rememberPerfSeries(key, series);
        const runtime: PerfMonitorRuntime = {
            key,
            sessionId,
            connectionGeneration,
            intervalMs,
            series,
            startedAt: Date.now(),
            lastPersistAt: Date.now(),
            pid,
            pidSource: pid === session.minecraftPid ? 'session' : 'discovered',
            fpsAvailable: false,
            fpsRetryAt: 0,
            tickBusy: false,
            stopped: false
        };
        this.runtimes.set(key, runtime);
        this.activeWebviews.add(webview);
        this.scheduleTick(runtime, 0);
    }

    /**
     * Stops the sampler but keeps the recorded series so the panel can still
     * show the last window and export it. A stopped runtime is replaced by the
     * next start, which continues the same series.
     */
    private async stop(key: string, reason?: string, discard = false): Promise<void> {
        const runtime = this.runtimes.get(key);
        if (!runtime) {
            return;
        }
        if (runtime.stopped) {
            if (discard) {
                this.runtimes.delete(key);
            }
            return;
        }
        this.stopRuntime(runtime, reason === 'stopped' ? undefined : reason);
        await this.persistRuntime(runtime, true);
        const state = this.buildState(runtime);
        if (discard) {
            this.runtimes.delete(key);
        }
        await this.broadcast(runtime, {
            type: 'perfMonitorStopped',
            sessionId: runtime.sessionId,
            connectionGeneration: runtime.connectionGeneration,
            reason: reason ?? 'stopped',
            state
        });
    }

    private stopRuntime(runtime: PerfMonitorRuntime, reason?: string): void {
        runtime.stopped = true;
        if (runtime.timer) {
            clearTimeout(runtime.timer);
            runtime.timer = undefined;
        }
        runtime.lastError = reason;
    }

    private scheduleTick(runtime: PerfMonitorRuntime, delayMs: number): void {
        if (runtime.stopped || this.disposed) {
            return;
        }
        runtime.timer = setTimeout(() => {
            runtime.timer = undefined;
            void this.tick(runtime);
        }, Math.max(0, delayMs));
    }

    private async tick(runtime: PerfMonitorRuntime): Promise<void> {
        if (runtime.stopped || this.disposed || runtime.tickBusy) {
            return;
        }
        runtime.tickBusy = true;
        const startedAt = Date.now();
        try {
            const sampler = this.sampler;
            const reading = runtime.pid && sampler ? sampler.read(runtime.pid) : undefined;
            if (runtime.pid && !reading) {
                // The process disappeared; try to pick the new client up before giving up.
                const rediscovered = await this.resolvePid(undefined, true);
                if (rediscovered) {
                    runtime.pid = rediscovered;
                    runtime.pidSource = 'discovered';
                    runtime.previousCpuSeconds = undefined;
                    runtime.previousCpuAt = undefined;
                }
            }

            const cpuPercent = this.computeCpuPercent(runtime, reading?.cpuSeconds, startedAt);
            const fps = await this.pollFps(runtime);
            if (runtime.stopped) {
                return;
            }

            const hasReading = Boolean(reading);
            if (hasReading || typeof fps === 'number') {
                runtime.series.push({
                    time: startedAt,
                    fps,
                    cpuPercent: cpuPercent ?? 0,
                    workingSetBytes: reading?.workingSetBytes ?? 0,
                    pagefileBytes: reading?.pagefileBytes ?? 0
                });
                runtime.lastUpdated = startedAt;
            }

            if (!runtime.lastPersistAt || startedAt - runtime.lastPersistAt >= PERF_AUTOSAVE_MS) {
                runtime.lastPersistAt = startedAt;
                void this.persistRuntime(runtime, true);
            }

            const state = this.buildState(runtime);
            await this.broadcast(runtime, {
                type: 'perfMonitorSamples',
                sessionId: runtime.sessionId,
                connectionGeneration: runtime.connectionGeneration,
                samples: runtime.series.size > 0 ? [runtime.series.samples()[runtime.series.size - 1]] : [],
                stats: state.stats,
                sampleCount: state.sampleCount,
                fpsAvailable: state.fpsAvailable,
                fpsSource: state.fpsSource,
                fpsError: state.fpsError,
                pid: state.pid,
                pidSource: state.pidSource,
                lastUpdated: state.lastUpdated
            });
        } catch (error) {
            runtime.lastError = errorMessage(error);
            await this.broadcast(runtime, {
                type: 'perfMonitorSamples',
                sessionId: runtime.sessionId,
                connectionGeneration: runtime.connectionGeneration,
                samples: [],
                stats: this.buildState(runtime).stats,
                sampleCount: runtime.series.size,
                fpsAvailable: runtime.fpsAvailable,
                error: runtime.lastError
            }).catch(() => undefined);
        } finally {
            runtime.tickBusy = false;
            const elapsed = Date.now() - startedAt;
            this.scheduleTick(runtime, runtime.intervalMs - elapsed);
        }
    }

    private computeCpuPercent(
        runtime: PerfMonitorRuntime,
        cpuSeconds: number | undefined,
        now: number
    ): number | undefined {
        if (typeof cpuSeconds !== 'number') {
            return undefined;
        }
        const previousSeconds = runtime.previousCpuSeconds;
        const previousAt = runtime.previousCpuAt;
        runtime.previousCpuSeconds = cpuSeconds;
        runtime.previousCpuAt = now;
        if (previousSeconds === undefined || previousAt === undefined) {
            return undefined;
        }
        const elapsedSeconds = (now - previousAt) / 1000;
        if (elapsedSeconds <= 0) {
            return undefined;
        }
        const percent = ((cpuSeconds - previousSeconds) / elapsedSeconds) * 100;
        return Number.isFinite(percent) && percent >= 0 ? percent : undefined;
    }

    private async pollFps(runtime: PerfMonitorRuntime): Promise<number | undefined> {
        if (Date.now() < runtime.fpsRetryAt) {
            return undefined;
        }
        try {
            const result = await withTimeout(
                this.hostBridgeManager.executeCode(runtime.sessionId, FPS_PROBE_CODE, true),
                FPS_TIMEOUT_MS
            );
            const reading = parseFpsProbeResult(result);
            if (!reading) {
                runtime.fpsAvailable = false;
                runtime.fpsError = 'the game did not report a frame rate';
                runtime.fpsRetryAt = Date.now() + FPS_RETRY_MS;
                return undefined;
            }
            runtime.fpsAvailable = true;
            runtime.fpsSource = reading.source;
            runtime.fpsError = undefined;
            runtime.fpsRetryAt = 0;
            return reading.value;
        } catch (error) {
            runtime.fpsAvailable = false;
            runtime.fpsError = errorMessage(error);
            runtime.fpsRetryAt = Date.now() + FPS_RETRY_MS;
            return undefined;
        }
    }

    private async ensureSampler(): Promise<ProcessMetricsSampler | undefined> {
        if (this.sampler) {
            return this.sampler;
        }
        if (process.platform !== 'win32' || process.arch !== 'x64') {
            this.samplerError = 'The performance monitor currently supports Windows x64 only';
            return undefined;
        }
        if (!this.samplerPromise) {
            this.samplerPromise = ProcessMetricsSampler.create(resolveNativeBinDirectory(this.extensionRoot))
                .then(sampler => {
                    if (this.disposed) {
                        sampler.dispose();
                        return undefined;
                    }
                    this.sampler = sampler;
                    this.samplerError = undefined;
                    return sampler;
                })
                .catch(error => {
                    this.samplerError = `Unable to load the native process counters: ${errorMessage(error)}`;
                    this.samplerPromise = undefined;
                    return undefined;
                });
        }
        return this.samplerPromise;
    }

    private async resolvePid(
        sessionPid: number | undefined,
        forceDiscovery = false
    ): Promise<number | undefined> {
        if (!forceDiscovery && typeof sessionPid === 'number' && sessionPid > 0) {
            return sessionPid;
        }
        const cached = this.discoveredPid;
        if (cached && Date.now() - cached.at < PID_DISCOVERY_TTL_MS) {
            return cached.pid;
        }
        const output = await new Promise<string>(resolve => {
            execFile(
                'tasklist',
                ['/FI', `IMAGENAME eq ${GAME_PROCESS_NAME}`, '/FO', 'CSV', '/NH'],
                { windowsHide: true, timeout: 4_000, maxBuffer: 256 * 1024 },
                (error, stdout) => resolve(error ? '' : String(stdout))
            );
        });
        const pid = parseTasklistPid(output);
        if (pid) {
            this.discoveredPid = { pid, at: Date.now() };
            return pid;
        }
        return typeof sessionPid === 'number' && sessionPid > 0 ? sessionPid : undefined;
    }

    private buildState(runtime: PerfMonitorRuntime | undefined): PerfMonitorState {
        if (!runtime || runtime.stopped) {
            return {
                status: 'idle',
                intervalMs: runtime?.intervalMs ?? PERF_MONITOR_DEFAULT_INTERVAL_MS,
                fpsAvailable: false,
                sampleCount: runtime?.series.size ?? 0,
                stats: runtime ? runtime.series.stats() : emptyPerfMonitorStats(),
                samples: runtime ? runtime.series.samples() : [],
                lastError: runtime?.lastError
            };
        }
        return {
            status: 'running',
            intervalMs: runtime.intervalMs,
            startedAt: new Date(runtime.startedAt).toISOString(),
            pid: runtime.pid,
            pidSource: runtime.pidSource,
            fpsAvailable: runtime.fpsAvailable,
            fpsSource: runtime.fpsSource,
            fpsError: runtime.fpsError,
            lastError: runtime.lastError,
            sampleCount: runtime.series.size,
            stats: runtime.series.stats(),
            samples: runtime.series.samples(),
            lastUpdated: runtime.lastUpdated ? new Date(runtime.lastUpdated).toISOString() : undefined
        };
    }

    private async postState(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number
    ): Promise<void> {
        const runtime = this.runtimes.get(runtimeKey(sessionId, connectionGeneration));
        await webview
            .postMessage({
                type: 'perfMonitorState',
                requestId,
                sessionId,
                connectionGeneration,
                state: this.resolveState(runtimeKey(sessionId, connectionGeneration)),
                // 面板重新挂载时把「这份记录是从哪来的」也告诉前端，便于显示提示
                retained: !runtime && (this.rememberedSize(runtimeKey(sessionId, connectionGeneration)) > 0)
            })
            .then(undefined, () => undefined);
    }

    /**
     * 有运行时用运行时状态；没有运行时（面板刚重开、runtime 已丢弃）就从记住的历史记录里重建，
     * 这样切走页签再回来不会看到空白图表。
     */
    private resolveState(key: string): PerfMonitorState {
        const runtime = this.runtimes.get(key);
        if (runtime) {
            return this.buildState(runtime);
        }
        const series = getRememberedPerfSeries(key);
        if (!series || series.size === 0) {
            return this.buildState(undefined);
        }
        return this.buildStateFromSeries(series);
    }

    private rememberedSize(key: string): number {
        return getRememberedPerfSeries(key)?.size ?? 0;
    }

    private buildStateFromSeries(series: PerfMonitorSeries): PerfMonitorState {
        const samples = series.samples();
        return {
            status: 'idle',
            intervalMs: PERF_MONITOR_DEFAULT_INTERVAL_MS,
            fpsAvailable: samples.some(sample => typeof sample.fps === 'number'),
            sampleCount: samples.length,
            stats: series.stats(),
            samples
        };
    }

    private buildRecordPayload(runtime: PerfMonitorRuntime): PerfRecordPayload {
        return {
            sessionId: runtime.sessionId,
            connectionGeneration: runtime.connectionGeneration,
            pid: runtime.pid,
            intervalMs: runtime.intervalMs,
            startedAt: runtime.startedAt,
            samples: runtime.series.samples(),
            stats: runtime.series.stats()
        };
    }

    /** 把当前记录写进工作区；失败只记日志，不打断采样。 */
    private async persistRuntime(runtime: PerfMonitorRuntime, overwrite: boolean): Promise<string | undefined> {
        if (runtime.series.size === 0) {
            return undefined;
        }
        return savePerfRecord(this.buildRecordPayload(runtime), { overwrite }).catch(() => undefined);
    }

    /** 未运行（或 runtime 已被丢弃）时也能保存/分析：用记住的历史记录组装 payload。 */
    private retainedPayload(key: string, sessionId: string, connectionGeneration: number): PerfRecordPayload | undefined {
        const series = this.runtimes.get(key)?.series ?? getRememberedPerfSeries(key);
        if (!series || series.size === 0) {
            return undefined;
        }
        return {
            sessionId,
            connectionGeneration,
            intervalMs: this.runtimes.get(key)?.intervalMs ?? PERF_MONITOR_DEFAULT_INTERVAL_MS,
            startedAt: this.runtimes.get(key)?.startedAt,
            samples: series.samples(),
            stats: series.stats()
        };
    }

    private async saveRecord(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number
    ): Promise<void> {
        const key = runtimeKey(sessionId, connectionGeneration);
        const payload = this.retainedPayload(key, sessionId, connectionGeneration);
        const runtime = this.runtimes.get(key);
        const target = payload
            ? await savePerfRecord(payload, { overwrite: !runtime }).catch(() => undefined)
            : undefined;
        if (!target) {
            await webview.postMessage({
                type: 'perfMonitorSaveFailed',
                requestId,
                sessionId,
                connectionGeneration,
                message: 'There is no recorded sample to save yet'
            });
            return;
        }
        await webview.postMessage({
            type: 'perfMonitorSaved',
            requestId,
            sessionId,
            connectionGeneration,
            path: target,
            sampleCount: payload?.samples.length ?? 0
        });
    }

    /**
     * 「复制分析提问」：写一份 Markdown 报告 + 带时间戳的原始数据，
     * 然后把「追问 + 完整报告正文」放进剪贴板，用户自己粘到任意 Agent 里发送。
     */
    private async analyze(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number
    ): Promise<void> {
        const key = runtimeKey(sessionId, connectionGeneration);
        const payload = this.retainedPayload(key, sessionId, connectionGeneration);
        const result = payload ? await savePerfReport(payload).catch(() => undefined) : undefined;
        if (!result) {
            await webview.postMessage({
                type: 'perfMonitorAnalyzeFailed',
                requestId,
                sessionId,
                connectionGeneration,
                message: 'There is no recorded sample to analyse yet'
            });
            return;
        }
        const copied = await copyToClipboard(result.prompt);
        await webview.postMessage({
            type: 'perfMonitorAnalyzed',
            requestId,
            sessionId,
            connectionGeneration,
            reportPath: result.reportPath,
            recordPath: result.recordPath,
            promptCopied: copied,
            promptLength: result.prompt.length
        });
    }

    private async broadcast(runtime: PerfMonitorRuntime, payload: Record<string, unknown>): Promise<void> {
        await Promise.all(
            Array.from(this.activeWebviews).map(webview =>
                webview.postMessage(payload).then(undefined, () => undefined)
            )
        );
    }

    private async export(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number,
        format: unknown
    ): Promise<void> {
        const runtime = this.runtimes.get(runtimeKey(sessionId, connectionGeneration));
        const kind = format === 'json' ? 'json' : 'csv';
        if (!runtime || runtime.series.size === 0) {
            await webview.postMessage({
                type: 'perfMonitorExportFailed',
                requestId,
                sessionId,
                connectionGeneration,
                message: 'There is no recorded sample to export yet'
            });
            return;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = await vscode.window.showSaveDialog({
            saveLabel: 'Save performance samples',
            filters: kind === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
            defaultUri: this.defaultExportUri(`mcdev-performance-${stamp}.${kind}`)
        });
        if (!target) {
            await webview.postMessage({
                type: 'perfMonitorExportCancelled',
                requestId,
                sessionId,
                connectionGeneration
            });
            return;
        }

        const content = kind === 'csv'
            ? runtime.series.toCsv()
            : JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    sessionId,
                    pid: runtime.pid,
                    stats: runtime.series.stats(),
                    samples: runtime.series.samples()
                },
                undefined,
                2
            );
        try {
            await fs.writeFile(target.fsPath, content, 'utf8');
        } catch (error) {
            await webview.postMessage({
                type: 'perfMonitorExportFailed',
                requestId,
                sessionId,
                connectionGeneration,
                message: errorMessage(error)
            });
            return;
        }
        await webview.postMessage({
            type: 'perfMonitorExported',
            requestId,
            sessionId,
            connectionGeneration,
            path: target.fsPath,
            format: kind
        });
    }

    private defaultExportUri(fileName: string): vscode.Uri | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder ? vscode.Uri.joinPath(folder.uri, fileName) : undefined;
    }

    public dispose(): void {
        void this.disposeAsync();
    }

    public disposeAsync(): Promise<void> {
        if (!this.disposePromise) {
            this.disposePromise = this.performDispose();
        }
        return this.disposePromise;
    }

    private async performDispose(): Promise<void> {
        this.disposed = true;
        for (const runtime of Array.from(this.runtimes.values())) {
            this.stopRuntime(runtime, 'disposed');
        }
        this.runtimes.clear();
        this.activeWebviews.clear();
        await Promise.allSettled(Array.from([] as Promise<unknown>[]));
        this.sampler?.dispose();
        this.sampler = undefined;
    }
}
