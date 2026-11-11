import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isMinecraftAddonWorkspace } from './utils';
import { McDevToolsSidebarProvider } from './sidebar';
import { dynamicLibraryManager } from './native/dynamicLibraryManager';
import { GameDebuggerPanel, HostBridgeManager, PerfMonitorPanel, PreparedHostBridgeLaunch } from './hostBridge';
import { shutdownAllNativeProfilerCaptures } from './hostBridge/nativeProfilerCapture';
import { McdevConfigStore } from './config';
import { 
    McDevToolsDebugConfigurationProvider,
    McdbgDebugConfigurationProvider,
    ptvsd
} from './debugger';

let extensionContext: vscode.ExtensionContext;
let mcdevConfigStore: McdevConfigStore | undefined;
let hostBridgeManager: HostBridgeManager | undefined;
let gameDebuggerPanel: GameDebuggerPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('Minecraft ModPC Debug 插件已激活');
    extensionContext = context;

    mcdevConfigStore = new McdevConfigStore();
    context.subscriptions.push(mcdevConfigStore);
    hostBridgeManager = await HostBridgeManager.create(context, mcdevConfigStore);
    context.subscriptions.push(hostBridgeManager);
    // 面板样式：studio = 只保留性能采集相关页签（自用默认），full = 原作者的多页签调试面板
    const debugViewStyle = vscode.workspace.getConfiguration('mcdev-tools').get<string>('debugView.style', 'studio');
    gameDebuggerPanel = new GameDebuggerPanel(
        context.extensionUri,
        hostBridgeManager,
        debugViewStyle === 'full' ? 'full' : 'studio'
    );
    context.subscriptions.push(gameDebuggerPanel);
    // 次级侧边栏（辅助侧边栏）里的停靠视图，和编辑器页签共用同一套调试逻辑
    const gameDebuggerView = vscode.window.registerWebviewViewProvider(
        'mcdev-tools.debugView',
        {
            resolveWebviewView: (view: vscode.WebviewView) => {
                gameDebuggerPanel?.resolveWebviewView(view);
            }
        },
        { webviewOptions: { retainContextWhenHidden: true } }
    );
    context.subscriptions.push(gameDebuggerView);
    registerGameDebuggerAutoOpen(context);
    registerPerfMonitorAutoOpen(context);

    // 初始化 ptvsd 持久化存储
    ptvsd.initStorage(context);

    // 根据用户设置或项目结构决定是否启用插件功能
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const config = vscode.workspace.getConfiguration('mcdev-tools');
    const userEnabled = config.get<boolean>('enable', false);
    const isAddon = workspaceFolder ? isMinecraftAddonWorkspace(workspaceFolder) : false;
    const pluginEnabled = userEnabled || isAddon;

    // 设置上下文
    vscode.commands.executeCommand('setContext', 'mcdev-tools:enabled', pluginEnabled);
    vscode.commands.executeCommand('setContext', 'mcdev-tools:showSidebar', pluginEnabled);

    // 只有启用时才注册侧边栏提供器
    if (pluginEnabled) {
        const sidebarProvider = new McDevToolsSidebarProvider(context.extensionUri, mcdevConfigStore);
        const sidebarDisp = vscode.window.registerWebviewViewProvider('mcdev-tools.sidebar', sidebarProvider);
        context.subscriptions.push(sidebarProvider, sidebarDisp);
        console.log('McDevToolsSidebarProvider 已注册');
    }

    // 注册命令
    registerCommands(context);
    
    // 注册调试配置提供者
    registerDebugProviders(context);
    
    // 监听调试会话结束事件
    registerDebugSessionListener(context);
}

/**
 * 注册所有命令
 */
