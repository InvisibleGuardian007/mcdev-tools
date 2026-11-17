import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 面板宿主（次级侧边栏视图 / 编辑器页签）的定位日志。
 *
 * 自动打开「性能调试」面板时，视图是否被 VS Code 解析、兜底是否抢占了编辑器页签，
 * 全靠 VS Code 异步回调，光看界面无法判断。这里把关键节点追加写到工作区
 * `.mcdev/host-surface.log`，出问题时可以直接读文件定位。
 */

const MAX_LOG_BYTES = 512 * 1024;
const LOG_RELATIVE = path.join('.mcdev', 'host-surface.log');

function resolveLogFile(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        return path.join(folder.uri.fsPath, LOG_RELATIVE);
    }
    // 没打开工作区时也要留痕：退到系统临时目录，事后总能找到
    return path.join(os.tmpdir(), 'mcdev-host-surface.log');
}

function rotateIfNeeded(file: string): void {
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_LOG_BYTES) {
            fs.writeFileSync(file, '', 'utf8');
        }
    } catch {
        // 文件还不存在，忽略
    }
}

/** 追加一行定位日志；任何失败都静默（日志不能影响主流程）。 */
export function traceSurface(event: string, extra?: Record<string, unknown>): void {
    const file = resolveLogFile();
    if (!file) {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        rotateIfNeeded(file);
        const detail = extra ? ' ' + JSON.stringify(extra) : '';
        fs.appendFileSync(file, `${new Date().toISOString()} ${event}${detail}\n`, 'utf8');
    } catch {
        // 忽略
    }
}
