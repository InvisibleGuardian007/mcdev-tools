import { execFile } from 'child_process';

/**
 * 进程存活探测：宿主记住的会话到底还对应不存在的游戏 / mcdk 进程。
 * 只依赖 node 内置能力，不引 vscode，方便单测。
 */

/** 游戏进程的镜像名（网易 MCStudio 的基岩版客户端）。 */
export const MINECRAFT_IMAGE_NAME = 'Minecraft.Windows.exe';
/** mcdk 启动器的镜像名。 */
export const MCDK_IMAGE_NAME = 'mcdk.exe';

/**
 * pid 是否还活着。
 * EPERM 表示进程存在但没权限（例如系统进程），仍按「活着」处理，避免误删会话。
 */
export function isProcessAlive(pid: number | undefined | null): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * 解析 `tasklist /FO CSV /NH` 的输出，取第二列（PID）。
 * 没有匹配时 tasklist 只打印一行本地化提示（不是 CSV），此时返回空数组。
 */
export function parseTasklistCsv(text: string): number[] {
    const pids: number[] = [];
    for (const line of text.split(/\r?\n/)) {
        const columns = line.match(/"[^"]*"/g);
        if (!columns || columns.length < 2) {
            continue;
        }
        const pid = Number(columns[1].replace(/"/g, '').trim());
        if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) {
            pids.push(pid);
        }
    }
    return pids;
}

/** 用 tasklist 列出某个镜像名的所有 pid；非 Windows 或调用失败时返回空数组。 */
export function listProcessPids(imageName: string, timeoutMs = 4_000): Promise<number[]> {
    if (process.platform !== 'win32') {
        return Promise.resolve([]);
    }
    return new Promise<number[]>(resolve => {
        // 探测要足够轻，失败也不该冒泡到 UI，所以这里吞掉 error。
        execFile(
            'tasklist',
            ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 },
            (error, stdout) => resolve(error || !stdout ? [] : parseTasklistCsv(stdout))
        );
    });
}

/** 扫描本机正在跑的游戏 / mcdk 进程。 */
export async function probeGameProcesses(): Promise<{ minecraftPids: number[]; mcdkPids: number[] }> {
    const [minecraftPids, mcdkPids] = await Promise.all([
        listProcessPids(MINECRAFT_IMAGE_NAME),
        listProcessPids(MCDK_IMAGE_NAME)
    ]);
    return { minecraftPids, mcdkPids };
}
