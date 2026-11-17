/**
 * 打开原版设置页（供调试开关使用）。
 *
 * 关键点：不能用 `gui.push_screen` 打开设置页。实测这样打开的页面没有原生屏幕代理，
 * 左侧缺少「调试」分类，右侧内容为空，看起来是错乱界面。
 * 必须先进入暂停菜单，再用真实鼠标点「设置」——游戏只认真实 Windows 鼠标事件。
 *
 * 打开后由 debugSwitches.ts 生成的脚本在已打开的设置页里切换 Toggle。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildClickScript } from '../renderEngine/inGameSwitch';
import { HostBridgeManager } from './manager';

const SETTINGS_SCREEN = 'settings.screen_world_controls_and_settings';
const PAUSE_SCREEN = 'pause.pause_screen';
const PAUSE_SETTINGS_BUTTON = '/variables_button_mappings_and_controls/safezone_screen_matrix/inner_matrix'
    + '/safezone_screen_panel/root_screen_panel/pause_screen_main_panels/menu/the_rest_panel/pause_menu'
    + '/menu_button_control/menu_background/button_panel/settings_button';

interface DebugSettingsProbe {
    settingsOpen: boolean;
    pauseOpen: boolean;
    pos?: [number, number];
    size?: [number, number];
    ui?: [number, number];
    client?: [number, number];
    error?: string;
}

export interface EnsureDebugSettingsResult {
    ok: boolean;
    error?: string;
}

function pyString(value: string): string {
    return JSON.stringify(value);
}

export function buildDebugSettingsProbeCode(): string {
    return [
        'import gui',
        `_s=${pyString(SETTINGS_SCREEN)};_p=${pyString(PAUSE_SCREEN)}`,
        '_btn=' + pyString(PAUSE_SETTINGS_BUTTON),
        '_screens=gui.get_all_screen_fullnames() or []',
        "_out={'settingsOpen':_s in _screens,'pauseOpen':_p in _screens}",
        'if not _out["settingsOpen"] and _out["pauseOpen"]:',
        ' try:',
        '  _out["pos"]=gui.get_global_position(_p,_btn)',
        '  _out["size"]=gui.get_size(_p,_btn)',
        ' except Exception as _e:',
        '  _out["error"]=str(_e)',
        ' try:',
        '  _out["ui"]=gui.get_client_ui_screen_size()',
        '  _out["client"]=gui.get_client_screen_size()',
        ' except Exception as _e:',
        '  _out["error2"]=str(_e)',
        '_result=_out',
    ].join('\n');
}

/**
 * 尝试完全不用鼠标打开设置页：进暂停菜单后拿「设置」按钮的 button id，
 * 用游戏内的 simulate_button_event 触发。成功就完全不抢鼠标；
 * 失败（游戏丢弃合成事件）再退回真实点击。
 */
export function buildOpenSettingsViaControlCode(): string {
    return [
        'import gui,time',
        `_s=${pyString(SETTINGS_SCREEN)};_p=${pyString(PAUSE_SCREEN)}`,
        '_btn=' + pyString(PAUSE_SETTINGS_BUTTON),
        "_out={'settingsOpen':_s in (gui.get_all_screen_fullnames() or [])}",
        'if not _out["settingsOpen"]:',
        ' if _p not in (gui.get_all_screen_fullnames() or []):',
        '  try:gui.open_pause_gui(True)',
        '  except:pass',
        '  for _ in range(30):',
        '   if _p in (gui.get_all_screen_fullnames() or []):break',
        '   time.sleep(0.1)',
        ' _bid=None',
        ' try:',
        '  _bid=gui.get_button_id(_p,_btn)',
        ' except Exception as _e:',
        '  _out["error"]=str(_e)',
        ' if _bid is not None:',
        '  for _args in ((_p,_bid,0),(_p,_bid,1),(_bid,0),(_bid,1)):',
        '   try:gui.simulate_button_event(*_args)',
        '   except:pass',
        '   for _ in range(12):',
        '    if _s in (gui.get_all_screen_fullnames() or []):',
        '     _out["settingsOpen"]=True;break',
        '    time.sleep(0.1)',
        '   if _out["settingsOpen"]:break',
        '_result=_out',
    ].join('\n');
}

export function buildOpenPauseCode(): string {
    return [
        'import gui',
        `_p=${pyString(PAUSE_SCREEN)}`,
        'try:',
        ' if _p not in (gui.get_all_screen_fullnames() or []):',
        '  gui.open_pause_gui(True)',
        'except:',
        ' pass',
        '_result=True',
    ].join('\n');
}