function registerCommands(context: vscode.ExtensionContext): void {
    // 启动调试命令
    const startDebugCmd = vscode.commands.registerCommand('mcdev-tools.startDebug', async () => {
        await startDebugSession();
    });

    // 侧边栏面板回退命令
    const panelCmd = vscode.commands.registerCommand('mcdev-tools.showSidebarPanel', async () => {
        await showSidebarPanel(context);
    });

    // 运行游戏命令 (Ctrl+F5)
    const runCmd = vscode.commands.registerCommand('mcdev-tools.runGame', async () => {
        await runMcdk();
    });

    const openGameDebuggerCmd = vscode.commands.registerCommand('mcdev-tools.openGameDebugger', () => {
        openGameDebugger();
    });

    // 独立性能监测窗口（启动游戏后会自动打开，也可以手动打开）
    const openPerfMonitorCmd = vscode.commands.registerCommand('mcdev-tools.openPerfMonitor', () => {
        openPerfMonitor({ autoStart: true });
    });

    context.subscriptions.push(startDebugCmd, panelCmd, runCmd, openGameDebuggerCmd, openPerfMonitorCmd);
}

/**
 * 打开（或聚焦）独立性能监测窗口。
 */
function openPerfMonitor(options: { autoStart?: boolean } = {}): void {
    if (!hostBridgeManager) {
        return;
    }
    PerfMonitorPanel.show(extensionContext.extensionUri, hostBridgeManager, options);
}

let autoOpenedDebuggerSessionId: string | undefined;

/**
 * 按设置打开「游戏调试」面板：默认在编辑器区单开一个页签，也可以改成停靠到次级侧边栏。
 */
function openGameDebugger(options: { fallbackToEditor?: boolean } = {}): void {
    const surface = vscode.workspace.getConfiguration('mcdev-tools').get<string>('gameDebugger.surface', 'auxiliarybar');
    if (surface === 'editor') {
        gameDebuggerPanel?.show();
        return;
    }
    void vscode.commands.executeCommand('mcdev-tools.debugView.focus');
    if (!options.fallbackToEditor) {
        return;
    }
    // 停靠视图有时还没来得及被 VS Code 解析出来（辅助侧边栏被收起/容器被关掉），
    // 那就退回编辑器页签，保证「自动打开」这件事一定发生。
    setTimeout(() => {
        if (!gameDebuggerPanel?.hasSurface) {
            gameDebuggerPanel?.show();
        }
    }, 1200);
}

/**
 * 游戏进入 game_ready 后自动打开「游戏调试」面板（位置由 gameDebugger.surface 决定），
 * 里面已经包含代码执行、UI 调试、性能监测等页签。
 * 关掉 mcdev-tools.gameDebugger.autoOpen 即可恢复成手动打开。
 */
function registerGameDebuggerAutoOpen(context: vscode.ExtensionContext): void {
    if (!hostBridgeManager) {
        return;
    }
    const subscription = hostBridgeManager.onDidChange(snapshot => {
        if (!vscode.workspace.getConfiguration('mcdev-tools').get<boolean>('gameDebugger.autoOpen', true)) {
            return;
        }
        const readySession = snapshot.sessions.find(
            session => session.connected && session.state === 'game_ready'
        );
        if (!readySession || readySession.id === autoOpenedDebuggerSessionId) {
            return;
        }
        autoOpenedDebuggerSessionId = readySession.id;
        openGameDebugger({ fallbackToEditor: true });
    });
    context.subscriptions.push(subscription);
    // 插件激活/重载窗口时游戏可能早就是 game_ready 了，不会再有状态变化事件，这里补一次即时检查
    maybeAutoOpenDebugger();
    const retry = setTimeout(() => maybeAutoOpenDebugger(), 3000);
    context.subscriptions.push({ dispose: () => clearTimeout(retry) });
}

/**
 * 立即检查一次当前 Host Bridge 快照，如果游戏已就绪且还没自动打开过，就打开面板。
 */
function maybeAutoOpenDebugger(): void {
    if (!hostBridgeManager) {
        return;
    }
    if (!vscode.workspace.getConfiguration('mcdev-tools').get<boolean>('gameDebugger.autoOpen', true)) {
        return;
    }
    const snapshot = hostBridgeManager.getSnapshot();
    const readySession = snapshot.sessions.find(
        session => session.connected && session.state === 'game_ready'
    );
    if (!readySession || readySession.id === autoOpenedDebuggerSessionId) {
        return;
    }
    autoOpenedDebuggerSessionId = readySession.id;
    openGameDebugger({ fallbackToEditor: true });
}

let autoOpenedPerfSessionId: string | undefined;

