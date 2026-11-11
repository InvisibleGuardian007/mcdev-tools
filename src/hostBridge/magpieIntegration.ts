import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 通过 Magpie（https://github.com/InvisibleGuardian007/mcdev-tools 之外的外部工具）把
 * mcdk 的 MCP 端点注册进 Magpie 库，再由 Magpie 分发给各个 Agent。
 *
 * 这样做的好处：只维护一份「minecraft 端点」，Claude Code / Codex / DSH / WorkBuddy / ZCode
 * 的配置都由 Magpie 的 library sync 统一下发，扩展不用逐个去改各家的配置文件。
 *
 * 本模块只做「拼参数 / 找可执行文件 / 跑一次 CLI / 解析输出」，不依赖 vscode。
 */

export const DEFAULT_SERVER_NAME = 'minecraft';

/** 默认下发到的 Agent（Magpie 认得的名字） */
export const DEFAULT_MAGPIE_AGENTS = ['claude', 'codex', 'dsh', 'workbuddy', 'zcode'];

const DEFAULT_TIMEOUT_MS = 60_000;

export interface MagpieAddOptions {
    /** 库里登记的服务器名，默认 minecraft */
    name?: string;
    /** 下发给哪些 agent；留空用 DEFAULT_MAGPIE_AGENTS */
    agents?: string[];
}

/** magpie library mcp add minecraft <url> agents=a,b,c */
export function buildMagpieAddArgs(url: string, options: MagpieAddOptions = {}): string[] {
    const name = (options.name || DEFAULT_SERVER_NAME).trim() || DEFAULT_SERVER_NAME;
    const agents = options.agents && options.agents.length ? options.agents : DEFAULT_MAGPIE_AGENTS;
    return ['library', 'mcp', 'add', name, url.trim(), `agents=${agents.join(',')}`];
}

/** magpie library sync —— 把库里的东西重新写进各 agent */
export function buildMagpieSyncArgs(): string[] {
    return ['library', 'sync'];
}

/** magpie library mcp show <name> —— 读回一条服务器配置 */
export function buildMagpieShowArgs(name: string = DEFAULT_SERVER_NAME): string[] {
    return ['library', 'mcp', 'show', name];
}

/**
 * Magpie 输出里的「✓ written into claude, codex, dsh」→ ['claude','codex','dsh']
 * 只认 written into 后面的名字，避免把无关行的单词当成 agent。
 */
export function parseWrittenAgents(output: string): string[] {
    const agents: string[] = [];
    const seen = new Set<string>();
    for (const line of String(output || '').split(/\r?\n/)) {
        const match = /written into\s+(.+)$/i.exec(line);
        if (!match) {
            continue;
        }
        for (const raw of match[1].split(/[,;\s]+/)) {
            const name = raw.trim().replace(/[.。]+$/, '');
            if (!name || name.startsWith('C:') || /^[A-Za-z]:$/.test(name)) {
                continue;
            }
            const key = name.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            agents.push(name);
        }
    }
    return agents;
}

/**
 * 找到 Magpie 可执行文件。顺序：显式配置 → 环境变量 MAGPIE_PATH / MAGPIE_EXE → PATH → 常见安装位置。
 * 只返回真实存在的文件（Windows 上不区分大小写，按 resolve 后去重）。
 */
export function listMagpieExecutables(env: NodeJS.ProcessEnv = process.env, extra: string[] = []): string[] {
    const candidates: string[] = [];
    const push = (value?: string) => {
        const trimmed = (value || '').trim().replace(/^"|"$/g, '');
        if (trimmed) {
            candidates.push(trimmed);
        }
    };

    extra.forEach(item => push(item));
    push(env.MAGPIE_PATH);
    push(env.MAGPIE_EXE);

    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (dir.trim()) {
            candidates.push(path.join(dir.trim(), 'magpie.exe'));
        }
    }

    const local = env.LOCALAPPDATA;
    const roaming = env.APPDATA;
    const home = env.USERPROFILE || env.HOME || os.homedir();
    if (local) {
        push(path.join(local, 'magpie', 'magpie.exe'));
        push(path.join(local, 'Programs', 'magpie', 'magpie.exe'));
        push(path.join(local, 'Programs', 'Magpie', 'magpie.exe'));
        push(path.join(local, 'Programs', 'magpie', 'magpie-windows-amd64.exe'));
    }
    if (roaming) {
        push(path.join(roaming, 'magpie', 'magpie.exe'));
    }
    if (home) {
        push(path.join(home, 'magpie.exe'));
        push(path.join(home, 'Downloads', 'magpie-windows-amd64.exe'));
        push(path.join(home, 'Downloads', 'magpie.exe'));
    }

    const found: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        let key: string;
        try {
            key = path.resolve(candidate).toLowerCase();
        } catch {
            continue;
        }
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        try {
            if (fs.statSync(candidate).isFile()) {
                found.push(candidate);
            }
        } catch {
            // 不存在就是没找到，继续看下一个候选
        }
    }
    return found;
}

