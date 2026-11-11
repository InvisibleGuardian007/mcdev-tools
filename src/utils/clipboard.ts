import * as vscode from 'vscode';

/** 复制失败只当作没复制成功，不抛错：调用方负责把结果告诉界面。 */
export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await vscode.env.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