/**
 * 游戏进入 game_ready（Host Bridge 会话连上并确认游戏已就绪）后，自动弹出独立的性能监测窗口，
 * 省掉「点游戏调试 → 切到性能监测页签」这一步。
 * 可用 mcdev-tools.perfMonitor.autoOpen / autoStart 两个设置关闭。
 */
function registerPerfMonitorAutoOpen(context: vscode.ExtensionContext): void {
    if (!hostBridgeManager) {
        return;
    }
    const readConfig = () => vscode.workspace.getConfiguration('mcdev-tools');
    const subscription = hostBridgeManager.onDidChange(snapshot => {
        if (!readConfig().get<boolean>('perfMonitor.autoOpen', true)) {
            return;
        }
        const readySession = snapshot.sessions.find(
            session => session.connected && session.state === 'game_ready'
        );
        if (!readySession || readySession.id === autoOpenedPerfSessionId) {
            return;
        }
        autoOpenedPerfSessionId = readySession.id;
        openPerfMonitor({ autoStart: readConfig().get<boolean>('perfMonitor.autoStart', true) });
    });
    context.subscriptions.push(subscription);
}

/**
 * 注册调试配置提供者
 */
function registerDebugProviders(context: vscode.ExtensionContext): void {
    // ptvsd 模式 provider（推荐）
    if (!hostBridgeManager) {
        throw new Error('Host Bridge manager is not initialized');
    }
    const ptvsdProvider = new McDevToolsDebugConfigurationProvider(context.extensionPath, hostBridgeManager);
    const ptvsdProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        'mcdev-tools',
        ptvsdProvider
    );

    // mcdbg 注入模式 provider
    const mcdbgProvider = new McdbgDebugConfigurationProvider(context.extensionPath);
    const mcdbgProviderDisposable = vscode.debug.registerDebugConfigurationProvider(
        'mcdev-tools-inject',
        mcdbgProvider
    );

    // 注册动态调试配置提供者（用于 F5 无配置启动，默认使用 ptvsd）
    const dynamicProvider = vscode.debug.registerDebugConfigurationProvider(
        'mcdev-tools',
        {
            provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
                return [
                    {
                        type: 'mcdev-tools',
                        request: 'launch',
                        name: 'Minecraft Python Debug',
                        dapConfig: {
                            justMyCode: false
                        }
                    }
                ];
            }
        },
        vscode.DebugConfigurationProviderTriggerKind.Dynamic
    );

    context.subscriptions.push(ptvsdProviderDisposable, mcdbgProviderDisposable, dynamicProvider);
}

/**
 * 注册调试会话监听器
 */
function registerDebugSessionListener(context: vscode.ExtensionContext): void {
    // 监听调试会话结束，清理 ptvsd 会话
    const debugEndDisposable = vscode.debug.onDidTerminateDebugSession((session) => {
        // ptvsd 会话会在进程退出时自动清理
        console.log(`调试会话结束: ${session.name}`);
    });

    context.subscriptions.push(debugEndDisposable);
}

/**
 * 启动调试会话（从 GUI 按钮调用）
 * 总是启动新实例，不检查重新附加
 */
async function startDebugSession(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('请先打开工作区');
        return;
    }

    // 使用 launchNewInstance 直接启动，不走 provider 的重新附加逻辑
    if (!hostBridgeManager) {
        throw new Error('Host Bridge manager is not initialized');
    }
    const config = await ptvsd.launchNewInstance(extensionContext.extensionPath, hostBridgeManager);
    if (config) {
        await vscode.debug.startDebugging(workspaceFolder, config);
    }
}

/**
 * 显示侧边栏面板（回退方案）
 */
async function showSidebarPanel(context: vscode.ExtensionContext): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        'mcdevSidebarPanel', 
        'Minecraft (.mcdev.json)', 
        vscode.ViewColumn.One, 
        { enableScripts: true }
    );
    
    if (!hostBridgeManager) {
        throw new Error('Host Bridge manager is not initialized');
    }
    if (!mcdevConfigStore) {
        throw new Error('.mcdev.json configuration store is not initialized');
    }
    const provider = new McDevToolsSidebarProvider(context.extensionUri, mcdevConfigStore);
    provider.resolveWebviewPanel(panel);
    context.subscriptions.push(provider);
}

