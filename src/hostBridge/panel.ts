import * as vscode from 'vscode';
import * as path from 'path';
import {
    buildDebugFunctionInvocation,
    DebugFunctionService,
    validateSavedFunction
} from '../debugFunctions';
import { buildWebviewPage } from './webviewPage';
import { getNonce } from '../utils';
import { HostBridgeManager } from './manager';
import { LatestOperationQueue } from './latestOperationQueue';
import { HostBridgeRpcError } from './server';
import { DisposableLike } from './types';
import { PythonProfilerController } from './pythonProfilerController';
import { PythonMemoryProfilerController } from './pythonMemoryProfilerController';
import { NativeProfilerController } from './nativeProfilerController';
import { PerfMonitorController } from './perfMonitorController';
import {
    buildUiDebuggerChildrenCode,
    buildUiDebuggerNodeCode,
    buildUiDebuggerPickerDisableCode,
    buildUiDebuggerPickerEnableCode,
    buildUiDebuggerPickerPollCode,
    buildUiDebuggerPickerSelectCode,
    buildUiDebuggerPropertyCode,
    buildUiDebuggerRevealCode,
    buildUiDebuggerScreensCode,
    buildUiDebuggerVisibilityCode,
    parseUiDebuggerChildren,
    parseUiDebuggerNode,
    parseUiDebuggerReveal,
    parseUiDebuggerScreens,
    UI_DEBUGGER_PAGE_SIZE
} from './uiDebugger';

interface UiPickerRuntime {
    connectionGeneration: number;
    timer: NodeJS.Timeout;
    busy: boolean;
    failures: number;
    polls: number;
    webview: vscode.Webview;
}

const GAME_DEBUGGER_VIEW_ID = 'mcdev-tools.debugView';

/**
 * 'full'   = 原版页签顺序（代码执行 / 调试函数 / UI 调试器 / Python 性能 / Python 内存 / Native 性能 / 性能监测）
 * 'studio' = 自用顺序（Python 性能+内存 合并 / 性能监测 / UI 调试器 / Native 性能 / 代码执行 / 调试函数），顶部多一条同采同停操作条
 */
export type DebuggerMode = 'full' | 'studio';

/**
 * 面板宿主抽象：同一套调试逻辑既能挂在编辑器页签（WebviewPanel）上，
 * 也能挂在次级侧边栏的停靠视图（WebviewView）上。
 */
interface DebuggerSurface {
    readonly kind: 'panel' | 'view';
    readonly webview: vscode.Webview;
    readonly visible: boolean;
    reveal(): void;
    dispose(): void;
    onDispose(listener: () => void): DisposableLike;
    onVisibilityChange(listener: (visible: boolean) => void): DisposableLike;
}