function isNumberTuple(value: unknown): value is [number, number] {
    return Array.isArray(value)
        && value.length === 2
        && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

export function parseDebugSettingsProbe(value: unknown): DebugSettingsProbe | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    return {
        settingsOpen: record.settingsOpen === true,
        pauseOpen: record.pauseOpen === true,
        pos: isNumberTuple(record.pos) ? record.pos : undefined,
        size: isNumberTuple(record.size) ? record.size : undefined,
        ui: isNumberTuple(record.ui) ? record.ui : undefined,
        client: isNumberTuple(record.client) ? record.client : undefined,
        error: typeof record.error === 'string' ? record.error : undefined,
    };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 用真实鼠标点一下游戏窗口客户区坐标（与渲染引擎切换共用同一套点击脚本）。 */
export function clickGameClientPoint(x: number, y: number): Promise<boolean> {
    const scriptPath = path.join(os.tmpdir(), `mcdev-debug-switch-click-${Date.now()}.ps1`);
    return new Promise(resolve => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                fs.unlinkSync(scriptPath);
            } catch {
                // ignore
            }
            resolve(ok);
        };
        try {
            fs.writeFileSync(scriptPath, '﻿' + buildClickScript(x, y), 'utf8');
        } catch {
            resolve(false);
            return;
        }
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { windowsHide: true }
        );
        let stdout = '';
        child.stdout.on('data', chunk => {
            stdout += String(chunk);
        });
        child.stderr.on('data', () => undefined);
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }
            finish(false);
        }, 12_000);
        child.on('close', () => {
            clearTimeout(timer);
            finish(stdout.indexOf('clicked') >= 0);
        });
    });
}

async function readProbe(manager: HostBridgeManager, sessionId: string): Promise<DebugSettingsProbe | undefined> {
    const raw = await manager.executeCode(sessionId, buildDebugSettingsProbeCode(), true);
    return parseDebugSettingsProbe(raw);
}

/**
 * 确保设置页已经以「原生方式」打开。
 * 已手动打开则直接复用；否则进暂停菜单并真实点击「设置」。
 */
export async function ensureDebugSettingsOpen(
    manager: HostBridgeManager,
    sessionId: string
): Promise<EnsureDebugSettingsResult> {
    let probe = await readProbe(manager, sessionId);
    if (!probe) {
        return { ok: false, error: 'probe-failed' };
    }
    if (probe.settingsOpen) {
        return { ok: true };
    }

    if (!probe.pauseOpen) {
        await manager.executeCode(sessionId, buildOpenPauseCode(), true);
        // 暂停菜单是异步构建的，实测要 2~3 秒，轮询而不是定死 900ms
        for (let attempt = 0; attempt < 12 && !probe.pauseOpen; attempt += 1) {
            await delay(250);
            probe = await readProbe(manager, sessionId);
            if (!probe) {
                return { ok: false, error: 'probe-failed' };
            }
        }
    }
    if (probe.settingsOpen) {
        return { ok: true };
    }
    if (!probe.pauseOpen) {
        return { ok: false, error: 'pause-unavailable' };
    }

    // 先尝试纯控件方式触发暂停菜单里的「设置」按钮，不移动鼠标。
    // 游戏若丢弃合成事件会返回未打开，再走下面的真实点击兜底。
    try {
        const raw = await manager.executeCode(sessionId, buildOpenSettingsViaControlCode(), true);
        const controlProbe = parseDebugSettingsProbe(raw);
        if (controlProbe?.settingsOpen) {
            probe = await readProbe(manager, sessionId);
            if (probe?.settingsOpen) {
                return { ok: true };
            }
        }
    } catch {
        // 合成事件不可用时继续用真实点击
    }

    // 真实点击期间用户动一下鼠标就可能点空，所以最多重试一次
    for (let attempt = 0; attempt < 2; attempt += 1) {
        probe = await readProbe(manager, sessionId);
        if (probe?.settingsOpen) {
            return { ok: true };
        }
        if (!probe?.pos || !probe.size || !probe.ui || !probe.client
            || probe.ui[0] <= 0 || probe.ui[1] <= 0) {
            if (attempt === 1) {
                return { ok: false, error: 'settings-point-unavailable' };
            }
            await delay(600);
            continue;
        }
        const scaleX = probe.client[0] / probe.ui[0];
        const scaleY = probe.client[1] / probe.ui[1];
        const x = Math.round((probe.pos[0] + probe.size[0] / 2) * scaleX);
        const y = Math.round((probe.pos[1] + probe.size[1] / 2) * scaleY);
        if (!(await clickGameClientPoint(x, y))) {
            if (attempt === 1) {
                return { ok: false, error: 'click-failed' };
            }
            await delay(600);
            continue;
        }

        // 设置页加载同样是异步的，轮询最多 5 秒
        for (let poll = 0; poll < 20; poll += 1) {
            await delay(250);
            probe = await readProbe(manager, sessionId);
            if (probe?.settingsOpen) {
                return { ok: true };
            }
        }
    }
    return { ok: false, error: 'settings-not-open' };
}
