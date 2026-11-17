import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { copyToClipboard } from '../utils/clipboard';
import { HostBridgeManager } from './manager';
import {
    buildPythonProfilerCleanupCode,
    buildPythonProfilerCollectCode,
    buildPythonProfilerJoinCode,
    buildPythonProfilerMarkCode,
    buildPythonProfilerStartCode,
    parsePythonProfilerJoin,
    parsePythonProfilerResult,
    parsePythonProfilerStart,
    PythonProfilerClock,
    PythonProfilerResult,
    PythonProfilerSide,
    PythonProfilerTarget
} from './pythonProfiler';
import {
    buildPythonProfilerAnalysisPrompt,
    buildPythonProfilerReportMarkdown,
    PythonProfilerClassesMode,
    PythonProfilerReportContext,
    PythonProfilerReportFiles,
    writePythonProfilerReport
} from './pythonProfilerReport';
import {
    buildPythonProfilerHistoryEntry,
    formatPythonProfilerComparison,
    PythonProfilerHistoryEntry,
    readPythonProfilerHistory,
    toHistorySummary,
    writePythonProfilerHistory
} from './pythonProfilerHistory';
import { openPythonProfilerSource } from './pythonProfilerNavigation';
import { PythonProfilerPromptContent, PythonProfilerPromptPanel } from './pythonProfilerPromptPanel';
import { HostBridgeSnapshot } from './types';

interface PythonProfilerRuntime {
    key: string;
    sessionId: string;
    connectionGeneration: number;
    target: PythonProfilerTarget;
    clock: PythonProfilerClock;
    durationSeconds?: number;
    startedAt: number;
    timer?: NodeJS.Timeout;
    collecting: boolean;
    webview: vscode.Webview;
}

interface PythonProfilerPreparedPrompt {
    prompt: string;
    markdownPath: string;
    target: PythonProfilerTarget;
    historyId: string;
}

interface PythonProfilerCompletedState {
    target: PythonProfilerTarget;
    clock: PythonProfilerClock;
    capturedAt: string;
    result: PythonProfilerResult;
    /** 采集当时的工程根目录：游戏退出、会话消失后还要靠它出报告 / 列历史 */
    projectRoot?: string;
    /** 采集当时的存档名，会话消失后报告里仍然带得上 */
    worldName?: string;
    report?: PythonProfilerReportFiles;
    reportError?: string;
    /** 采集历史里的 id，用于 A/B 对比 */
    historyId?: string;
    /** 历史落盘失败的原因（不阻断采集，但要能看见） */
    historyError?: string;
}

const MAX_TIMER_DELAY_MS = 2_000_000_000;
const GAME_TIMER_SETTLE_MS = 150;

export class PythonProfilerController implements vscode.Disposable {
    private readonly runtimes = new Map<string, PythonProfilerRuntime>();
    private readonly completed = new Map<string, PythonProfilerCompletedState>();
    /** sessionId → 工程根目录。会话随游戏退出消失后，报告和历史仍要从这里取路径 */
    private readonly projectRoots = new Map<string, string>();
    /** 兜底：最近一次见过的工程根目录（重启游戏换 sessionId 时也不至于丢历史） */
    private lastProjectRoot?: string;
    private readonly operations = new Map<string, Promise<void>>();
    private disposePromise?: Promise<void>;
    private disposed = false;

    constructor(private readonly hostBridgeManager: HostBridgeManager) {}

