import * as vscode from 'vscode';
import { getNonce } from '../utils';

export type HostBridgeWebviewView = 'game-debugger' | 'perf-monitor' | 'studio';

export interface WebviewPageOptions {
    /** 浏览器标签标题，同时用于调试辅助识别 */
    title: string;
    /** 前端入口通过 body[data-view] 选择要渲染的 React 根组件 */
    view: HostBridgeWebviewView;
    /** 仅性能监测窗口使用：打开后是否自动开始采样 */
    autoStart?: boolean;
}

/**
 * 生成 Host Bridge 系列 Webview 的 HTML 外壳。
 * 游戏调试面板与独立的性能监测窗口共用同一份前端产物（sidebar.js / sidebar.css），
 * 靠 body 的 data-view 属性区分渲染哪一屏，避免多打一个 bundle。
 */
export function buildWebviewPage(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    options: WebviewPageOptions
): string {
    const nonce = getNonce();
    const language = vscode.env.language.startsWith('zh') ? 'zh' : 'en';
    const webviewPath = vscode.Uri.joinPath(extensionUri, 'out', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'sidebar.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'sidebar.css'));
    const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewPath, 'codicons', 'codicon.css'));

    const bodyAttributes = [`data-view="${options.view}"`];
    if (options.autoStart !== undefined) {
        bodyAttributes.push(`data-autostart="${options.autoStart ? 'true' : 'false'}"`);
    }

    return `<!doctype html>
<html lang="${language}">
<head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${options.title}</title>
    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
</head>
<body ${bodyAttributes.join(' ')}>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
