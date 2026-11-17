/**
 * 渲染引擎 options.txt 读写
 *
 * 网易 3.9 起渲染龙（RenderDragon）与 OpenGL 合并为同一个包体，默认 OpenGL；
 * 游戏把当前引擎记录在 %APPDATA%\MinecraftPE_Netease\minecraftpe\options.txt：
 *   gfx_renderengine = 0 (OpenGL) / 1 (RenderDragon)
 *   graphics_mode    = 2 时是「灵动视效」（deferred），切回 OpenGL 时恢复到进入前的模式
 *
 * 这里只做纯粹的文本/文件处理，方便单元测试；进程监听与 VS Code 交互放在 index.ts。
 */

import * as fs from 'fs';
import * as path from 'path';

export type RenderEngineMode = 'opengl' | 'renderdragon';

export interface RenderEngineState {
    mode: RenderEngineMode;
    graphicsMode: number;
    optionsPath: string;
    exists: boolean;
}

/** 游戏目录：%APPDATA%\MinecraftPE_Netease\minecraftpe */
export function resolveOptionsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const appData = env.APPDATA;
    if (!appData) {
        return undefined;
    }
    return path.join(appData, 'MinecraftPE_Netease', 'minecraftpe', 'options.txt');
}

const RENDER_ENGINE_KEY = 'gfx_renderengine';
const GRAPHICS_MODE_KEY = 'graphics_mode';

/** 灵动视效在 graphics_mode 里的取值（0 简约 / 1 精美 / 2 灵动视效 / 3 光线追踪） */
export const VIBRANT_GRAPHICS_MODE = 2;
export const FANCY_GRAPHICS_MODE = 1;

/** 把 graphics_mode 收敛到 OpenGL 引擎支持的范围，避免把灵动视效 / 光追模式留给 OpenGL */
export function clampOpenGLGraphicsMode(value: number | undefined): number {
    if (!Number.isFinite(value) || value === undefined || value === null) {
        return FANCY_GRAPHICS_MODE;
    }
    const mode = Math.trunc(value as number);
    return mode === 0 ? 0 : FANCY_GRAPHICS_MODE;
}

/** 渲染引擎目标值；切回 OpenGL 时恢复进入渲染龙前的图形模式 */
export function buildRenderEngineValues(
    mode: RenderEngineMode,
    openGLGraphicsMode: number = FANCY_GRAPHICS_MODE
): Record<string, string> {
    if (mode === 'renderdragon') {
        return {
            [RENDER_ENGINE_KEY]: '1',
            [GRAPHICS_MODE_KEY]: String(VIBRANT_GRAPHICS_MODE)
        };
    }
    return {
        [RENDER_ENGINE_KEY]: '0',
        [GRAPHICS_MODE_KEY]: String(clampOpenGLGraphicsMode(openGLGraphicsMode))
    };
}

interface SplitOptions {
    lines: string[];
    eol: string;
    trailingNewline: boolean;
}

function splitOptions(text: string): SplitOptions {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const trailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
    if (trailingNewline) {
        lines.pop();
    }
    return { lines, eol, trailingNewline };
}

function parseOptionLines(lines: readonly string[]): Map<string, string> {
    const values = new Map<string, string>();
    for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            continue;
        }
        values.set(line.slice(0, separator).trim(), line.slice(separator + 1));
    }
    return values;
}

/**
 * 只改动传入的键：保留原有行、顺序、CRLF 与结尾换行；缺失的键追加到文件末尾。
 */
export function setOptionValues(
    text: string,
    values: Record<string, string>
): { text: string; changed: boolean } {
    const { lines, eol, trailingNewline } = splitOptions(text);
    const pending = new Map(Object.entries(values));
    let changed = false;

    const nextLines = lines.map(line => {
        const separator = line.indexOf(':');
        if (separator <= 0) {
            return line;
        }
        const key = line.slice(0, separator).trim();
        if (!pending.has(key)) {
            return line;
        }
        const value = pending.get(key)!;
        pending.delete(key);
        if (line.slice(separator + 1) === value) {
            return line;
        }
        changed = true;
        return `${key}:${value}`;
    });

    for (const [key, value] of pending) {
        nextLines.push(`${key}:${value}`);
        changed = true;
    }

    const nextText = nextLines.join(eol) + (trailingNewline ? eol : '');
    return { text: nextText, changed };
}

export function parseRenderEngineState(text: string, optionsPath: string): RenderEngineState {
    const values = parseOptionLines(splitOptions(text).lines);
    const engineValue = values.get(RENDER_ENGINE_KEY);
    const rawGraphicsMode = Number(values.get(GRAPHICS_MODE_KEY));
    return {
        mode: engineValue === '1' ? 'renderdragon' : 'opengl',
        graphicsMode: Number.isFinite(rawGraphicsMode) ? rawGraphicsMode : 0,
        optionsPath,
        exists: true
    };
}

export interface RenderEngineFileRead {
    state: RenderEngineState;
    text?: string;
}

/** 读取 options.txt 中任意一项（例如 keyboard_type_0_key.toggleRenderer） */
export function readOptionValue(optionsPath: string, key: string): string | undefined {
    try {
        const text = fs.readFileSync(optionsPath, 'utf8');
        return parseOptionLines(splitOptions(text).lines).get(key);
    } catch {
        return undefined;
    }
}

/** 读取 options.txt；文件不存在时返回 exists:false，而不是抛错 */
export function readRenderEngineFile(optionsPath?: string): RenderEngineFileRead {
    const target = optionsPath ?? resolveOptionsPath();
    if (!target) {
        return {
            state: { mode: 'opengl', graphicsMode: 0, optionsPath: '', exists: false }
        };
    }
    try {
        const text = fs.readFileSync(target, 'utf8');
        return { state: parseRenderEngineState(text, target), text };
    } catch {
        return {
            state: { mode: 'opengl', graphicsMode: 0, optionsPath: target, exists: false }
        };
    }
}

export function readRenderEngineState(optionsPath?: string): RenderEngineState {
    return readRenderEngineFile(optionsPath).state;
}

export interface ApplyRenderEngineResult {
    ok: boolean;
    state?: RenderEngineState;
    changed?: boolean;
    error?: string;
}

function writeOptionsFile(optionsPath: string, text: string): void {
    const tempPath = `${optionsPath}.mcdev-tmp`;
    try {
        fs.writeFileSync(tempPath, text, 'utf8');
        fs.renameSync(tempPath, optionsPath);
    } catch (error) {
        try {
            fs.unlinkSync(tempPath);
        } catch {
            // temp 文件可能根本没写出来，忽略即可
        }
        throw error;
    }
}

/** 写入渲染引擎设置；游戏运行期间不要调用（游戏退出时会覆盖 options.txt） */
export function applyRenderEngine(
    mode: RenderEngineMode,
    optionsPath?: string,
    openGLGraphicsMode: number = FANCY_GRAPHICS_MODE
): ApplyRenderEngineResult {
    const target = optionsPath ?? resolveOptionsPath();
    if (!target) {
        return { ok: false, error: 'no-options-path' };
    }

    let text: string;
    try {
        text = fs.readFileSync(target, 'utf8');
    } catch {
        return { ok: false, error: 'options-not-found' };
    }

    const next = setOptionValues(text, buildRenderEngineValues(mode, openGLGraphicsMode));
    if (!next.changed) {
        return { ok: true, changed: false, state: parseRenderEngineState(text, target) };
    }

    try {
        writeOptionsFile(target, next.text);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, changed: true, state: parseRenderEngineState(next.text, target) };
}