    public async handleMessage(webview: vscode.Webview, message: any): Promise<boolean> {
        if (typeof message?.type !== 'string' || !message.type.startsWith('pythonProfiler')) {
            return false;
        }
        if (this.disposed) {
            return true;
        }
        const requestId = boundedString(message.requestId, 128);
        // 历史相关操作允许不带会话（游戏没启动），所以这里统一成空串而不是 undefined
        const sessionId = boundedString(message.sessionId, 128) ?? '';
        const connectionGeneration = Number.isInteger(message.connectionGeneration)
            ? Number(message.connectionGeneration)
            : -1;
        // 历史相关操作不依赖活会话：游戏没启动时也要能翻历史、对历史采集出报告
        const historyId = boundedString(message.historyId, 160);
        const anonymousAllowed = message.type === 'pythonProfilerHistory'
            || message.type === 'pythonProfilerHistoryLoad'
            // 复制正文只是写剪贴板、搬正文到编辑器面板，都不需要活会话
            || message.type === 'pythonProfilerCopyPrompt'
            || ((message.type === 'pythonProfilerAnalyze' || message.type === 'pythonProfilerPreparePrompt')
                && Boolean(historyId));
        if (!requestId || (connectionGeneration < 0 && !anonymousAllowed)) {
            return true;
        }
        if (!sessionId && !anonymousAllowed) {
            return true;
        }
        const target = readTarget(message.target);
        try {
            if (message.type === 'pythonProfilerState') {
                await this.postState(webview, requestId, sessionId, connectionGeneration);
                return true;
            }
            if (!target) {
                throw new Error('Invalid Python profiler target');
            }
            const key = runtimeKey(sessionId, connectionGeneration, target);
            switch (message.type) {
                case 'pythonProfilerStart':
                    await this.runExclusive(key, () => this.start(
                        webview,
                        sessionId,
                        connectionGeneration,
                        target,
                        message.clock === 'CPU' ? 'CPU' : 'WALL',
                        readDuration(message.durationSeconds)
                    ));
                    await this.postState(webview, requestId, sessionId, connectionGeneration);
                    return true;
                case 'pythonProfilerStop':
                    await this.runExclusive(key, () => this.collect(key, webview));
                    await this.postState(webview, requestId, sessionId, connectionGeneration);
                    return true;
                case 'pythonProfilerSaveReport':
                    await this.runExclusive(key, () => this.saveReport(key, sessionId));
                    await this.postState(webview, requestId, sessionId, connectionGeneration);
                    return true;
                case 'pythonProfilerAnalyze':
                    await this.runExclusive(key, () => this.analyze(
                        key, sessionId, webview, requestId, connectionGeneration,
                        boundedString(message.mod, 256),
                        historyId || undefined,
                        readCopyLimit(message.copyLimit),
                        readClassesMode(message.classes)
                    ));
                    return true;
                case 'pythonProfilerPreparePrompt':
                    await this.runExclusive(key, () => this.preparePrompt(
                        key, sessionId, webview, requestId, connectionGeneration,
                        boundedString(message.mod, 256),
                        historyId || undefined,
                        readCopyLimit(message.copyLimit),
                        readClassesMode(message.classes)
                    ));
                    return true;
                case 'pythonProfilerCopyPrompt':
                    await this.copyPrompt(
                        webview,
                        requestId,
                        sessionId,
                        connectionGeneration,
                        target,
                        typeof message.prompt === 'string' ? message.prompt : '',
                        boundedString(message.mod, 256),
                        readCopyLimit(message.copyLimit),
                        readClassesMode(message.classes)
                    );
                    return true;
                case 'pythonProfilerOpenReport':
                    await this.openReport(key, message.kind === 'svg' ? 'svg' : 'markdown');
                    return true;
                case 'pythonProfilerRevealReport':
                    await this.revealReport(key);
                    return true;
                case 'pythonProfilerOpenFunction':
                    await this.openFunction(key, sessionId, message.functionId);
                    return true;
                case 'pythonProfilerHistory':
                    await this.postHistory(webview, requestId, sessionId, connectionGeneration, target);
                    return true;
                case 'pythonProfilerHistoryLoad':
                    await this.loadHistory(
                        webview,
                        requestId,
                        sessionId,
                        connectionGeneration,
                        target,
                        message.historyId
                    );
                    return true;
                case 'pythonProfilerCompare':
                    await this.compare(
                        webview,
                        requestId,
                        sessionId,
                        connectionGeneration,
                        target,
                        message.baseId,
                        message.headId
                    );
                    return true;
            }
        } catch (error) {
            await this.postState(
                webview, requestId, sessionId, connectionGeneration
            ).catch(() => undefined);
            await webview.postMessage({
                type: 'pythonProfilerError',
                requestId,
                sessionId,
                connectionGeneration,
                target,
                message: error instanceof Error ? error.message : String(error)
            });
        }
        return true;
    }

    public reconcile(snapshot: HostBridgeSnapshot): void {
        for (const [key, runtime] of this.runtimes) {
            const session = snapshot.sessions.find(item => item.id === runtime.sessionId);
            if (
                session?.connected
                && session.state === 'game_ready'
                && session.connectionGeneration === runtime.connectionGeneration
            ) {
                continue;
            }
            this.removeRuntime(runtime);
            if (session?.connected && session.connectionGeneration === runtime.connectionGeneration) {
                void this.runExclusive(key, async () => {
                    await this.cleanupTargets(runtime.sessionId, runtime.target);
                }).catch(() => undefined);
            }
            this.completed.delete(key);
            void runtime.webview.postMessage({
                type: 'pythonProfilerInvalidated',
                sessionId: runtime.sessionId,
                connectionGeneration: runtime.connectionGeneration,
                target: runtime.target
            });
        }
        const validPrefixes = new Set(snapshot.sessions.map(session => (
            `${session.id}:${session.connectionGeneration}:`
        )));
        for (const key of this.completed.keys()) {
            if (![...validPrefixes].some(prefix => key.startsWith(prefix))) {
                this.completed.delete(key);
            }
        }
    }

