/**
 * 渲染引擎守卫
 *
 * 重要约束（来自实际游戏行为）：
 * - 渲染龙 + 灵动视效只能在游戏内「设置 → 视频 → 渲染引擎」切换；
 * - 游戏外直接改 options.txt 写成渲染龙，启动游戏必定闪退；
 * - 因此本模块只做两件事：
 *   1. 在游戏内切换后（options.txt 变成渲染龙）监听游戏进程，游戏退出后自动写回 OpenGL；
 *   2. 如果发现磁盘上残留渲染龙、但游戏并没有在运行，也自动写回 OpenGL，避免下次启动闪退。
 *
 * 性能：只在 options.txt 处于渲染龙状态时才低频轮询进程；OpenGL 状态只用 fs.watchFile 轮询文件。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    ApplyRenderEngineResult,
    FANCY_GRAPHICS_MODE,
    RenderEngineState,
    applyRenderEngine,
    clampOpenGLGraphicsMode,
    readRenderEngineState,
    resolveOptionsPath
} from './options';
import { isMinecraftProcessAlive } from '../debugger/ptvsd/processDetector';
import type { HostBridgeManager } from '../hostBridge/manager';
import { ensureDebugSettingsOpen } from '../hostBridge/debugSwitchSettings';
import { switchRenderEngineInGame } from './inGameSwitch';

export type { RenderEngineMode, RenderEngineState } from './options';

export interface RenderEngineStatus extends RenderEngineState {
    /** 是否启用「游戏关闭后自动回 OpenGL」 */
    autoRevert: boolean;
    /** 是否正在等待游戏退出 */
    watching: boolean;
    /** 是否正在执行两阶段游戏内切换 */
    switching: boolean;
}