export interface MagpieRunResult {
    ok: boolean;
    /** stdout + stderr 合并后的文本（给用户看/做解析） */
    output: string;
    /** 明确的失败分类：missing/exe / timeout / failed */
    errorCode?: 'missingExe' | 'timeout' | 'failed';
}

/** 跑一次 magpie CLI。超时/失败都不抛异常，统一返回 MagpieRunResult */
export function runMagpie(exePath: string, args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<MagpieRunResult> {
    return new Promise(resolve => {
        execFile(
            exePath,
            args,
            { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
            (error, stdout, stderr) => {
                const output = [stdout, stderr].filter(Boolean).join('\n').trim();
                if (!error) {
                    resolve({ ok: true, output });
                    return;
                }
                const err = error as NodeJS.ErrnoException & { killed?: boolean };
                const timedOut = err.killed === true || /ETIMEDOUT/i.test(String(err.code || ''));
                resolve({
                    ok: false,
                    output: output || err.message,
                    errorCode: err.code === 'ENOENT' ? 'missingExe' : timedOut ? 'timeout' : 'failed'
                });
            }
        );
    });
}

/**
 * Windows 的「App Paths」——双击运行过的 exe 会在这里留下一条记录，
 * 是这台机器上最可靠、最快的「Magpie 装在哪」来源（比全盘搜索便宜得多）。
 */
export function detectMagpieFromRegistry(): Promise<string | undefined> {
    return new Promise(resolve => {
        if (process.platform !== 'win32') {
            resolve(undefined);
            return;
        }
        const script = [
            '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
            "$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths');",
            'foreach($r in $roots){',
            '  if(Test-Path $r){',
            "    Get-ChildItem $r | Where-Object { $_.PSChildName -like 'magpie*' } | ForEach-Object {",
            "      $v=(Get-Item $_.PSPath).GetValue('');",
            '      if($v){ Write-Output $v }',
            '    }',
            '  }',
            '}',
        ].join(' ');
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 8000, windowsHide: true, encoding: 'utf8' },
            (error, stdout) => {
                if (error) {
                    resolve(undefined);
                    return;
                }
                const found = String(stdout || '')
                    .split(/\r?\n/)
                    .map(item => item.trim())
                    .filter(item => /\.exe$/i.test(item))
                    .find(item => {
                        try {
                            return fs.statSync(item).isFile();
                        } catch {
                            return false;
                        }
                    });
                resolve(found);
            }
        );
    });
}

/** 从正在运行的 magpie 进程里读路径（用户常常是双击下载目录里的 exe 在用） */
export function detectRunningMagpieExecutable(): Promise<string | undefined> {
    return new Promise(resolve => {
        if (process.platform !== 'win32') {
            resolve(undefined);
            return;
        }
        const script =
            "(Get-Process magpie* -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)";
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 8000, windowsHide: true, encoding: 'utf8' },
            (error, stdout) => {
                if (error) {
                    resolve(undefined);
                    return;
                }
                const line = String(stdout || '')
                    .split(/\r?\n/)
                    .map(item => item.trim())
                    .find(item => item.length > 0);
                resolve(line && /\.exe$/i.test(line) ? line : undefined);
            }
        );
    });
}

/**
 * 依次尝试：用户配置 → 环境变量 / PATH / 常见安装位置 → Windows App Paths 注册表 → 正在运行的进程。
 * 都找不到就返回 undefined，由调用方给出「在设置里指定路径」的提示。
 */
export async function resolveMagpieExecutable(preferred?: string): Promise<string | undefined> {
    const candidates = listMagpieExecutables(process.env, preferred ? [preferred] : []);
    if (candidates.length) {
        return candidates[0];
    }
    const fromRegistry = await detectMagpieFromRegistry();
    if (fromRegistry) {
        return fromRegistry;
    }
    return detectRunningMagpieExecutable();
}