    public dispose(): void {
        void this.disposeAsync();
    }

    public disposeAsync(): Promise<void> {
        this.disposePromise ??= this.performDispose();
        return this.disposePromise;
    }

    private async start(
        webview: vscode.Webview,
        sessionId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget,
        clock: PythonProfilerClock,
        durationSeconds?: number
    ): Promise<void> {
        this.assertSession(sessionId, connectionGeneration);
        const key = runtimeKey(sessionId, connectionGeneration, target);
        const activeRuntime = [...this.runtimes.values()].find(runtime => (
            runtime.sessionId === sessionId
            && runtime.connectionGeneration === connectionGeneration
        ));
        if (activeRuntime && activeRuntime.key !== key) {
            throw new Error('Another Python profile is already active for this game session');
        }
        if (this.runtimes.has(key)) {
            throw new Error('This target is already being profiled');
        }
        // 'all' 是**一次**采样覆盖两端：先在客户端起采样（多线程 hook，进程里已存在的线程一并挂上），
        // 再让服务端线程加入同一次采样，两端共用同一个窗口，停止时一次就把两边都收上来。
        // 不再拆成先后两段 —— 那样点「停止」之后还得补采另一端，两端窗口也不一样长。
        const entry: PythonProfilerSide = target === 'all' ? 'client' : target;
        try {
            const value = await this.hostBridgeManager.executeCode(
                sessionId,
                buildPythonProfilerStartCode({
                    target: entry,
                    clock,
                    durationSeconds,
                    allSides: target === 'all'
                }),
                entry === 'client'
            );
            parsePythonProfilerStart(value);
            if (target === 'all') {
                // 服务端必须立刻加入：挂不上就在这时候报错，别让人白采几十秒才发现只有一端
                const joined = await this.hostBridgeManager.executeCode(
                    sessionId,
                    buildPythonProfilerJoinCode('server'),
                    false
                );
                parsePythonProfilerJoin(joined);
                // 客户端标记放在加入成功之后：两端各自留一条带 ctx_id 的统计，采集时据此分端
                await this.hostBridgeManager.executeCode(
                    sessionId,
                    buildPythonProfilerMarkCode('client'),
                    true
                );
            }
        } catch (error) {
            await this.cleanupTargets(sessionId, target);
            throw error;
        }
        const runtime: PythonProfilerRuntime = {
            key,
            sessionId,
            connectionGeneration,
            target,
            clock,
            durationSeconds,
            startedAt: Date.now(),
            collecting: false,
            webview
        };
        this.runtimes.set(key, runtime);
        this.completed.delete(key);
        if (durationSeconds !== undefined) {
            this.scheduleCollection(runtime);
        }
    }

    /**
     * 收采样结果。
     *
     * 脚本必须发到「起采样那一端」的线程上执行：'all' 时客户端既拥有这次采样，也持有两端
     * 的 ctx 映射，一次调用就能把 client / server 的统计一起取回来。
     */
    private async collectResult(runtime: PythonProfilerRuntime): Promise<PythonProfilerResult> {
        const value = await this.hostBridgeManager.executeCode(
            runtime.sessionId,
            buildPythonProfilerCollectCode(runtime.target),
            isClientExecution(runtime.target)
        );
        return parsePythonProfilerResult(value, runtime.target);
    }