const PREVIOUS_GRAPHICS_MODE_KEY = 'mcdev-tools.renderEngine.previousGraphicsMode';
/** 游戏退出到 options.txt 落盘之间的缓冲 */
const REVERT_SETTLE_MS = 2000;
/** 渲染龙状态下检查游戏进程的间隔 */
const POLL_INTERVAL_MS = 2000;
/** options.txt 变化检查间隔（只 stat，不启动进程） */
const OPTIONS_WATCH_INTERVAL_MS = 2000;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class RenderEngineController implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<RenderEngineStatus>();
    readonly onDidChange = this.emitter.event;

    private state: RenderEngineState;
    private timer: NodeJS.Timeout | undefined;
    private reverting = false;
    private toggling = false;
    private disposed = false;
    private watchedPath: string | undefined;
    private readonly configSubscription: vscode.Disposable;
    private readonly onOptionsFileChanged = (): void => {
        this.refresh();
    };

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly hostBridgeManager?: HostBridgeManager
    ) {
        this.state = this.readState();
        this.configSubscription = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('mcdev-tools.renderEngine')) {
                this.refresh();
            }
        });
    }

    public initialize(): void {
        this.refresh();
    }

    public getStatus(): RenderEngineStatus {
        return {
            ...this.state,
            autoRevert: this.autoRevertEnabled(),
            watching: this.timer !== undefined && !this.disposed,
            switching: this.toggling
        };
    }

    public refresh(): void {
        if (this.disposed) {
            return;
        }
        this.state = this.readState();
        this.watchOptionsFile();
        this.rememberOpenGLGraphicsMode();
        this.syncWatcher();
        this.emit();
    }

    /**
     * 状态条动作：游戏运行时走游戏内「设置 → 视频」自动切换；
     * 游戏没运行时只清理残留的渲染龙（游戏外写渲染龙会闪退）。
     */
    public async toggle(): Promise<void> {
        if (this.disposed || this.toggling) {
            return;
        }
        this.toggling = true;
        this.emit();
        try {
            const running = await isMinecraftProcessAlive().catch(() => false);
            this.refresh();

            if (!this.state.exists) {
                const optionsPath = this.state.optionsPath || resolveOptionsPath() || '';
                void vscode.window.showErrorMessage(
                    optionsPath
                        ? `找不到 Minecraft 的 options.txt：${optionsPath}`
                        : '找不到 Minecraft 的 options.txt：请确认已安装网易版 Minecraft。'
                );
                return;
            }

            if (this.state.mode === 'renderdragon' && !running) {
                const result = applyRenderEngine('opengl', this.state.optionsPath, this.previousGraphicsMode());
                if (!result.ok) {
                    void vscode.window.showErrorMessage(this.describeApplyError(result));
                    return;
                }
                this.state = result.state ?? this.readState();
                this.syncWatcher();
                this.emit();
                void vscode.window.showInformationMessage('已把残留的渲染龙改回 OpenGL，游戏可以正常启动。');
                return;
            }

            if (running) {
                const manager = this.hostBridgeManager;
                const session = manager?.getSnapshot().sessions.find(
                    item => item.connected && item.state === 'game_ready'
                );
                if (!manager || !session) {
                    void vscode.window.showErrorMessage(
                        '游戏正在运行，但没有可用的调试会话。请从插件重新启动游戏后再切换渲染器。'
                    );
                    return;
                }
                const target = this.state.mode === 'opengl' ? 'renderdragon' : 'opengl';
                const result = await switchRenderEngineInGame(
                    target,
                    code => manager.executeCode(session.id, code, true),
                    () => ensureDebugSettingsOpen(manager, session.id)
                );
                if (result.ok) {
                    this.refresh();
                    void vscode.window.showInformationMessage(
                        target === 'renderdragon'
                            ? '已切换到渲染龙 + 灵动视效。'
                            : '已切回 OpenGL。'
                    );
                } else {
                    void vscode.window.showErrorMessage(result.message || '渲染引擎切换失败。');
                }
                return;
            }

            void vscode.window.showInformationMessage('当前是 OpenGL，游戏可以正常启动。');
        } finally {
            this.toggling = false;
            this.refresh();
        }
    }

    public dispose(): void {
        this.disposed = true;
        this.stopWatcher();
        if (this.watchedPath) {
            fs.unwatchFile(this.watchedPath, this.onOptionsFileChanged);
            this.watchedPath = undefined;
        }
        this.configSubscription.dispose();
        this.emitter.dispose();
    }

    private readState(): RenderEngineState {
        const configured = vscode.workspace
            .getConfiguration('mcdev-tools')
            .get<string>('renderEngine.optionsPath', '');
        const optionsPath = configured && configured.trim() ? configured.trim() : resolveOptionsPath();
        return readRenderEngineState(optionsPath || undefined);
    }

    private autoRevertEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('mcdev-tools')
            .get<boolean>('renderEngine.autoRevertOnExit', true);
    }

    /** 记录 OpenGL 状态下的图形模式（简约/精美），供自动/手动回退时恢复 */
    private rememberOpenGLGraphicsMode(): void {
        if (!this.state.exists || this.state.mode !== 'opengl') {
            return;
        }
        void this.context.globalState.update(
            PREVIOUS_GRAPHICS_MODE_KEY,
            clampOpenGLGraphicsMode(this.state.graphicsMode)
        );
    }

    private previousGraphicsMode(): number {
        const stored = this.context.globalState.get<number>(PREVIOUS_GRAPHICS_MODE_KEY);
        return clampOpenGLGraphicsMode(typeof stored === 'number' ? stored : FANCY_GRAPHICS_MODE);
    }

    /** options.txt 由游戏自己写，游戏内切换渲染龙后这里能第一时间看到 */
    private watchOptionsFile(): void {
        const target = this.state.optionsPath || resolveOptionsPath();
        if (!target) {
            return;
        }
        if (this.watchedPath && this.watchedPath !== target) {
            fs.unwatchFile(this.watchedPath, this.onOptionsFileChanged);
            this.watchedPath = undefined;
        }
        if (this.watchedPath !== target) {
            fs.watchFile(target, { interval: OPTIONS_WATCH_INTERVAL_MS, persistent: false }, this.onOptionsFileChanged);
            this.watchedPath = target;
        }
    }

    private syncWatcher(): void {
        const shouldWatch = this.autoRevertEnabled() && this.state.exists && this.state.mode === 'renderdragon';
        if (shouldWatch && !this.timer && !this.disposed) {
            this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
            this.timer.unref?.();
        } else if (!shouldWatch && this.timer) {
            this.stopWatcher();
        }
    }

    private stopWatcher(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * 渲染龙状态下的守卫：
     * - 游戏还在跑：保持渲染龙，等它退出；
     * - 游戏已经不在跑（正常退出、闪退、或本来就没启动）：写回 OpenGL。
     */
    private async poll(): Promise<void> {
        if (this.disposed || this.reverting) {
            return;
        }
        const alive = await isMinecraftProcessAlive().catch(() => false);
        if (this.disposed || alive) {
            return;
        }

        this.reverting = true;
        try {
            await delay(REVERT_SETTLE_MS);
            if (this.disposed) {
                return;
            }
            // 等待期间用户可能又启动了游戏（重启流程），此时不能回退
            if (await isMinecraftProcessAlive().catch(() => false)) {
                return;
            }

            const result = applyRenderEngine('opengl', this.state.optionsPath, this.previousGraphicsMode());
            if (!result.ok) {
                console.warn('[renderEngine] 自动切回 OpenGL 失败', result.error);
                return;
            }

            this.state = result.state ?? this.readState();
            this.syncWatcher();
            this.emit();
            void vscode.window.showInformationMessage('游戏已关闭，渲染引擎已自动切回 OpenGL。');
        } finally {
            this.reverting = false;
        }
    }

    private describeApplyError(result: ApplyRenderEngineResult): string {
        if (result.error === 'options-not-found') {
            return '找不到 Minecraft 的 options.txt，无法切换渲染引擎。';
        }
        if (result.error === 'no-options-path') {
            return '未找到 %APPDATA%，无法定位 Minecraft 的 options.txt。';
        }
        return `切换渲染引擎失败：${result.error ?? '未知错误'}`;
    }

    private emit(): void {
        if (!this.disposed) {
            this.emitter.fire(this.getStatus());
        }
    }
}
