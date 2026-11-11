import * as vscode from 'vscode';
import { HostBridgeManager } from './manager';
import { PerfMonitorController } from './perfMonitorController';
import { buildWebviewPage } from './webviewPage';
import { DisposableLike } from './types';

/**
 * 独立的「性能监测」窗口。
 * 与游戏调试面板里的「性能监测」页签共用同一套 Webview 前端和宿主采样控制器，
 * 但挂在单独的 WebviewPanel 上：启动游戏后自动在侧边打开并且自动开始采样，
 * 用户不用先点「游戏调试」再翻页签。窗口标签可以直接拖出成 VS Code 浮动窗口。
 */
export class PerfMonitorPanel implements vscode.Disposable {
    private static current: PerfMonitorPanel | undefined;

    private readonly controller: PerfMonitorController;
    private readonly disposables: DisposableLike[] = [];
    private disposed = false;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly hostBridgeManager: HostBridgeManager,
        extensionUri: vscode.Uri,
        autoStart: boolean
    ) {
        this.controller = new PerfMonitorController(extensionUri.fsPath, hostBridgeManager);
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'perf.png');
        panel.webview.html = buildWebviewPage(panel.webview, extensionUri, {
            title: 'MC Dev Tools - 性能监测',
            view: 'perf-monitor',
            autoStart
        });
        this.disposables.push(
            panel.webview.onDidReceiveMessage(message => {
                void this.handleMessage(message);
            }),
            hostBridgeManager.onDidChange(snapshot => {
                this.controller.reconcile(snapshot);
                void panel.webview.postMessage({ type: 'hostBridgeState', snapshot });
            }),
            panel.onDidDispose(() => {
                void this.disposeAsync();
            })
        );
    }

    /**
     * 打开（或聚焦已打开的）性能监测窗口。
     * autoStart 为 true 时，前端拿到可用会话后自动开始采样。
     */
    public static show(
        extensionUri: vscode.Uri,
        hostBridgeManager: HostBridgeManager,
        options: { autoStart?: boolean } = {}
    ): PerfMonitorPanel {
        const current = PerfMonitorPanel.current;
        if (current) {
            current.panel.reveal(undefined, true);
            return current;
        }

        const panel = vscode.window.createWebviewPanel(
            'mcdev-tools.perfMonitor',
            'MC Dev Tools - 性能监测',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        const instance = new PerfMonitorPanel(
            panel,
            hostBridgeManager,
            extensionUri,
            options.autoStart !== false
        );
        PerfMonitorPanel.current = instance;
        return instance;
    }

    public dispose(): void {
        this.panel.dispose();
    }

    private async handleMessage(message: any): Promise<void> {
        if (!message || typeof message.type !== 'string' || this.disposed) {
            return;
        }
        if (message.type === 'ready') {
            await this.panel.webview.postMessage({
                type: 'hostBridgeState',
                snapshot: this.hostBridgeManager.getSnapshot()
            });
            return;
        }
        if (message.type.startsWith('perfMonitor')) {
            await this.controller.handleMessage(this.panel.webview, message);
        }
    }

    private async disposeAsync(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        PerfMonitorPanel.current = undefined;
        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
        await this.controller.disposeAsync();
    }
}