    private scheduleCollection(runtime: PythonProfilerRuntime): void {
        if (runtime.durationSeconds === undefined || this.runtimes.get(runtime.key) !== runtime) {
            return;
        }
        const deadline = runtime.startedAt + runtime.durationSeconds * 1000 + GAME_TIMER_SETTLE_MS;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            void this.runExclusive(
                runtime.key,
                () => this.collect(runtime.key, runtime.webview)
            ).catch(error => this.postAutomaticError(runtime, error));
            return;
        }
        runtime.timer = setTimeout(
            () => this.scheduleCollection(runtime),
            Math.min(remaining, MAX_TIMER_DELAY_MS)
        );
        runtime.timer.unref?.();
    }

    private async collect(key: string, webview: vscode.Webview): Promise<void> {
        const runtime = this.runtimes.get(key);
        if (!runtime) {
            if (this.completed.has(key)) {
                return;
            }
            throw new Error('No Python profile is active for this target');
        }
        if (runtime.collecting) {
            return;
        }
        runtime.collecting = true;
        if (runtime.timer) {
            clearTimeout(runtime.timer);
            runtime.timer = undefined;
        }
        await this.postState(
            webview,
            `auto:${Date.now()}`,
            runtime.sessionId,
            runtime.connectionGeneration
        );
        try {
            this.assertSession(runtime.sessionId, runtime.connectionGeneration);
            let result: PythonProfilerResult;
            try {
                // 'all' 也只有这一次采集：两端都在同一次采样里，收一次就齐了
                result = await this.collectResult(runtime);
            } catch (error) {
                await this.cleanupTargets(runtime.sessionId, runtime.target);
                throw error;
            }
            const capturedAt = new Date();
            const liveSession = this.hostBridgeManager.getSnapshot().sessions
                .find(item => item.id === runtime.sessionId);
            const state: PythonProfilerCompletedState = {
                target: runtime.target,
                clock: runtime.clock,
                capturedAt: capturedAt.toISOString(),
                result,
                // 采集当时就把工程路径记下来：游戏退出后还要出报告、列历史
                projectRoot: this.resolveProjectRoot(runtime.sessionId),
                worldName: liveSession?.worldName || liveSession?.worldFolderName
            };
            this.completed.set(key, state);
            // 每次采集都落一份历史摘要，否则「采集历史 / 对比」无从下手
            await this.recordHistory(runtime, state, capturedAt).catch(error => {
                state.historyError = error instanceof Error ? error.message : String(error);
            });
            // 采集一结束就把报告（md + svg）写进工作区，不必再手动点「保存报告」
            await this.saveReport(key, runtime.sessionId).catch(error => {
                state.reportError = error instanceof Error ? error.message : String(error);
            });
            await webview.postMessage({
                type: 'pythonProfilerResult',
                sessionId: runtime.sessionId,
                connectionGeneration: runtime.connectionGeneration,
                target: runtime.target,
                state: this.completed.get(key)
            });
        } finally {
            this.removeRuntime(runtime);
        }
    }

    private async recordHistory(
        runtime: PythonProfilerRuntime,
        state: PythonProfilerCompletedState,
        capturedAt: Date
    ): Promise<void> {
        const projectRoot = state.projectRoot ?? this.resolveProjectRoot(runtime.sessionId);
        if (!projectRoot) {
            return;
        }
        const entry = buildPythonProfilerHistoryEntry({
            projectRoot,
            target: state.target,
            clock: state.clock,
            worldName: state.worldName,
            capturedAt
        }, state.result);
        state.historyId = await writePythonProfilerHistory(projectRoot, entry);
    }

    private async readHistory(sessionId: string): Promise<PythonProfilerHistoryEntry[]> {
        const projectRoot = this.resolveProjectRoot(sessionId);
        if (!projectRoot) {
            return [];
        }
        return readPythonProfilerHistory(projectRoot);
    }

    private async postHistory(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget
    ): Promise<void> {
        const key = runtimeKey(sessionId, connectionGeneration, target);
        const entries = await this.readHistory(sessionId);
        await webview.postMessage({
            type: 'pythonProfilerHistory',
            requestId,
            sessionId,
            connectionGeneration,
            target,
            entries: entries.map(toHistorySummary),
            currentId: this.completed.get(key)?.historyId
        });
    }

    /** 回看某一次历史采集：只读，把落盘的函数明细回给前端 */
    private async loadHistory(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget,
        rawHistoryId: unknown
    ): Promise<void> {
        const historyId = boundedString(rawHistoryId, 160);
        if (!historyId) {
            throw new Error('Select a capture to review');
        }
        const entries = await this.readHistory(sessionId);
        const entry = entries.find(item => item.id === historyId);
        if (!entry) {
            throw new Error('The selected capture is no longer available');
        }
        await webview.postMessage({
            type: 'pythonProfilerHistoryLoaded',
            requestId,
            sessionId,
            connectionGeneration,
            target,
            entry
        });
    }

    /** 「对比并复制」：把两次采集压成一段极简摘要，直接进剪贴板交给 Agent */
    private async compare(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget,
        rawBaseId: unknown,
        rawHeadId: unknown
    ): Promise<void> {
        const baseId = boundedString(rawBaseId, 160);
        const headId = boundedString(rawHeadId, 160);
        if (!baseId || !headId) {
            throw new Error('Select two captures to compare');
        }
        if (baseId === headId) {
            throw new Error('Select two different captures to compare');
        }
        const entries = await this.readHistory(sessionId);
        const base = entries.find(item => item.id === baseId);
        const head = entries.find(item => item.id === headId);
        if (!base || !head) {
            throw new Error('The selected capture is no longer available');
        }
        const summary = formatPythonProfilerComparison(base, head);
        const copied = await copyToClipboard(summary);
        await webview.postMessage({
            type: 'pythonProfilerCompared',
            requestId,
            sessionId,
            connectionGeneration,
            target,
            baseId,
            headId,
            summary,
            summaryLength: summary.length,
            copied
        });
    }

    /**
     * 会话对应的工程根目录：优先活会话，其次采集时记下的，最后退回最近一次见过的。
     * 没有它，「退出游戏后还能不能分析」就只能靠会话还在。
     */
    private resolveProjectRoot(sessionId: string): string | undefined {
        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        const live = session?.projectRoot ? path.resolve(session.projectRoot) : undefined;
        // 没有会话（游戏没启动）时退回工作区目录：历史文件就放在 <workspace>/.mcdev 下
        const folder = vscode.workspace.workspaceFolders?.[0];
        const workspaceRoot = folder ? path.resolve(folder.uri.fsPath) : undefined;
        const resolved = live
            ?? this.projectRoots.get(sessionId)
            ?? this.lastProjectRoot
            ?? workspaceRoot;
        if (resolved) {
            this.projectRoots.set(sessionId, resolved);
            this.lastProjectRoot = resolved;
        }
        return resolved;
    }

    private async postState(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number
    ): Promise<void> {
        const states = (['client', 'server', 'all'] as const).map(target => {
            const key = runtimeKey(sessionId, connectionGeneration, target);
            const runtime = this.runtimes.get(key);
            const completed = this.completed.get(key);
            return {
                target,
                status: runtime ? (runtime.collecting ? 'collecting' : 'running') : 'idle',
                clock: runtime?.clock ?? completed?.clock ?? 'WALL',
                durationSeconds: runtime?.durationSeconds,
                startedAt: runtime ? new Date(runtime.startedAt).toISOString() : undefined,
                completed
            };
        });
        await webview.postMessage({
            type: 'pythonProfilerState',
            requestId,
            sessionId,
            connectionGeneration,
            states
        });
    }

    /**
     * 生成「追问 + 报告正文」。落盘的 .md 始终是全量，只有正文按 copyLimit 收窄。
     */
    private async buildAnalysisPrompt(
        key: string,
        sessionId: string,
        mod?: string,
        historyId?: string,
        copyLimit?: number,
        classes: PythonProfilerClassesMode = 'both'
    ): Promise<PythonProfilerPreparedPrompt> {
        let markdownPath: string;
        let target: PythonProfilerTarget;
        let analyzedHistoryId = '';
        let reportContext: PythonProfilerReportContext;
        let reportResult: PythonProfilerResult;
        if (historyId) {
            // 回看历史采集时「复制给 Agent」：直接拿落盘的记录重新出报告，
            // 不要求会话还活着（游戏退出后照样能用）
            const projectRoot = this.resolveProjectRoot(sessionId);
            if (!projectRoot) {
                throw new Error('The selected game session has no project root');
            }
            const entry = (await readPythonProfilerHistory(projectRoot)).find(item => item.id === historyId);
            if (!entry) {
                throw new Error('The selected capture is no longer available');
            }
            reportContext = {
                projectRoot,
                target: entry.target,
                worldName: entry.worldName,
                capturedAt: new Date(entry.capturedAt)
            };
            reportResult = pythonProfilerResultFromHistory(entry);
            const files = await writePythonProfilerReport(reportContext, reportResult, { mod });
            markdownPath = files.markdownPath;
            target = entry.target;
            analyzedHistoryId = entry.id;
        } else {
            const completed = this.completed.get(key);
            if (!completed) {
                throw new Error('No Python profile result is available');
            }
            reportContext = this.reportContext(sessionId, completed);
            reportResult = completed.result;
            if (mod) {
                // 按 mod 生成独立报告（md），不影响整体报告缓存，也不写 svg
                const files = await writePythonProfilerReport(reportContext, reportResult, { mod });
                markdownPath = files.markdownPath;
            } else {
                await this.saveReport(key, sessionId);
                const report = this.completed.get(key)?.report;
                if (!report) {
                    throw new Error('No generated profile report is available');
                }
                markdownPath = report.markdownPath;
            }
            target = completed.target;
        }
        // 落盘的 .md 始终是全量（含调用关系）；复制出去的正文一律在内存里重渲染：
        // 不带「调用关系」那一节（几千条边会直接占满对话上下文），copyLimit 再决定每段留几条。
        const markdown = buildPythonProfilerReportMarkdown(reportContext, reportResult, {
            mod,
            limit: copyLimit,
            classes
        });
        return {
            prompt: buildPythonProfilerAnalysisPrompt(markdownPath, markdown, mod, copyLimit, classes),
            markdownPath,
            target,
            historyId: analyzedHistoryId
        };
    }

    /**
     * 「复制给 Agent」：生成正文，然后**默认直接打开**编辑器标签页里的预览面板（单例）。
     * 侧边栏放不下两百行正文，所以不再在面板里套一层小弹层、也不再多一步「在编辑器中打开」；
     * 正文只在这一处出现，改完点「复制到剪贴板」才真的写剪贴板。
     */
    private async preparePrompt(
        key: string,
        sessionId: string,
        webview: vscode.Webview,
        requestId: string,
        connectionGeneration: number,
        mod?: string,
        historyId?: string,
        copyLimit?: number,
        classes: PythonProfilerClassesMode = 'both'
    ): Promise<void> {
        const prepared = await this.buildAnalysisPrompt(key, sessionId, mod, historyId, copyLimit, classes);
        this.showPromptPanel(
            key,
            sessionId,
            webview,
            requestId,
            connectionGeneration,
            prepared.target,
            prepared.prompt,
            mod,
            prepared.historyId,
            copyLimit,
            prepared.markdownPath,
            classes
        );
        // 侧边栏只留一条提示（正文不在这儿重复摆一份）
        void webview.postMessage({
            type: 'pythonProfilerPromptOpened',
            requestId,
            sessionId,
            connectionGeneration,
            target: prepared.target,
            historyId: prepared.historyId ?? '',
            mod: mod || '',
            reportPath: prepared.markdownPath,
            promptLength: prepared.prompt.length,
            copyLimit: copyLimit ?? 0,
            classes
        }).then(undefined, () => undefined);
    }

    /** 打开（或刷新）编辑器标签页里的预览面板，单例复用 */
    private showPromptPanel(
        key: string,
        sessionId: string,
        webview: vscode.Webview,
        requestId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget,
        text: string,
        mod?: string,
        historyId?: string,
        copyLimit?: number,
        reportPath?: string,
        classes: PythonProfilerClassesMode = 'both'
    ): void {
        const promptMod = mod || '';
        PythonProfilerPromptPanel.show({
            content: {
                prompt: text,
                reportPath: reportPath ?? '',
                mod: promptMod || undefined,
                copyLimit: copyLimit ?? 0,
                classes,
                target
            },
            // 「重新生成」按同样的参数再来一遍（报告文件会重新落一次，内容一致）
            onRegenerate: async () => {
                const next = await this.buildAnalysisPrompt(key, sessionId, mod, historyId, copyLimit, classes);
                return toPromptContent(next, promptMod, copyLimit, classes);
            },
            // 编辑器面板里复制成功后，让面板那条提示也跟上（面板可能已经关掉，失败无所谓）
            onCopied: copied => {
                void webview.postMessage({
                    type: 'pythonProfilerAnalyzed',
                    requestId,
                    sessionId,
                    connectionGeneration,
                    target,
                    historyId: historyId ?? '',
                    mod: promptMod,
                    reportPath: reportPath ?? '',
                    promptCopied: true,
                    promptLength: copied.length,
                    copyLimit: copyLimit ?? 0,
                    classes
                }).then(undefined, () => undefined);
            }
        });
    }

    /** 「复制给 Agent」第二步：把（可能被用户改过的）正文写进剪贴板 */
    private async copyPrompt(
        webview: vscode.Webview,
        requestId: string,
        sessionId: string,
        connectionGeneration: number,
        target: PythonProfilerTarget,
        text: string,
        mod?: string,
        copyLimit?: number,
        classes: PythonProfilerClassesMode = 'both'
    ): Promise<void> {
        const payload = typeof text === 'string' ? text : '';
        if (!payload.trim()) {
            throw new Error('Nothing to copy: the prompt is empty');
        }
        const copied = await copyToClipboard(payload);
        await webview.postMessage({
            type: 'pythonProfilerAnalyzed',
            requestId,
            sessionId,
            connectionGeneration,
            target,
            mod: mod || '',
            promptCopied: copied,
            promptLength: payload.length,
            copyLimit: copyLimit ?? 0,
            classes
        });
    }

    /** 一步到位：生成正文并直接复制（没有预览弹层的调用方用） */
    private async analyze(
        key: string,
        sessionId: string,
        webview: vscode.Webview,
        requestId: string,
        connectionGeneration: number,
        mod?: string,
        historyId?: string,
        copyLimit?: number,
        classes: PythonProfilerClassesMode = 'both'
    ): Promise<void> {
        const prepared = await this.buildAnalysisPrompt(key, sessionId, mod, historyId, copyLimit, classes);
        const copied = await copyToClipboard(prepared.prompt);
        await webview.postMessage({
            type: 'pythonProfilerAnalyzed',
            requestId,
            sessionId,
            connectionGeneration,
            target: prepared.target,
            historyId: prepared.historyId,
            mod: mod || '',
            reportPath: prepared.markdownPath,
            promptCopied: copied,
            promptLength: prepared.prompt.length,
            copyLimit: copyLimit ?? 0,
            classes
        });
    }


    /** 报告需要的工作区上下文；工作区未知时直接报错，别写出半份报告 */
    private reportContext(
        sessionId: string,
        completed: PythonProfilerCompletedState
    ): PythonProfilerReportContext {
        const projectRoot = completed.projectRoot ?? this.resolveProjectRoot(sessionId);
        if (!projectRoot) {
            throw new Error('The selected game session has no project root');
        }
        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        return {
            projectRoot,
            target: completed.target,
            worldName: session?.worldName || session?.worldFolderName || completed.worldName,
            capturedAt: new Date(completed.capturedAt)
        };
    }

    private async openReport(key: string, kind: 'markdown' | 'svg'): Promise<void> {
        const report = this.completed.get(key)?.report;
        const filePath = kind === 'svg' ? report?.svgPath : report?.markdownPath;
        if (!filePath) {
            throw new Error('No generated profile report is available');
        }
        if (kind === 'markdown') {
            const document = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(document, { preview: true });
        } else {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
        }
    }

    private async saveReport(key: string, sessionId: string): Promise<void> {
        const completed = this.completed.get(key);
        if (!completed) {
            throw new Error('No Python profile result is available');
        }
        if (completed.report) {
            return;
        }
        try {
            completed.report = await writePythonProfilerReport(
                this.reportContext(sessionId, completed),
                completed.result
            );
            completed.reportError = undefined;
        } catch (error) {
            completed.reportError = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }

    private async revealReport(key: string): Promise<void> {
        const report = this.completed.get(key)?.report;
        if (!report) {
            throw new Error('No generated profile report is available');
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(report.markdownPath));
    }

    private async openFunction(key: string, sessionId: string, rawFunctionId: unknown): Promise<void> {
        const completed = this.completed.get(key);
        const functionId = typeof rawFunctionId === 'number' && Number.isInteger(rawFunctionId)
            ? rawFunctionId
            : undefined;
        const profiledFunction = functionId !== undefined
            ? completed?.result.functions.find(item => item.id === functionId)
            : undefined;
        if (!profiledFunction) {
            throw new Error('The selected profiled function is no longer available');
        }
        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        if (!session?.projectRoot) {
            throw new Error('The selected game session has no project root');
        }
        await openPythonProfilerSource({
            projectRoot: session.projectRoot,
            module: profiledFunction.module,
            line: profiledFunction.line,
            functionName: profiledFunction.name
        });
    }

    private async postAutomaticError(runtime: PythonProfilerRuntime, error: unknown): Promise<void> {
        await this.postState(
            runtime.webview,
            `auto:${Date.now()}`,
            runtime.sessionId,
            runtime.connectionGeneration
        ).catch(() => undefined);
        await runtime.webview.postMessage({
            type: 'pythonProfilerError',
            requestId: `auto:${Date.now()}`,
            sessionId: runtime.sessionId,
            connectionGeneration: runtime.connectionGeneration,
            target: runtime.target,
            message: error instanceof Error ? error.message : String(error)
        });
    }

    private assertSession(sessionId: string, connectionGeneration: number): void {
        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        if (
            !session?.connected
            || session.state !== 'game_ready'
            || session.connectionGeneration !== connectionGeneration
        ) {
            throw new Error('The selected game connection has changed');
        }
    }

    private runExclusive(key: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.operations.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        this.operations.set(key, current);
        return current.finally(() => {
            if (this.operations.get(key) === current) {
                this.operations.delete(key);
            }
        });
    }

    private removeRuntime(runtime: PythonProfilerRuntime): void {
        if (runtime.timer) {
            clearTimeout(runtime.timer);
        }
        if (this.runtimes.get(runtime.key) === runtime) {
            this.runtimes.delete(runtime.key);
        }
    }

    private async cleanupTargets(sessionId: string, target: PythonProfilerTarget): Promise<void> {
        // 'all' 两端都碰过 yappi：客户端拥有这次采样，服务端挂过 sys.setprofile 转发钩子，
        // 两边都要复位 —— 只清客户端会在服务端留下钩子 / _mcdev_pp_owned，下次再采就会 busy。
        const sides: PythonProfilerSide[] = target === 'all' ? ['client', 'server'] : [target];
        await Promise.all(sides.map(side => this.hostBridgeManager.executeCode(
            sessionId,
            buildPythonProfilerCleanupCode(),
            side === 'client'
        ).catch(() => undefined)));
    }

    private async performDispose(): Promise<void> {
        this.disposed = true;
        const cleanups = [...this.runtimes.values()].map(runtime => this.runExclusive(
            runtime.key,
            async () => {
                this.removeRuntime(runtime);
                await this.cleanupTargets(runtime.sessionId, runtime.target);
            }
        ));
        await Promise.all(cleanups);
        this.completed.clear();
        this.operations.clear();
    }
}