export class GameDebuggerPanel implements vscode.Disposable {
    private surface?: DebuggerSurface;
    /** 停靠视图实例只由 VS Code 解析一次，留一份引用用于「切回侧边栏」时重新挂载。 */
    private lastView?: vscode.WebviewView;
    private placeholderSubscription?: vscode.Disposable;
    private bridgeSubscription?: DisposableLike;
    private messageSubscription?: vscode.Disposable;
    private surfaceDisposeSubscription?: vscode.Disposable;
    private surfaceVisibilitySubscription?: vscode.Disposable;
    private debugFunctionService?: DebugFunctionService;
    private readonly uiPickers = new Map<string, UiPickerRuntime>();
    private readonly uiPickerQueue = new LatestOperationQueue();
    private readonly uiPropertyQueue = new LatestOperationQueue();
    private pythonProfilerController?: PythonProfilerController;
    private pythonMemoryProfilerController?: PythonMemoryProfilerController;
    private nativeProfilerController?: NativeProfilerController;
    private perfMonitorController?: PerfMonitorController;
    private releasePromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly hostBridgeManager: HostBridgeManager,
        private readonly mode: DebuggerMode = 'full'
    ) {}

    /**
     * 标题保持简洁，版本号只显示在面板内的构建徽标上，避免每次升级都要刷新标题。
     */
    private resolvePanelTitle(): string {
        return this.mode === 'studio' ? 'MC Dev Tools - 性能调试' : 'MC Dev Tools - 游戏调试';
    }

    /** 是否已经挂上了某个宿主（编辑器页签或停靠视图），自动打开失败时用来兜底判断。 */
    public get hasSurface(): boolean {
        return this.surface !== undefined;
    }

    /** 打开为编辑器页签（当前编辑器组里单开一个标签）。 */
    public show(): void {
        if (this.surface?.kind === 'panel') {
            this.surface.reveal();
            return;
        }
        if (this.surface?.kind === 'view') {
            // 默认位置是编辑器页签：让侧边栏视图让位，并给它留一个可以切回来的占位页。
            const staleView = this.lastView;
            void this.releaseSurface();
            if (staleView) {
                this.renderViewPlaceholder(staleView);
            }
        }

        const panel = vscode.window.createWebviewPanel(
            'mcdev-tools.gameDebugger',
            this.resolvePanelTitle(),
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri]
            }
        );
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'images', 'icon.png');
        this.attach(createPanelSurface(panel));
        panel.reveal(panel.viewColumn, false);
    }

    /** 停靠到次级侧边栏（辅助侧边栏）的视图入口。 */
    public resolveWebviewView(view: vscode.WebviewView): void {
        this.lastView = view;
        const previous = this.surface;
        if (previous?.kind === 'view') {
            return;
        }
        if (previous) {
            // 侧边栏视图优先：把编辑器页签收掉，避免两套控制器抢同一条会话
            void this.releaseSurface();
            previous.dispose();
        }
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        this.attach(createViewSurface(view));
    }

    /**
     * 面板搬到编辑器页签后，侧边栏那格只剩一个说明页 + 「在侧边栏显示」按钮，
     * 避免停靠视图留着上一套已经释放的界面点不动。
     */
    private renderViewPlaceholder(view: vscode.WebviewView): void {
        const nonce = getNonce();
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = `<!doctype html>
<html lang="zh">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        body { margin: 0; padding: 12px; font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-descriptionForeground); }
        h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
        p { margin: 0 0 10px; line-height: 1.6; }
        button { font-family: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
    </style>
</head>
<body>
    <h2>面板已在编辑器页签打开</h2>
    <p>「性能调试」现在单开在编辑器区的标签页里，页签栏和全部工具都在那边。</p>
    <p>想放回侧边栏就点下面的按钮。</p>
    <button id="attach">在侧边栏显示</button>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('attach').addEventListener('click', () => vscode.postMessage({ type: 'attachViewSurface' }));
    </script>
</body>
</html>`;
        this.placeholderSubscription?.dispose();
        this.placeholderSubscription = view.webview.onDidReceiveMessage(message => {
            if (message?.type === 'attachViewSurface') {
                this.placeholderSubscription?.dispose();
                this.placeholderSubscription = undefined;
                this.resolveWebviewView(view);
            }
        });
    }

    private attach(surface: DebuggerSurface): void {
        this.placeholderSubscription?.dispose();
        this.placeholderSubscription = undefined;
        this.surface = surface;
        this.pythonProfilerController = new PythonProfilerController(this.hostBridgeManager);
        surface.webview.html = this.getHtml(surface.webview);

        this.messageSubscription = surface.webview.onDidReceiveMessage(message => {
            void this.handleMessage(surface.webview, message);
        });
        this.bridgeSubscription = this.hostBridgeManager.onDidChange(snapshot => {
            this.reconcileUiPickers(snapshot);
            this.pythonProfilerController?.reconcile(snapshot);
            this.pythonMemoryProfilerController?.reconcile(snapshot);
            this.nativeProfilerController?.reconcile(snapshot);
            this.perfMonitorController?.reconcile(snapshot);
            void surface.webview.postMessage({ type: 'hostBridgeState', snapshot });
        });
        this.surfaceDisposeSubscription = surface.onDispose(() => {
            void this.releaseSurface();
        });
        this.surfaceVisibilitySubscription = surface.onVisibilityChange(visible => {
            this.nativeProfilerController?.setPanelVisible(visible);
        });
    }

    public dispose(): void {
        this.placeholderSubscription?.dispose();
        this.placeholderSubscription = undefined;
        const surface = this.surface;
        void this.releaseSurface();
        surface?.dispose();
    }

    public async disposeAsync(): Promise<void> {
        const surface = this.surface;
        const release = this.releaseSurface();
        surface?.dispose();
        await release;
        await this.releasePromise;
    }

    private releaseSurface(): Promise<void> {
        const pickerCleanup = this.disposeUiPickersAsync();
        const pythonProfilerController = this.pythonProfilerController;
        const pythonMemoryProfilerController = this.pythonMemoryProfilerController;
        const nativeProfilerController = this.nativeProfilerController;
        const perfMonitorController = this.perfMonitorController;
        this.pythonProfilerController = undefined;
        this.pythonMemoryProfilerController = undefined;
        this.nativeProfilerController = undefined;
        this.perfMonitorController = undefined;
        this.messageSubscription?.dispose();
        this.messageSubscription = undefined;
        this.bridgeSubscription?.dispose();
        this.bridgeSubscription = undefined;
        this.surfaceDisposeSubscription?.dispose();
        this.surfaceDisposeSubscription = undefined;
        this.surfaceVisibilitySubscription?.dispose();
        this.surfaceVisibilitySubscription = undefined;
        this.debugFunctionService?.dispose();
        this.debugFunctionService = undefined;
        this.surface = undefined;

        const cleanup = Promise.all([
            pickerCleanup,
            pythonProfilerController?.disposeAsync(),
            pythonMemoryProfilerController?.disposeAsync(),
            nativeProfilerController?.disposeAsync(),
            perfMonitorController?.disposeAsync()
        ]).then(() => undefined);
        this.releasePromise = Promise.allSettled([this.releasePromise, cleanup]).then(results => {
            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error('Failed to release the game debugger panel', result.reason);
                }
            }
        });
        return this.releasePromise;
    }

    private async handleMessage(webview: vscode.Webview, message: any): Promise<void> {
        if (message?.type === 'ready') {
            await this.postState(webview);
            return;
        }
        if (message?.type === 'hostBridgeRefresh') {
            await this.hostBridgeManager.refreshSessions();
            await this.postState(webview);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('debugFunction')) {
            await this.handleDebugFunctionMessage(webview, message);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('uiDebugger')) {
            await this.handleUiDebuggerMessage(webview, message);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('pythonProfiler')) {
            await this.pythonProfilerController?.handleMessage(webview, message);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('pythonMemoryProfiler')) {
            const controller = this.pythonMemoryProfilerController ??= new PythonMemoryProfilerController(
                this.hostBridgeManager
            );
            await controller.handleMessage(webview, message);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('nativeProfiler')) {
            const controller = this.nativeProfilerController ??= new NativeProfilerController(
                this.extensionUri.fsPath,
                this.hostBridgeManager
            );
            controller.setPanelVisible(this.surface?.visible ?? true);
            await controller.handleMessage(webview, message);
            return;
        }
        if (typeof message?.type === 'string' && message.type.startsWith('perfMonitor')) {
            const controller = this.perfMonitorController ??= new PerfMonitorController(
                this.extensionUri.fsPath,
                this.hostBridgeManager
            );
            await controller.handleMessage(webview, message);
            return;
        }
        if (message?.type !== 'hostBridgeExecute') {
            return;
        }

        const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
            ? message.requestId
            : '';
        const sessionId = typeof message.sessionId === 'string' && message.sessionId.length <= 128
            ? message.sessionId
            : '';
        const code = typeof message.code === 'string' ? message.code : '';
        const isClient = message.isClient !== false;
        if (!requestId || !sessionId) {
            return;
        }

        try {
            const result = await this.hostBridgeManager.executeCode(sessionId, code, isClient);
            await webview.postMessage({
                type: 'hostBridgeExecutionResult',
                requestId,
                sessionId,
                isClient,
                ok: true,
                result
            });
        } catch (error) {
            const rpcError = error instanceof HostBridgeRpcError ? error : undefined;
            await webview.postMessage({
                type: 'hostBridgeExecutionResult',
                requestId,
                sessionId,
                isClient,
                ok: false,
                error: {
                    code: rpcError?.symbolicCode,
                    rpcCode: rpcError?.rpcCode,
                    message: error instanceof Error ? error.message : String(error)
                }
            });
        }
    }

    private async handleUiDebuggerMessage(webview: vscode.Webview, message: any): Promise<void> {
        const requestId = readBoundedString(message.requestId, 128);
        const sessionId = readBoundedString(message.sessionId, 128);
        const connectionGeneration = Number.isInteger(message.connectionGeneration)
            ? Number(message.connectionGeneration)
            : -1;
        if (!requestId || !sessionId || connectionGeneration < 0) {
            return;
        }

        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        if (!session || session.connectionGeneration !== connectionGeneration) {
            await this.postUiDebuggerError(
                webview, requestId, message.type, sessionId, connectionGeneration,
                'The selected game connection has changed'
            );
            return;
        }

        try {
            switch (message.type) {
                case 'uiDebuggerScreens': {
                    const result = await this.hostBridgeManager.executeCode(
                        sessionId, buildUiDebuggerScreensCode(), true
                    );
                    await webview.postMessage({
                        type: 'uiDebuggerScreensResult', requestId, sessionId, connectionGeneration,
                        screens: parseUiDebuggerScreens(result)
                    });
                    return;
                }
                case 'uiDebuggerChildren': {
                    const screen = readBoundedString(message.screen, 512);
                    const parentPath = readBoundedString(message.parentPath, 4096, true);
                    const offset = Number.isInteger(message.offset) ? Number(message.offset) : 0;
                    if (!screen || parentPath === undefined) {
                        throw new Error('Invalid UI tree path');
                    }
                    const code = buildUiDebuggerChildrenCode(
                        screen, parentPath, offset, UI_DEBUGGER_PAGE_SIZE
                    );
                    const result = await this.hostBridgeManager.executeCode(sessionId, code, true);
                    await webview.postMessage({
                        type: 'uiDebuggerChildrenResult', requestId, sessionId, connectionGeneration,
                        screen, parentPath,
                        ...parseUiDebuggerChildren(result, parentPath, offset)
                    });
                    return;
                }
                case 'uiDebuggerNode': {
                    const screen = readBoundedString(message.screen, 512);
                    const nodePath = readBoundedString(message.path, 4096);
                    if (!screen || !nodePath) {
                        throw new Error('Invalid UI node path');
                    }
                    const result = await this.hostBridgeManager.executeCode(
                        sessionId, buildUiDebuggerNodeCode(screen, nodePath), true
                    );
                    await webview.postMessage({
                        type: 'uiDebuggerNodeResult', requestId, sessionId, connectionGeneration,
                        node: parseUiDebuggerNode(result, screen, nodePath)
                    });
                    return;
                }
                case 'uiDebuggerSetVisibility': {
                    const screen = readBoundedString(message.screen, 512);
                    const nodePath = readBoundedString(message.path, 4096);
                    if (!screen || !nodePath || typeof message.visible !== 'boolean') {
                        throw new Error('Invalid UI visibility update');
                    }
                    const result = await this.hostBridgeManager.executeCode(
                        sessionId,
                        buildUiDebuggerVisibilityCode(screen, nodePath, message.visible),
                        true
                    );
                    await webview.postMessage({
                        type: 'uiDebuggerVisibilityResult', requestId, sessionId, connectionGeneration,
                        screen, path: nodePath, visible: result === true
                    });
                    return;
                }
                case 'uiDebuggerSetProperty': {
                    const screen = readBoundedString(message.screen, 512);
                    const nodePath = readBoundedString(message.path, 4096);
                    const property = readBoundedString(message.property, 64);
                    if (!screen || !nodePath || !property) {
                        throw new Error('Invalid UI property update');
                    }
                    const code = buildUiDebuggerPropertyCode(screen, nodePath, property, message.value);
                    const queueKey = JSON.stringify([
                        sessionId, connectionGeneration, screen, nodePath, property
                    ]);
                    let value: unknown;
                    await this.uiPropertyQueue.runLatest(queueKey, async () => {
                        this.assertUiDebuggerSession(sessionId, connectionGeneration);
                        value = await this.hostBridgeManager.executeCode(sessionId, code, true);
                    });
                    await webview.postMessage({
                        type: 'uiDebuggerPropertyResult', requestId, sessionId, connectionGeneration,
                        screen, path: nodePath, property, value
                    });
                    return;
                }
                case 'uiDebuggerPickerMode': {
                    const mode = message.mode === 'select' || message.mode === 'layout'
                        ? message.mode
                        : 'off';
                    this.uiPickerQueue.invalidateLatest(sessionId);
                    await this.uiPickerQueue.run(sessionId, async () => {
                        try {
                            this.assertUiDebuggerSession(sessionId, connectionGeneration);
                            if (mode !== 'off') {
                                const result = await this.hostBridgeManager.executeCode(
                                    sessionId, buildUiDebuggerPickerEnableCode(mode === 'layout'), true
                                );
                                if (result !== true) {
                                    throw new Error('The native UI picker is unavailable in this game build');
                                }
                                this.assertUiDebuggerSession(sessionId, connectionGeneration);
                                this.startUiPicker(webview, sessionId, connectionGeneration);
                            } else {
                                await this.stopUiPicker(sessionId, true);
                            }
                        } catch (error) {
                            await this.stopUiPicker(sessionId, true, true);
                            throw error;
                        }
                    });
                    await webview.postMessage({
                        type: 'uiDebuggerPickerModeResult', requestId, sessionId, connectionGeneration,
                        mode
                    });
                    return;
                }
                case 'uiDebuggerPickerSelect': {
                    const screen = readBoundedString(message.screen, 512);
                    const nodePath = readBoundedString(message.path, 4096);
                    if (!screen || !nodePath) {
                        throw new Error('Invalid UI node path');
                    }
                    await this.uiPickerQueue.runLatest(sessionId, async () => {
                        this.assertUiDebuggerSession(sessionId, connectionGeneration);
                        const picker = this.uiPickers.get(sessionId);
                        if (picker?.connectionGeneration !== connectionGeneration) {
                            throw new Error('Enable the native UI picker before selecting a node');
                        }
                        await this.hostBridgeManager.executeCode(
                            sessionId,
                            buildUiDebuggerPickerSelectCode(screen, nodePath),
                            true
                        );
                    });
                    await webview.postMessage({
                        type: 'uiDebuggerPickerSelectResult', requestId, sessionId, connectionGeneration,
                        screen, path: nodePath
                    });
                    return;
                }
                case 'uiDebuggerReveal': {
                    const screen = readBoundedString(message.screen, 512);
                    const nodePath = readBoundedString(message.path, 4096);
                    if (!screen || !nodePath) {
                        throw new Error('Invalid UI reveal path');
                    }
                    const result = await this.hostBridgeManager.executeCode(
                        sessionId,
                        buildUiDebuggerRevealCode(screen, nodePath),
                        true
                    );
                    await webview.postMessage({
                        type: 'uiDebuggerRevealResult', requestId, sessionId, connectionGeneration,
                        screen, path: nodePath, pages: parseUiDebuggerReveal(result)
                    });
                    return;
                }
            }
        } catch (error) {
            await this.postUiDebuggerError(
                webview, requestId, message.type, sessionId, connectionGeneration,
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private startUiPicker(
        webview: vscode.Webview,
        sessionId: string,
        connectionGeneration: number
    ): void {
        const existing = this.uiPickers.get(sessionId);
        if (existing) {
            clearInterval(existing.timer);
        }
        const picker: UiPickerRuntime = {
            connectionGeneration,
            timer: undefined as unknown as NodeJS.Timeout,
            busy: false,
            failures: 0,
            polls: 0,
            webview
        };
        picker.timer = setInterval(() => {
            void this.pollUiPicker(sessionId, picker);
        }, 60);
        this.uiPickers.set(sessionId, picker);
    }

    private async pollUiPicker(sessionId: string, picker: UiPickerRuntime): Promise<void> {
        if (picker.busy || this.uiPickers.get(sessionId) !== picker) {
            return;
        }
        picker.busy = true;
        try {
            picker.polls += 1;
            const includeScreens = picker.polls % 8 === 0;
            const result = await this.hostBridgeManager.executeCode(
                sessionId, buildUiDebuggerPickerPollCode(includeScreens), true
            );
            picker.failures = 0;
            const eventEnvelope = includeScreens && Array.isArray(result) ? result[0] : result;
            if (includeScreens && Array.isArray(result)) {
                await picker.webview.postMessage({
                    type: 'uiDebuggerScreensEvent',
                    sessionId,
                    connectionGeneration: picker.connectionGeneration,
                    screens: parseUiDebuggerScreens(result[1])
                });
            }
            if (eventEnvelope !== null && eventEnvelope !== undefined) {
                const isResolvedEnvelope = Array.isArray(eventEnvelope)
                    && eventEnvelope.length === 3
                    && typeof eventEnvelope[2] === 'string';
                const event = isResolvedEnvelope ? eventEnvelope[0] : eventEnvelope;
                const screen = isResolvedEnvelope && typeof eventEnvelope[1] === 'string'
                    && eventEnvelope[1].length <= 512
                    ? eventEnvelope[1]
                    : undefined;
                const pickerPath = isResolvedEnvelope && eventEnvelope[2].length <= 4096
                    ? eventEnvelope[2]
                    : undefined;
                await picker.webview.postMessage({
                    type: 'uiDebuggerPickerEvent',
                    sessionId,
                    connectionGeneration: picker.connectionGeneration,
                    event,
                    screen,
                    path: pickerPath
                });
            }
        } catch (error) {
            picker.failures += 1;
            if (picker.failures >= 3) {
                await this.uiPickerQueue.run(
                    sessionId, () => this.stopUiPicker(sessionId, true, true)
                );
                await picker.webview.postMessage({
                    type: 'uiDebuggerPickerStopped',
                    sessionId,
                    connectionGeneration: picker.connectionGeneration,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        } finally {
            picker.busy = false;
        }
    }

    private async stopUiPicker(
        sessionId: string,
        cleanupGame: boolean,
        suppressCleanupError = false
    ): Promise<void> {
        this.uiPickerQueue.invalidateLatest(sessionId);
        const picker = this.uiPickers.get(sessionId);
        if (picker) {
            clearInterval(picker.timer);
            this.uiPickers.delete(sessionId);
        }
        if (cleanupGame) {
            const cleanup = this.hostBridgeManager.executeCode(
                sessionId, buildUiDebuggerPickerDisableCode(), true
            );
            if (suppressCleanupError) {
                await cleanup.catch(() => undefined);
            } else {
                await cleanup;
            }
        }
    }

    private reconcileUiPickers(snapshot: ReturnType<HostBridgeManager['getSnapshot']>): void {
        for (const [sessionId, picker] of this.uiPickers) {
            const session = snapshot.sessions.find(item => item.id === sessionId);
            if (
                !session?.connected
                || session.state !== 'game_ready'
                || session.connectionGeneration !== picker.connectionGeneration
            ) {
                clearInterval(picker.timer);
                this.uiPickers.delete(sessionId);
                this.uiPickerQueue.invalidateLatest(sessionId);
                if (session?.connected) {
                    void this.uiPickerQueue.run(sessionId, async () => {
                        await this.hostBridgeManager.executeCode(
                            sessionId, buildUiDebuggerPickerDisableCode(), true
                        ).catch(() => undefined);
                    });
                }
            }
        }
    }

    private disposeUiPickers(): void {
        void this.disposeUiPickersAsync();
    }

    private async disposeUiPickersAsync(): Promise<void> {
        const cleanups: Promise<unknown>[] = [];
        const sessionIds = new Set([
            ...this.uiPickers.keys(),
            ...this.uiPickerQueue.keys()
        ]);
        for (const sessionId of sessionIds) {
            this.uiPickerQueue.invalidateLatest(sessionId);
            const picker = this.uiPickers.get(sessionId);
            if (picker) {
                clearInterval(picker.timer);
                this.uiPickers.delete(sessionId);
            }
            cleanups.push(this.uiPickerQueue.run(sessionId, async () => {
                await this.hostBridgeManager.executeCode(
                    sessionId, buildUiDebuggerPickerDisableCode(), true
                ).catch(() => undefined);
            }));
        }
        await Promise.all(cleanups);
    }

    private assertUiDebuggerSession(sessionId: string, connectionGeneration: number): void {
        const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
        if (
            !session?.connected
            || session.state !== 'game_ready'
            || session.connectionGeneration !== connectionGeneration
        ) {
            throw new Error('The selected game connection has changed');
        }
    }

    private async postUiDebuggerError(
        webview: vscode.Webview,
        requestId: string,
        action: string,
        sessionId: string,
        connectionGeneration: number,
        message: string
    ): Promise<void> {
        await webview.postMessage({
            type: 'uiDebuggerError', requestId, action, sessionId, connectionGeneration, message
        });
    }

    private async handleDebugFunctionMessage(webview: vscode.Webview, message: any): Promise<void> {
        const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
            ? message.requestId
            : '';
        const sessionId = typeof message.sessionId === 'string' && message.sessionId.length <= 128
            ? message.sessionId
            : '';
        if (!requestId) {
            return;
        }
        const workspacePath = this.resolveWorkspacePath(sessionId);
        if (!workspacePath) {
            await this.postDebugFunctionError(webview, requestId, message.type, 'No project is available');
            return;
        }
        const service = this.debugFunctionService ??= new DebugFunctionService();

        try {
            switch (message.type) {
                case 'debugFunctionsLoad': {
                    const functions = await service.load(workspacePath);
                    await webview.postMessage({
                        type: 'debugFunctionsState', requestId, workspacePath, functions
                    });
                    return;
                }
                case 'debugFunctionsDiscover': {
                    const functions = await service.discover(workspacePath, message.force === true);
                    await webview.postMessage({
                        type: 'debugFunctionsDiscovered', requestId, workspacePath, functions
                    });
                    return;
                }
                case 'debugFunctionSave': {
                    const functions = await service.save(workspacePath, message.function);
                    await webview.postMessage({
                        type: 'debugFunctionsState', requestId, workspacePath, functions, saved: true
                    });
                    return;
                }
                case 'debugFunctionDelete': {
                    const id = typeof message.id === 'string' ? message.id : '';
                    const functions = await service.delete(workspacePath, id);
                    await webview.postMessage({
                        type: 'debugFunctionsState', requestId, workspacePath, functions, deletedId: id
                    });
                    return;
                }
                case 'debugFunctionExecute': {
                    if (!sessionId) {
                        throw new Error('Select a game session before running the function');
                    }
                    const saved = validateSavedFunction(message.function);
                    const runtimeArguments = isStringRecord(message.runtimeArguments)
                        ? message.runtimeArguments
                        : {};
                    const code = buildDebugFunctionInvocation(saved, runtimeArguments);
                    const result = await this.hostBridgeManager.executeCode(
                        sessionId,
                        code,
                        saved.target === 'client'
                    );
                    await webview.postMessage({
                        type: 'debugFunctionExecutionResult',
                        requestId,
                        sessionId,
                        functionId: saved.id,
                        ok: true,
                        result
                    });
                    return;
                }
                case 'debugFunctionOpenSource': {
                    await this.openDebugFunctionSource(
                        workspacePath,
                        typeof message.relativeFilePath === 'string' ? message.relativeFilePath : '',
                        Number.isInteger(message.line) ? Number(message.line) : 1
                    );
                    await webview.postMessage({ type: 'debugFunctionSourceOpened', requestId });
                    return;
                }
            }
        } catch (error) {
            if (message.type === 'debugFunctionExecute') {
                const rpcError = error instanceof HostBridgeRpcError ? error : undefined;
                await webview.postMessage({
                    type: 'debugFunctionExecutionResult',
                    requestId,
                    sessionId,
                    functionId: typeof message.function?.id === 'string' ? message.function.id : '',
                    ok: false,
                    error: {
                        code: rpcError?.symbolicCode,
                        rpcCode: rpcError?.rpcCode,
                        message: error instanceof Error ? error.message : String(error)
                    }
                });
                return;
            }
            await this.postDebugFunctionError(
                webview,
                requestId,
                message.type,
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private resolveWorkspacePath(sessionId: string): string | undefined {
        if (sessionId) {
            const session = this.hostBridgeManager.getSnapshot().sessions.find(item => item.id === sessionId);
            if (session?.projectRoot) {
                return path.resolve(session.projectRoot);
            }
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private async openDebugFunctionSource(
        workspacePath: string,
        relativeFilePath: string,
        line: number
    ): Promise<void> {
        const root = path.resolve(workspacePath);
        const target = path.resolve(root, relativeFilePath);
        const relative = path.relative(root, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('Source file is outside the project');
        }
        const document = await vscode.workspace.openTextDocument(target);
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private async postDebugFunctionError(
        webview: vscode.Webview,
        requestId: string,
        action: string,
        message: string
    ): Promise<void> {
        await webview.postMessage({
            type: 'debugFunctionsError', requestId, action, message
        });
    }

    private async postState(webview: vscode.Webview): Promise<void> {
        await webview.postMessage({
            type: 'hostBridgeState',
            snapshot: this.hostBridgeManager.getSnapshot()
        });
    }

    private getHtml(webview: vscode.Webview): string {
        return this.mode === 'studio'
            ? buildWebviewPage(webview, this.extensionUri, {
                title: 'MC Dev Tools - Studio',
                view: 'studio'
            })
            : buildWebviewPage(webview, this.extensionUri, {
                title: 'MC Dev Tools - Game Debugger',
                view: 'game-debugger'
            });
    }
}

function createPanelSurface(panel: vscode.WebviewPanel): DebuggerSurface {
    return {
        kind: 'panel',
        get webview() {
            return panel.webview;
        },
        get visible() {
            return panel.visible;
        },
        reveal: () => panel.reveal(panel.viewColumn, false),
        dispose: () => panel.dispose(),
        onDispose: listener => panel.onDidDispose(() => listener()),
        onVisibilityChange: listener => panel.onDidChangeViewState(event => listener(event.webviewPanel.visible))
    };
}

function createViewSurface(view: vscode.WebviewView): DebuggerSurface {
    return {
        kind: 'view',
        get webview() {
            return view.webview;
        },
        get visible() {
            return view.visible;
        },
        reveal: () => {
            void vscode.commands.executeCommand(`${GAME_DEBUGGER_VIEW_ID}.focus`);
        },
        // 停靠视图的生命周期归 VS Code 管，这里不能销毁，只释放调试逻辑
        dispose: () => undefined,
        onDispose: listener => view.onDidDispose(() => listener()),
        onVisibilityChange: listener => view.onDidChangeVisibility(() => listener(view.visible))
    };
}

function isStringRecord(value: unknown): value is Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every(item => typeof item === 'string' && item.length <= 64 * 1024);
}

function readBoundedString(value: unknown, maxLength: number, allowEmpty = false): string | undefined {
    if (typeof value !== 'string' || value.length > maxLength || value.includes('\0')) {
        return undefined;
    }
    return allowEmpty || value.length > 0 ? value : undefined;
}