/**
 * 运行 mcdk.exe（无调试模式，Ctrl+F5）
 */
async function runMcdk(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('请先打开工作区');
        return;
    }

    const config = vscode.workspace.getConfiguration('mcdev-tools');
    const mcdkPathConfig = config.get<string>('mcdkPath', '');

    const mcdkPath = mcdkPathConfig
        ? (path.isAbsolute(mcdkPathConfig)
            ? mcdkPathConfig
            : path.join(workspaceFolder.uri.fsPath, mcdkPathConfig))
        : path.join(extensionContext.extensionPath, 'bin', 'native', 'windows', 'x64', 'mcdk.exe');

    if (!fs.existsSync(mcdkPath)) {
        vscode.window.showErrorMessage(`找不到 mcdk.exe: ${mcdkPath}`);
        return;
    }

    // 检查是否已有 Minecraft 进程在运行（sub 模式）
    const mcRunning = await ptvsd.isModpcRunning();

    // 不设置 ptvsd 环境变量，正常启动（无调试）
    const env: NodeJS.ProcessEnv = { 
        ...process.env,
        MCDEV_IS_PLUGIN_ENV: '1',
        MCDEV_OUTPUT_MODE: '1'
    };

    let bridgeLaunch: PreparedHostBridgeLaunch | undefined;
    if (hostBridgeManager) {
        try {
            bridgeLaunch = await hostBridgeManager.prepareLaunch(workspaceFolder.uri.fsPath);
            if (bridgeLaunch) {
                Object.assign(env, bridgeLaunch.environment);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Host Bridge 启动失败，本次游戏将不启用代码控制台: ${message}`);
        }
    }

    // 如果已有 Minecraft 进程，启用子进程模式
    if (mcRunning) {
        console.log('检测到已存在的 Minecraft 进程，启用子进程模式');
        env['MCDEV_IS_SUBPROCESS_MODE'] = '1';
    }

    // 使用 Terminal 直接执行 exe（支持颜色和实时输出）
    let terminal: vscode.Terminal;
    try {
        terminal = vscode.window.createTerminal({
            name: 'Minecraft ModPC (mcdk)',
            shellPath: mcdkPath,
            cwd: workspaceFolder.uri.fsPath,
            env: env,
            // 不要在重载窗口后恢复这个终端：扩展升级换了目录后旧路径会失效，恢复时报“shell 可执行文件路径不存在”
            isTransient: true
        });
    } catch (error) {
        if (bridgeLaunch && hostBridgeManager) {
            hostBridgeManager.releaseLaunch(bridgeLaunch.registrationId);
        }
        throw error;
    }
    if (bridgeLaunch && hostBridgeManager) {
        hostBridgeManager.trackTerminal(bridgeLaunch.registrationId, terminal);
    }

    terminal.show(true);
    vscode.window.showInformationMessage('Minecraft ModPC 已启动（无调试）');
}

export async function deactivate(): Promise<void> {
    const panel = gameDebuggerPanel;
    const bridgeManager = hostBridgeManager;
    const configStore = mcdevConfigStore;
    gameDebuggerPanel = undefined;
    hostBridgeManager = undefined;
    mcdevConfigStore = undefined;

    try {
        ptvsd.cleanupAllSessions();
        vscode.commands.executeCommand('setContext', 'mcdev-tools:enabled', false);
        vscode.commands.executeCommand('setContext', 'mcdev-tools:showSidebar', false);
        try {
            await panel?.disposeAsync();
        } catch (error) {
            console.error('Failed to dispose the game debugger panel', error);
        }
        try {
            await bridgeManager?.disposeAsync();
        } catch (error) {
            console.error('Failed to dispose the Host Bridge manager', error);
        }
        try {
            configStore?.dispose();
        } catch (error) {
            console.error('Failed to dispose the .mcdev.json configuration store', error);
        }
    } finally {
        try {
            await shutdownAllNativeProfilerCaptures(extensionContext.extensionPath);
        } finally {
            await dynamicLibraryManager.unloadAll();
        }
    }
}