/** 历史条目只存了函数明细：还原成报告生成器能吃的完整结果对象 */
function pythonProfilerResultFromHistory(entry: PythonProfilerHistoryEntry): PythonProfilerResult {
    const functions = entry.functions.map((item, index) => ({
        id: index + 1,
        // 「全部」的历史里两端混在一起，逐条用条目里存的 target；旧文件没存就退回采集目标
        target: item.target === 'server'
            ? ('server' as const)
            : item.target === 'client'
                ? ('client' as const)
                : entry.target === 'server' ? ('server' as const) : ('client' as const),
        module: item.module,
        line: item.line,
        name: item.name,
        calls: item.calls,
        actualCalls: item.calls,
        selfTime: item.selfTime,
        totalTime: item.totalTime,
        contextId: 0,
        contextName: '',
        isProject: true,
        mod: ''
    }));
    return {
        clock: entry.clock,
        elapsedSeconds: entry.elapsedSeconds,
        totalFunctions: entry.functionCount,
        engineFunctions: 0,
        truncated: false,
        functions,
        calls: []
    };
}

function runtimeKey(
    sessionId: string,
    connectionGeneration: number,
    target: PythonProfilerTarget
): string {
    return `${sessionId}:${connectionGeneration}:${target}`;
}

function readTarget(value: unknown): PythonProfilerTarget | undefined {
    return value === 'client' || value === 'server' || value === 'all' ? value : undefined;
}

function isClientExecution(target: PythonProfilerTarget): boolean {
    return target !== 'server';
}

/** 「Hot Classes / Modules」形态：缺省 / 非法一律 both（汇总 + 函数表） */
function readClassesMode(value: unknown): PythonProfilerClassesMode {
    return value === 'none' || value === 'only' ? value : 'both';
}

/** 「复制给 Agent」每段保留多少函数：缺省 / 0 / 非法一律当全部 */
function readCopyLimit(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.max(1, Math.floor(value));
}

/** 把「生成好的正文」转成面板要显示的内容 */
function toPromptContent(
    prepared: PythonProfilerPreparedPrompt,
    mod: string,
    copyLimit?: number,
    classes: PythonProfilerClassesMode = 'both'
): PythonProfilerPromptContent {
    return {
        prompt: prepared.prompt,
        reportPath: prepared.markdownPath,
        mod: mod || undefined,
        copyLimit: copyLimit ?? 0,
        classes,
        target: prepared.target
    };
}

function readDuration(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('Profile duration must be greater than zero');
    }
    return value;
}

function boundedString(value: unknown, maximum: number): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= maximum
        ? value
        : undefined;
}
