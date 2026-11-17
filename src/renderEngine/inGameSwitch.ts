/**
 * 游戏内切换渲染引擎（OpenGL ↔ 渲染龙 + 灵动视效）
 *
 * 实测结论（网易 3.10.0.448891 / 1.21.130）：
 * - 游戏外把 options.txt 写成渲染龙再启动必定闪退，只能游戏内切换；
 * - 渲染引擎与图形模式都通过「设置 → 视频」页的原版下拉框切换，两步都会重载渲染器；
 * - 全流程只依赖真实 UI 控件树（gui/_gui 的控件名、属性、位置、滚动、toggle API），
 *   不再有任何写死的像素坐标、固定格子数量或「拖滚动条」假设。
 *
 * 控件树关键路径（实测）：
 *   settings.screen_world_controls_and_settings
 *     .../settings_common.dialog_content/selector_area/.../controls_and_settings_selector_pane/video_button
 *     .../settings_common.dialog_content/content_area/.../general_and_controls_sections/video_section
 *         /rendering_engine/.../dropdown/rendering_engine_dropdown        ← 渲染引擎
 *         /advanced_graphics_options_panel/graphics_mode/.../graphics_mode_dropdown ← 图形模式
 *   两个下拉的选项浮层都是同级的 dropdown_content/scroll/.../radio_control_group。
 *
 * 交互方式：
 * - 选左侧「视频」、滚动左右两栏、展开下拉，全部用控件 API（set_toggle_state_new /
 *   set_scroll_view_percent_value），不产生鼠标事件；
 * - 选项行是 collection 模板实例（路径里都是 {ui_control}，无法按名字区分），
 *   所以按「下拉浮层的真实高度 ÷ 选项数」推出目标行的真实位置，再用窗口消息点击该点。
 *   位置来自控件树，不是写死的坐标。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RenderEngineMode, readRenderEngineState } from './options';

export type ExecuteGameCode = (code: string) => Promise<unknown>;

/** 宿主的原生「打开设置页」回调（暂停菜单 → 真实点击设置）。 */
export type EnsureSettingsOpen = () => Promise<{
    ok: boolean;
    error?: string;
    message?: string;
}>;

export type InGameSwitchFailure =
    | 'game-not-running'
    | 'no-window'
    | 'not-in-world'
    | 'script-failed'
    | 'timeout'
    | 'not-switched'
    | 'graphics-not-switched';

export interface InGameSwitchResult {
    ok: boolean;
    failure?: InGameSwitchFailure;
    message?: string;
}

const SCRIPT_TIMEOUT_MS = 45_000;
/** 读日志判断「是否在游戏内」时最多回看的字节数 */
const LOG_TAIL_BYTES = 32_768;

// ---------------------------------------------------------------------------
// 日志辅助
// ---------------------------------------------------------------------------

export function resolveDebugLogDir(): string {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'MinecraftPE_Netease', 'logs');
}

export function findLatestDebugLog(dir = resolveDebugLogDir()): string | undefined {
    try {
        const entries = fs.readdirSync(dir).filter(name => name.indexOf('Debug_Log') === 0 && name.endsWith('.txt'));
        let best: string | undefined;
        let bestTime = -1;
        for (const name of entries) {
            const full = path.join(dir, name);
            try {
                const stat = fs.statSync(full);
                if (stat.mtimeMs > bestTime) {
                    bestTime = stat.mtimeMs;
                    best = full;
                }
            } catch {
                // 游戏可能正在轮转日志，忽略
            }
        }
        return best;
    } catch {
        return undefined;
    }
}

export function readLogFromOffset(file: string, offset: number): string {
    try {
        const stat = fs.statSync(file);
        const start = Math.max(0, Math.min(offset, stat.size));
        const length = stat.size - start;
        if (length <= 0) {
            return '';
        }
        const fd = fs.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(length, 256 * 1024));
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
            return buffer.slice(0, bytes).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}

function readLogTail(file: string, byteCount = LOG_TAIL_BYTES): string {
    try {
        const size = fs.statSync(file).size;
        return readLogFromOffset(file, Math.max(0, size - byteCount));
    } catch {
        return '';
    }
}

/**
 * 判断游戏当前是否在存档里（而不是停在菜单）。
 * 日志会记录输入映射切换：进入存档是 gamePlayNormal，打开菜单/设置是 screen。
 */
export function isInWorld(logFile: string | undefined): boolean {
    if (!logFile) {
        return false;
    }
    const matches = readLogTail(logFile).match(/Pushing input mapping: '([^']+)'/g);
    if (!matches || matches.length === 0) {
        return false;
    }
    return matches[matches.length - 1].indexOf('gamePlayNormal') >= 0;
}

export type GameScreen = 'world' | 'pause' | 'settings' | 'other';

/**
 * 用真实界面列表判断游戏当前停在哪个界面。
 *
 * 日志尾部会被性能统计行刷屏（每 5 秒一行 AnimatedModelBatchPerf），
 * 靠日志猜界面并不可靠，所以优先直接问游戏：gui.get_all_screen_fullnames()。
 */
export function buildQueryScreenCode(): string {
    return [
        'import gui',
        '_result={"screens":gui.get_all_screen_fullnames()}'
    ].join('\n');
}

/** 把真实界面列表归类成流程需要的界面种类 */
export function classifyScreens(names: readonly string[]): GameScreen {
    const has = (target: string): boolean => names.indexOf(target) >= 0;
    const looksCustom = names.some(name => (
        name.indexOf('settings.screen_world_controls_and_settings') !== 0
        && name.indexOf('pause.pause_screen') !== 0
        && name.indexOf('hud.hud_screen') !== 0
        && name.indexOf('toast_screen.') !== 0
        && name.indexOf('debug_screen.') !== 0
        && name.indexOf('progress.') !== 0
    ));
    if (looksCustom) {
        return 'other';
    }
    if (has('settings.screen_world_controls_and_settings')) {
        return 'settings';
    }
    if (has('pause.pause_screen')) {
        return 'pause';
    }
    if (has('hud.hud_screen')) {
        return 'world';
    }
    return 'other';
}

/**
 * 原版界面白名单（前缀匹配）。
 *
 * 日志里同一个 screen 会带不同的子页后缀，例如
 *   'settings.screen_world_controls_and_settings - video_tab'
 *   'progress.modal_progress_screen - load_options'
 * 所以按前缀判断，避免把原版子页误判成模组自定义界面。
 */
const KNOWN_GUI_PREFIXES = [
    'pause.pause_screen',
    'settings.screen_world_controls_and_settings',
    'hud.hud_screen',
    'toast_screen.toast_screen',
    'debug_screen.debug_screen',
    'progress.modal_progress_screen',
    'progress.world_loading_progress_screen',
    'play_screen.play_screen',
    'start_screen.start_screen'
];

function isKnownGui(name: string): boolean {
    return KNOWN_GUI_PREFIXES.some(prefix => name === prefix || name.indexOf(prefix + ' - ') === 0);
}

function hasUnknownTopGui(logFile: string): boolean {
    const tail = readLogTail(logFile, 64 * 1024);
    const created = [...tail.matchAll(/Created '([^']+)' screen/g)].map(match => match[1]);
    const destroyed = new Set(
        [...tail.matchAll(/Destroyed '([^']+)' screen/g)].map(match => match[1].replace(/ - .*/, ''))
    );
    for (let index = created.length - 1; index >= 0; index -= 1) {
        const name = created[index];
        if (destroyed.has(name.replace(/ - .*/, ''))) {
            continue;
        }
        return !isKnownGui(name);
    }
    return false;
}

/**
 * 判断游戏当前停在哪个界面。
 * 日志里 GUI 行会记录界面的创建与销毁，取最近一次事件即可判断当前界面。
 */
export function detectScreen(logFile: string | undefined): GameScreen {
    if (!logFile) {
        return 'other';
    }
    const tail = readLogTail(logFile, 128 * 1024);
    if (!tail) {
        return 'other';
    }
    // 日志兜底：出现未识别的顶层界面就停手，避免在模组界面上乱点
    if (hasUnknownTopGui(logFile)) {
        return 'other';
    }
    const lastIndex = (needle: string): number => tail.lastIndexOf(needle);
    const pauseCreated = lastIndex("Created 'pause.pause_screen'");
    const pauseDestroyed = lastIndex("Destroyed 'pause_screen'");
    const settingsCreated = lastIndex("Created 'settings.screen_world_controls_and_settings'");
    const settingsDestroyed = lastIndex("Destroyed 'screen_world_controls_and_settings");
    if (settingsCreated >= 0 && settingsCreated > settingsDestroyed) {
        return 'settings';
    }
    if (pauseCreated >= 0 && pauseCreated > pauseDestroyed) {
        return 'pause';
    }
    if (isInWorld(logFile)) {
        return 'world';
    }
    return 'other';
}

// ---------------------------------------------------------------------------
// 控件树路径
// ---------------------------------------------------------------------------

const SETTINGS_SCREEN = 'settings.screen_world_controls_and_settings';
const PAUSE_SCREEN = 'pause.pause_screen';

/** 原版设置页 dialog_content（左右两栏的共同父节点） */
const DIALOG = '/variables_button_mappings_and_controls/safezone_screen_matrix/inner_matrix/safezone_screen_panel'
    + '/root_screen_panel/stack_panel/content_panel/container/settings_common.dialog_content';
const LEFT_SELECTOR_AREA = DIALOG + '/selector_area/scrolling_panel';
const RIGHT_CONTROL_AREA = DIALOG + '/content_area/control/scrolling_panel';

/**
 * 滚动容器名的候选。
 *
 * 原版设置页的滚动容器名会随输入模式变化：
 *   触摸/鼠标模拟 → scroll_touch
 *   原生鼠标        → scroll_mouse
 * 两者下面的 scroll_view 结构完全一致，所以必须运行期探测，不能写死。
 */
export const SCROLL_CONTAINER_CANDIDATES = ['scroll_mouse', 'scroll_touch'];

/**
 * scroll_view 下层的包裹控件名。
 * 老版本是 panel，3.10 的部分会话会变成 stack_panel，两种情况都要支持。
 */
export const SCROLL_WRAPPER_CANDIDATES = ['panel', 'stack_panel'];

/** 拼一个「滚动容器下的 scroll_view」路径列表，供游戏内脚本按顺序探测 */
export function scrollViewCandidates(scrollPanelPath: string): string[] {
    return SCROLL_CONTAINER_CANDIDATES.map(name => `${scrollPanelPath}/${name}/scroll_view`);
}

/** 左栏 pane 后缀（scrolling_content 之后的部分） */
const LEFT_PANE_SUFFIX = '/settings.selector_stack_panel/controls_and_settings_selector_pane';
const VIDEO_BUTTON_TOGGLE_SUFFIX = '/video_button/video_button_toggle';
const VIDEO_SECTION_SUFFIX = '/general_and_controls_sections/video_section';

/** 渲染引擎下拉相对 video_section 的路径 */
const ENGINE_DROPDOWN_SUFFIX = '/rendering_engine/option_generic_core/two_line_layout'
    + '/settings_common.option_dropdown_control/dropdown/rendering_engine_dropdown';
/** 图形模式下拉相对 video_section 的路径 */
const GRAPHICS_DROPDOWN_SUFFIX = '/advanced_graphics_options_panel/graphics_mode'
    + '/option_generic_core/two_line_layout/settings_common.option_dropdown_control/dropdown/graphics_mode_dropdown';

/** 暂停菜单里的「设置」按钮 */
const PAUSE_SETTINGS_BUTTON = '/variables_button_mappings_and_controls/safezone_screen_matrix/inner_matrix'
    + '/safezone_screen_panel/root_screen_panel/pause_screen_main_panels/menu/the_rest_panel/pause_menu'
    + '/menu_button_control/menu_background/button_panel/settings_button';

/**
 * 从下拉控件路径推出它旁边的选项浮层路径。
 * 两个下拉的浮层都是 dropdown/ 下的兄弟节点 dropdown_content，结构固定。
 */
export function dropdownContentPath(dropdownPath: string): string {
    return dropdownPath.replace(/\/[^/]+$/, '/dropdown_content');
}

/**
 * 从下拉控件路径推出它显示的当前值 label 路径。
 * 原版下拉框的未选中态模板固定为 unchecked，标签在 label_panel/label。
 */
export function dropdownLabelPath(dropdownPath: string): string {
    return dropdownPath
        + '/unchecked/button_panel/button_content'
        + '/settings_common.default_options_dropdown_toggle_button_state_content/label_panel/label';
}

/**
 * 选项浮层里选项内容区的候选路径（含滚动容器名变体）。
 * 结构：dropdown_content/scroll/<scroll_mouse|scroll_touch>/scroll_view
 *       /panel/background_and_viewport/scrolling_view_port/scrolling_content
 */
export function dropdownOptionsContentCandidates(contentPath: string): string[] {
    const candidates: string[] = [];
    for (const view of scrollViewCandidates(contentPath + '/scroll')) {
        for (const wrapper of SCROLL_WRAPPER_CANDIDATES) {
            candidates.push(view + '/' + wrapper + '/background_and_viewport/scrolling_view_port/scrolling_content');
        }
    }
    return candidates;
}

/** 选项行所在的 radio 模板组候选（每个选项一个 `{ui_control}` 实例） */
export function dropdownOptionsGroupCandidates(contentPath: string): string[] {
    return dropdownOptionsContentCandidates(contentPath).map(c => c + '/radio_control_group');
}

/**
 * 两处下拉的「首选」绝对路径（按 scroll_mouse 展开）。
 *
 * 真正执行时这些路径都会在游戏内按实际滚动容器重新解析（见 PATH_RESOLVER）；
 * 这里只用于生成纯函数输出和单元测试。
 */
const FIRST_SCROLL_CONTAINER = SCROLL_CONTAINER_CANDIDATES[0];
const FIRST_SCROLL_WRAPPER = SCROLL_WRAPPER_CANDIDATES[0];
const FIRST_VIDEO_SECTION = `${RIGHT_CONTROL_AREA}/${FIRST_SCROLL_CONTAINER}/scroll_view/${FIRST_SCROLL_WRAPPER}`
    + '/background_and_viewport/scrolling_view_port/scrolling_content' + VIDEO_SECTION_SUFFIX;
const DROPDOWN_PATHS: Record<DropdownKey, string> = {
    engine_dropdown: FIRST_VIDEO_SECTION + ENGINE_DROPDOWN_SUFFIX,
    graphics_dropdown: FIRST_VIDEO_SECTION + GRAPHICS_DROPDOWN_SUFFIX
};

/** 取某个下拉的首选绝对路径（纯函数辅助，测试与脚本生成共用） */
export function primaryDropdownPath(which: DropdownKey): string {
    return DROPDOWN_PATHS[which];
}

/** 取首选候选（不探测，供不需要容错的调用方使用） */
export function dropdownOptionsContentPath(contentPath: string): string {
    return dropdownOptionsContentCandidates(contentPath)[0];
}

/** 取首选候选（不探测） */
export function dropdownOptionsGroupPath(contentPath: string): string {
    return dropdownOptionsGroupCandidates(contentPath)[0];
}

// ---------------------------------------------------------------------------
// 脚本生成（纯函数，便于测试）
// ---------------------------------------------------------------------------

function pyString(value: string): string {
    return JSON.stringify(value);
}

/**
 * 注入到每段脚本开头的「路径解析」辅助。
 *
 * 原版设置页的滚动容器名会随输入模式在 scroll_mouse / scroll_touch 之间变化，
 * 所以路径一律在游戏内运行期解析，不写死。
 * 解析结果缓存在模块级 dict 里，避免每次调用都重新遍历控件树。
 */
const PATH_RESOLVER = [
    'import _gui',
    `_SCROLL_CANDIDATES=${JSON.stringify(SCROLL_CONTAINER_CANDIDATES)}`,
    `_LEFT_AREA=${pyString(LEFT_SELECTOR_AREA)}`,
    `_RIGHT_AREA=${pyString(RIGHT_CONTROL_AREA)}`,
    `_LEFT_PANE_SUFFIX=${pyString(LEFT_PANE_SUFFIX)}`,
    `_VIDEO_TOGGLE_SUFFIX=${pyString(VIDEO_BUTTON_TOGGLE_SUFFIX)}`,
    `_VIDEO_SECTION_SUFFIX=${pyString(VIDEO_SECTION_SUFFIX)}`,
    `_WRAPPERS=${JSON.stringify(SCROLL_WRAPPER_CANDIDATES)}`,
    `_ENGINE_SUFFIX=${pyString(ENGINE_DROPDOWN_SUFFIX)}`,
    `_GRAPHICS_SUFFIX=${pyString(GRAPHICS_DROPDOWN_SUFFIX)}`,
    '_path_cache={}',
    'def _pick_scroll(s,panel):',
    ' # 先看哪个 scroll_view 下真的挂了内容，再用它',
    ' found=None',
    ' for name in _SCROLL_CANDIDATES:',
    '  cand=panel+"/"+name+"/scroll_view"',
    '  try:kids=_gui.get_children_name_from_parent(s,cand) or []',
    '  except:kids=[]',
    '  if kids:',
    '   found=cand',
    '   break',
    ' if found is None:',
    '  found=panel+"/"+_SCROLL_CANDIDATES[0]+"/scroll_view"',
    ' return found',
    'def _content(s,scroll):',
    ' for wrap in _WRAPPERS:',
    '  p=scroll+"/"+wrap+"/background_and_viewport/scrolling_view_port/scrolling_content"',
    '  try:kids=_gui.get_children_name_from_parent(s,p) or []',
    '  except:kids=[]',
    '  if kids:return p',
    ' return None',
    'def settings_paths(s):',
    ' if s in _path_cache:return _path_cache[s]',
    ' left=_pick_scroll(s,_LEFT_AREA)',
    ' right=_pick_scroll(s,_RIGHT_AREA)',
    ' left_content=_content(s,left)',
    ' right_content=_content(s,right)',
    ' d={}',
    ' d["left_scroll"]=left',
    ' d["right_scroll"]=right',
    ' d["left_content"]=left_content',
    ' d["right_content"]=right_content',
    ' d["video_toggle"]=None if left_content is None else left_content+_LEFT_PANE_SUFFIX+_VIDEO_TOGGLE_SUFFIX',
    ' d["video_section"]=None if right_content is None else right_content+_VIDEO_SECTION_SUFFIX',
    ' d["engine_dropdown"]=None if d["video_section"] is None else d["video_section"]+_ENGINE_SUFFIX',
    ' d["graphics_dropdown"]=None if d["video_section"] is None else d["video_section"]+_GRAPHICS_SUFFIX',
    ' _path_cache[s]=d',
    ' return d',
    'def dropdown_paths(s,dropdown):',
    ' key="dd:"+dropdown',
    ' if key in _path_cache:return _path_cache[key]',
    ' content=dropdown[:dropdown.rfind("/")]+"/dropdown_content"',
    ' inner=None',
    ' group=None',
    ' base=content+"/scroll"',
    ' for name in _SCROLL_CANDIDATES:',
    '  for wrap in _WRAPPERS:',
    '   cand=base+"/"+name+"/scroll_view/"+wrap+"/background_and_viewport/scrolling_view_port/scrolling_content"',
    '   try:kids=_gui.get_children_name_from_parent(s,cand) or []',
    '   except:kids=[]',
    '   if kids:',
    '    inner=cand',
    '    group=cand+"/radio_control_group"',
    '    break',
    '  if inner is not None:break',
    ' if inner is None:',
    '  inner=base+"/"+_SCROLL_CANDIDATES[0]+"/scroll_view/"+_WRAPPERS[0]+"/background_and_viewport/scrolling_view_port/scrolling_content"',
    '  group=inner+"/radio_control_group"',
    ' d={"content":content,"inner":inner,"group":group}',
    ' _path_cache[key]=d',
    ' return d'
].join('\n');

/**
 * 确认设置页已经打开。
 *
 * 注意：这里绝不能 `gui.push_screen`。实测这样压出来的设置页没有原生屏幕代理，
 * 左侧缺「调试」分类、右侧空白，看起来就是错乱界面。
 * 设置页由宿主走「暂停菜单 → 真实点击设置」的原生流程打开，本脚本只负责等待。
 */
export function buildOpenSettingsCode(): string {
    return buildWaitSettingsCode();
}

/**
 * 点开暂停菜单里的「设置」按钮后，等设置页出现。
 * 与 buildOpenSettingsCode 分开，因为点击要由宿主用窗口消息完成。
 */
export function buildWaitSettingsCode(): string {
    return [
        'import gui,time',
        `SETTINGS=${pyString(SETTINGS_SCREEN)}`,
        'ok=False',
        'for _ in range(40):',
        ' if SETTINGS in gui.get_all_screen_fullnames():',
        '  ok=True;break',
        ' time.sleep(0.1)',
        'if not ok:raise RuntimeError("settings-screen-not-opened")',
        '_result={"opened":True}'
    ].join('\n');
}

/**
 * 脚本里共用的辅助函数：可见性判断、几何换算、滚动到目标控件可见。
 * 注入到每段代码开头，避免重复。
 *
 * 注意：这里不定义鼠标模拟。选项行只能靠窗口消息点击，而窗口消息需要
 * PowerShell 侧执行，所以点击一律由 buildPickOptionCode 返回的坐标交给宿主完成。
 */
const COMMON_HELPERS = [
    'def visible(s,p):',
    ' try:return bool(gui.get_visible(s,p))',
    ' except:return False',
    'def pos_size(s,p):',
    ' a=gui.get_global_position(s,p);z=gui.get_size(s,p)',
    ' return a,z',
    'def ui_scale():',
    ' return gui.get_gui_scale()',
    'def screen_h():',
    ' return gui.get_client_ui_screen_size()[1]',
    'def fully_visible(s,p):',
    ' if not visible(s,p):return False',
    ' try:a,z=pos_size(s,p)',
    ' except:return False',
    ' if not z or z[0]<=0 or z[1]<=0:return False',
    ' return a[1]>=0 and (a[1]+z[1])<=screen_h()',
    'def scroll_until_visible(s,scroll,target,steps=21):',
    ' if fully_visible(s,target):return True',
    ' for i in range(steps):',
    '  gui.set_scroll_view_percent_value(s,scroll,int(round(i*100.0/(steps-1))))',
    '  if fully_visible(s,target):return True',
    ' return False'
].join('\n');

/**
 * 选择左侧「视频」分类：直接设置 selector 的 toggle 状态，不产生鼠标事件。
 *
 * 路径在游戏内运行期解析（滚动容器名会随输入模式变化），
 * 并且会等「视频」按钮真正出现在控件树里再操作。
 */
export function buildSelectVideoTabCode(): string {
    return [
        'import gui,_gui,time',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        'if S not in gui.get_all_screen_fullnames():raise RuntimeError("settings-screen-not-open")',
        ' # 设置页刚打开/刚重载时控件树还在建，先等分类列表和「视频」按钮出现',
        'TOGGLE=None',
        'for _ in range(80):',
        ' p=settings_paths(S)["video_toggle"]',
        ' try:',
        '  z=gui.get_size(S,p)',
        '  if z and z[0]>0 and gui.get_visible(S,p):',
        '   TOGGLE=p;break',
        ' except:pass',
        ' # 内容没建好时清掉缓存，下一轮重新探测滚动容器名',
        ' _path_cache.clear()',
        ' time.sleep(0.1)',
        'if TOGGLE is None:raise RuntimeError("video-tab-control-missing")',
        'gui.set_toggle_state_new(S,TOGGLE,True)',
        'SECTION=settings_paths(S)["video_section"]',
        'ok=False',
        'for _ in range(60):',
        ' if gui.get_visible(S,SECTION):',
        '  ok=True;break',
        ' time.sleep(0.1)',
        'if not ok:raise RuntimeError("video-tab-not-selected")',
        '_result={"ok":True,"toggle":TOGGLE,"section":SECTION}'
    ].join('\n');
}

/** 两处下拉的键名，路径在游戏内运行期解析 */
export type DropdownKey = 'engine_dropdown' | 'graphics_dropdown';

export interface DropdownReadResult {
    label: string;
    options: string[];
}

/** 下拉浮层是否已经展开 */
export function buildDropdownOpenStateCode(which: DropdownKey): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        'DD=settings_paths(S)[W]',
        '_result={"open":bool(gui.get_visible(S,CONTENT))}'
    ].join('\n');
}

/**
 * 算出「点开这个下拉」的客户区像素点。
 *
 * 位置取下拉框自身的控件几何（UI 单位）乘 GUI 缩放，
 * 不依赖浮层是否已展开，所以浮层关闭时也能用。
 */
export function buildDropdownAnchorCode(which: DropdownKey): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        'DD=settings_paths(S)[W]',
        COMMON_HELPERS,
        'a,z=pos_size(S,DD)',
        'sc=ui_scale()',
        '_result={"x":int((a[0]+z[0]/2.0)*sc),"y":int((a[1]+z[1]/2.0)*sc),"w":z[0],"h":z[1]}'
    ].join('\n');
}

/**
 * 读取下拉框当前值。
 * 依次尝试 unchecked / checked 两种模板，取第一个非空 label。
 */
export function buildReadDropdownCode(which: DropdownKey): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        'DD=settings_paths(S)[W]',
        COMMON_HELPERS,
        'def label_of(state):',
        ' return DD+"/"+state+"/button_panel/button_content/settings_common.default_options_dropdown_toggle_button_state_content/label_panel/label"',
        'def shown(state):',
        ' # 只有「可见且占位」的状态模板才是下拉框真正在显示的那一个；',
        ' # 浮层展开时同名模板会同时存在于列表项里，不能只看文字。',
        ' p=label_of(state)',
        ' if not visible(S,p):return None',
        ' try:z=gui.get_size(S,p)',
        ' except:return None',
        ' if not z or z[0]<=0 or z[1]<=0:return None',
        ' try:v=gui.get_text(S,p)',
        ' except:return None',
        ' return v.strip() if v else None',
        'txt=None',
        'for st in ("checked","unchecked"):',
        ' v=shown(st)',
        ' if v:txt=v;break',
        '_result={"label":txt}'
    ].join('\n');
}

/**
 * 打开下拉并读出所有选项文案 + 选项浮层的真实几何。
 *
 * 选项行是 collection 模板实例，路径全是 {ui_control}，不能按名字定位；
 * 因此这里读出「下拉浮层的真实高度」和「选项个数」，由调用方据此换算目标行位置。
 */
export function buildOpenDropdownCode(which: DropdownKey): string {
    return [
        'import gui,_gui,time',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        'DD=settings_paths(S)[W]',
        'CONTENT=dropdown_paths(S,DD)["content"]',
        'INNER=dropdown_paths(S,DD)["inner"]',
        'GROUP=dropdown_paths(S,DD)["group"]',
        COMMON_HELPERS,
        'def survey():',
        ' # 选项行是 collection 模板实例：路径都叫 {ui_control}，API 无法按名字区分，',
        ' # 但它们共用一个路径，所以这里只能拿到「一份」行的几何，用它当行高。',
        ' # 真正的选项个数由 radio_control_group 的直接子节点数给出（每个选项一个实例）。',
        ' row=None',
        ' texts=[]',
        ' try:paths=gui.get_all_children_path_from_parent(S,GROUP) or []',
        ' except:paths=[]',
        ' for rel in paths:',
        '  if not rel.endswith("/radio_label"):continue',
        '  full="/variables_button_mappings_and_controls"+rel',
        '  try:z=gui.get_size(S,full)',
        '  except:continue',
        '  if not z or z[0]<=0 or z[1]<=0:continue',
        '  if row is None:row=z[1]',
        '  try:t=gui.get_text(S,full)',
        '  except:t=None',
        '  if t and t.strip() and t.strip() not in texts:texts.append(t.strip())',
        ' count=0',
        ' try:count=len(_gui.get_children_name_from_parent(S,GROUP) or [])',
        ' except:count=0',
        ' return row,texts,count',
        '# 展开浮层用控件 API：实测它可靠，而真实鼠标点在下拉本体上并不展开',
        'if gui.get_visible(S,CONTENT):',
        ' gui.set_toggle_state_new(S,DD,False)',
        ' time.sleep(0.1)',
        'if not gui.get_visible(S,CONTENT):',
        ' gui.set_toggle_state_new(S,DD,True)',
        ' opened=False',
        ' for _ in range(30):',
        '  if gui.get_visible(S,CONTENT):',
        '   opened=True;break',
        '  time.sleep(0.05)',
        ' if not opened:raise RuntimeError("dropdown-not-opened")',
        'time.sleep(0.15)',
        'a,z=pos_size(S,INNER)',
        '_row,_texts,_count=survey()',
        'count=_count or 1',
        'row=z[1]/float(count)',
        'if row<=0:row=1',
        '_result={"options":_texts,"count":count,"row":row,"x":a[0],"y":a[1],"w":z[0],"h":z[1],"scale":ui_scale()}'
    ].join('\n');
}

/**
 * 直接按下标选中下拉里的选项（不走鼠标）。
 *
 * radio_control_group 的每个选项都有独立的 radio_with_label_core（Toggle）路径，
 * `get_all_children_path_from_parent` 会按控件树顺序返回它们。
 * 第 index 个就是第 index 个选项：直接 set_toggle_state_new，不再依赖
 * 下拉的键盘焦点从哪一项开始（之前正是这里把「灵动视效」点成了「花式」）。
 */
export function buildPickRadioByPathCode(which: DropdownKey, index: number): string {
    const idx = Math.max(0, Math.min(63, Math.trunc(index)));
    return [
        'import gui,_gui,time',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        `IDX=${idx}`,
        'DD=settings_paths(S)[W]',
        'if DD is None:',
        " _result={'ok':False,'error':'dropdown-missing'}",
        'else:',
        ' CONTENT=dropdown_paths(S,DD)["content"]',
        ' GROUP=dropdown_paths(S,DD)["group"]',
        ' try:',
        '  if not gui.get_visible(S,CONTENT):',
        '   gui.set_toggle_state_new(S,DD,True)',
        '   for _ in range(40):',
        '    if gui.get_visible(S,CONTENT):break',
        '    time.sleep(0.05)',
        ' except:pass',
        ' toggles=[]',
        ' for _ in range(25):',
        '  try:paths=gui.get_all_children_path_from_parent(S,GROUP) or []',
        '  except:paths=[]',
        '  toggles=[p for p in paths if p.endswith("/radio_with_label_core")]',
        '  if len(toggles)>IDX:break',
        '  time.sleep(0.05)',
        ' if len(toggles)<=IDX:',
        "  _result={'ok':False,'error':'option-missing','count':len(toggles)}",
        ' else:',
        '  rel=toggles[IDX]',
        "  full=rel if rel.startswith('/') else '/variables_button_mappings_and_controls'+rel",
        '  try:',
        '   gui.set_toggle_state_new(S,full,True)',
        '  except Exception as _e:',
        "   _result={'ok':False,'error':'set-failed','detail':str(_e),'count':len(toggles),'path':full}",
        '  else:',
        '   try:_state=bool(gui.get_toggle_state(S,full))',
        '   except:_state=None',
        "   _result={'ok':_state==True,'value':_state,'count':len(toggles),'path':full}",
    ].join('\n');
}

/**
 * 把「下拉浮层里的第 index 行」换算成客户端像素并点一下。
 *
 * 浮层高度就是所有选项的总高（实测即 N×行高），所以第 index 行中心
 * = 浮层顶部 + (index + 0.5) × 行高，再乘 GUI 缩放得到客户区像素。
 */
export function buildPickOptionCode(which: DropdownKey, index: number, optionCount: number): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        `W=${pyString(which)}`,
        'DD=settings_paths(S)[W]',
        'CONTENT=dropdown_paths(S,DD)["content"]',
        'INNER=dropdown_paths(S,DD)["inner"]',
        COMMON_HELPERS,
        `INDEX=${Math.max(0, Math.trunc(index))}`,
        `COUNT=${Math.max(1, Math.trunc(optionCount))}`,
        'if not gui.get_visible(S,CONTENT):raise RuntimeError("dropdown-not-open")',
        'a,z=pos_size(S,INNER)',
        'sc=ui_scale()',
        'row=z[1]/float(COUNT)',
        'cx=int((a[0]+z[0]/2.0)*sc)',
        'cy=int((a[1]+(INDEX+0.5)*row)*sc)',
        '_result={"x":cx,"y":cy}'
    ].join('\n');
}

/**
 * 选项浮层的几何 -> 第 index 行的客户区像素坐标。
 * 由游戏内的控件树读出浮层位置与高度，行高按选项数均分。
 */
export function optionPointFromGeometry(
    geometry: { x: number; y: number; w: number; h: number; scale: number },
    index: number,
    optionCount: number,
    rowHeight?: number
): { x: number; y: number } {
    const count = Math.max(1, Math.trunc(optionCount));
    const row = rowHeight && rowHeight > 0 ? rowHeight : geometry.h / count;
    return {
        x: Math.round((geometry.x + geometry.w / 2) * geometry.scale),
        y: Math.round((geometry.y + (Math.max(0, Math.trunc(index)) + 0.5) * row) * geometry.scale)
    };
}

/**
 * 滚动右栏直到指定下拉控件完整可见。
 * 路径全部运行期解析，滚动停止条件是「目标控件真实可见」，不是固定步数。
 */
export function scrollToDropdownCode(which: DropdownKey): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        COMMON_HELPERS,
        `W=${pyString(which)}`,
        'P=settings_paths(S)',
        'ok=scroll_until_visible(S,P["right_scroll"],P[W])',
        ' # 滚到最底下，给展开的下拉留出空间，避免最后一个选项被屏幕边缘裁掉',
        'try:',
        ' gui.set_scroll_view_percent_value(S,P["right_scroll"],100)',
        'except:pass',
        '_result={"visible":bool(ok),"scroll":P["right_scroll"],"target":P[W]}'
    ].join('\n');
}

/** 读取当前目标状态：引擎标签 + 图形模式标签 */
export function buildReadLabelsCode(): string {
    return [
        'import gui',
        `S=${pyString(SETTINGS_SCREEN)}`,
        PATH_RESOLVER,
        'P=settings_paths(S)',
        'def lab(paths):',
        ' for p in paths:',
        '  try:v=gui.get_text(S,p)',
        '  except:v=None',
        '  if v and v.strip():return v.strip()',
        ' return None',
        'def both(dd):',
        ' base=dd+"/unchecked/button_panel/button_content/settings_common.default_options_dropdown_toggle_button_state_content/label_panel/label"',
        ' alt=dd+"/checked/button_panel/button_content/settings_common.default_options_dropdown_toggle_button_state_content/label_panel/label"',
        ' return lab((base,alt))',
        '_result={"engine":both(P["engine_dropdown"]),"graphics":both(P["graphics_dropdown"])}'
    ].join('\n');
}

/**
 * 生成驱动设置界面的 PowerShell 脚本（纯函数，便于测试）。
 *
 * 现在只保留「在窗口里点一下客户区像素」这一种底层原语：
 * 目标点始终来自游戏内的控件树，脚本本身不含任何业务坐标。
 */
export function buildSwitchScript(
    _target: RenderEngineMode,
    _clientWidth = 1600,
    _clientHeight = 900,
    _action: 'engine' | 'graphics' = 'engine',
    _closeToWorld = false,
    _startInSettings = false
): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$p = Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
        "if (-not $p) { Write-Output 'no-window'; exit 2 }",
        "Write-Output 'ready'"
    ].join('\r\n');
}

// ---------------------------------------------------------------------------
// 进程间原语
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 写临时 ps1（带 BOM，避免中文注释被按 ANSI 解码）并执行 */
function runPowerShell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const scriptPath = path.join(os.tmpdir(), 'mcdev-render-engine-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.ps1');
        try {
            fs.writeFileSync(scriptPath, '\uFEFF' + script, 'utf8');
        } catch {
            return resolve({ code: -1, stdout: '', stderr: 'failed to write temp script' });
        }
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { windowsHide: true }
        );
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (code: number): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }
            finish(-1);
        }, SCRIPT_TIMEOUT_MS);
        child.stdout.on('data', chunk => {
            stdout += String(chunk);
        });
        child.stderr.on('data', chunk => {
            stderr += String(chunk);
        });
        child.on('error', error => {
            stderr += String(error);
            finish(-1);
        });
        child.on('close', code => {
            try {
                fs.unlinkSync(scriptPath);
            } catch {
                // ignore
            }
            finish(code === null ? -1 : code);
        });
    });
}

/**
 * 用真实鼠标事件点击客户区里的一个点。
 *
 * 实测结论：游戏只认真实 Windows 鼠标事件（SetCursorPos + mouse_event）。
 * PostMessage 的 WM_LBUTTON* 和游戏内的 simulate_button_event 都会被丢弃，
 * 所以这里必须移动真实光标并按一下，再把焦点还给原来的前台窗口。
 */
export function buildClickScript(clientX: number, clientY: number): string {
    const x = Math.max(0, Math.round(clientX));
    const y = Math.max(0, Math.round(clientY));
    return [
        "$ErrorActionPreference = 'Stop'",
        '$code = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class McdevClick {',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);',
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);',
        '  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
        '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
        '}',
        '"@',
        'Add-Type -TypeDefinition $code',
        "$p = Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
        "if (-not $p) { Write-Output 'no-window'; exit 2 }",
        '$h = $p.MainWindowHandle',
        '$previous = [McdevClick]::GetForegroundWindow()',
        ' # SwitchToThisWindow 才能真正激活窗口；窗口不激活时游戏会丢弃鼠标事件',
        '[McdevClick]::SwitchToThisWindow($h, $true)',
        'Start-Sleep -Milliseconds 450',
        '# 客户区像素 -> 屏幕像素：客户区原点由 ClientToScreen 给出，不写死窗口位置',
        '$origin = New-Object McdevClick+POINT',
        '[McdevClick]::ClientToScreen($h, [ref]$origin) | Out-Null',
        '$rect = New-Object McdevClick+RECT',
        '[McdevClick]::GetClientRect($h, [ref]$rect) | Out-Null',
        `$sx = $origin.X + ${x}`,
        `$sy = $origin.Y + ${y}`,
        'if (' + x + ' -ge $rect.Right -or ' + y + ' -ge $rect.Bottom) {',
        "  Write-Output ('out-of-client $sx,$sy client=' + $rect.Right + 'x' + $rect.Bottom)",
        '}',
        '# 移动到位后要先让游戏吃到一次移动，再按下/松开，否则浮层会被当成拖拽丢掉',
        '[McdevClick]::SetCursorPos($sx, $sy) | Out-Null',
        'Start-Sleep -Milliseconds 400',
        '[McdevClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
        'Start-Sleep -Milliseconds 160',
        '[McdevClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
        'Start-Sleep -Milliseconds 250',
        'if ($previous -ne $h -and $previous -ne [IntPtr]::Zero) {',
        '  [McdevClick]::SwitchToThisWindow($previous, $true)',
        '}',
        "Write-Output ('clicked ' + $sx + ',' + $sy)"
    ].join('\r\n');
}

/**
 * 往游戏窗口发一次 Esc（用于把界面收回存档 / 暂停菜单）。
 * 和点击一样必须走真实键盘事件，PostMessage 的 WM_KEY* 会被游戏丢弃。
 */
export function buildEscScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        '$code = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class McdevKey {',
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
        '}',
        '"@',
        'Add-Type -TypeDefinition $code',
        "$p = Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
        "if (-not $p) { Write-Output 'no-window'; exit 2 }",
        '$h = $p.MainWindowHandle',
        '$previous = [McdevKey]::GetForegroundWindow()',
        '[McdevKey]::SwitchToThisWindow($h, $true)',
        'Start-Sleep -Milliseconds 250',
        '[McdevKey]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)',
        'Start-Sleep -Milliseconds 90',
        '[McdevKey]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)',
        'Start-Sleep -Milliseconds 350',
        'if ($previous -ne $h -and $previous -ne [IntPtr]::Zero) {',
        '  [McdevKey]::SwitchToThisWindow($previous, $true)',
        '}',
        "Write-Output 'done'"
    ].join('\r\n');
}

/**
 * 常驻点击器。
 *
 * 下拉浮层只在「刚展开那一瞬间」接受鼠标点击，晚了就只是把浮层关掉。
 * 每次点击都新起一个 PowerShell 要 1.8 秒，来不及，所以这里维持一个
 * 常驻进程：启动时缓存窗口客户区原点，之后每行「x y」立刻点一下。
 */
export class FastClicker {
    private child?: ReturnType<typeof spawn>;
    private buffer = '';
    private pending?: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };
    private disposed = false;

    /** 启动常驻进程并等它就绪；失败返回 false（调用方退回单次脚本） */
    public async start(): Promise<boolean> {
        if (this.child) {
            return true;
        }
        // 脚本必须落盘再用 -File 执行：-Command - 会和 [Console]::In.ReadLine() 抢同一个 stdin
        const scriptPath = path.join(os.tmpdir(), 'mcdev-fast-click-' + Date.now() + '.ps1');
        try {
            fs.writeFileSync(scriptPath, '﻿' + buildFastClickerScript(), 'utf8');
        } catch {
            return false;
        }
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { windowsHide: true }
        );
        this.child = child;
        let readyResolve: ((ok: boolean) => void) | undefined;
        const ready = new Promise<boolean>(resolve => {
            readyResolve = resolve;
        });
        const timer = setTimeout(() => readyResolve?.(false), 8000);
        // 单一数据通道：先判就绪，再交接给常驻消费逻辑，避免两份回调抢同一份缓冲
        child.stdout.on('data', chunk => {
            const text = String(chunk);
            if (readyResolve && text.indexOf('ready') >= 0) {
                clearTimeout(timer);
                const resolve = readyResolve;
                readyResolve = undefined;
                resolve(true);
                return;
            }
            if (!readyResolve) {
                this.consume(text);
            }
        });
        child.stderr.on('data', () => undefined);
        child.on('close', () => {
            this.child = undefined;
            readyResolve?.(false);
            this.settle(false);
            try {
                fs.unlinkSync(scriptPath);
            } catch {
                // ignore
            }
        });
        const ok = await ready;
        if (!ok) {
            this.dispose();
        }
        return ok;
    }

    /** 点一下客户区坐标；返回是否确认送达 */
    public click(x: number, y: number): Promise<boolean> {
        if (!this.child || this.disposed) {
            return Promise.resolve(false);
        }
        const cx = Math.max(0, Math.round(x));
        const cy = Math.max(0, Math.round(y));
        const stdin = this.child?.stdin;
        if (!stdin) {
            return Promise.resolve(false);
        }
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => this.settle(false), 3000);
            this.pending = { resolve, timer };
            stdin.write(`${cx} ${cy}\n`);
        });
    }

    public dispose(): void {
        this.disposed = true;
        this.settle(false);
        try {
            this.child?.stdin?.end();
            this.child?.kill();
        } catch {
            // ignore
        }
        this.child = undefined;
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        if (this.buffer.indexOf('done ') >= 0) {
            this.buffer = '';
            this.settle(true);
        }
        if (this.buffer.length > 8192) {
            this.buffer = this.buffer.slice(-2048);
        }
    }

    private settle(ok: boolean): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(ok);
    }
}

/** 常驻点击器的 PowerShell 主体：启动时缓存客户区原点，之后逐行响应 */
export function buildFastClickerScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        '$code = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class McdevFast {',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);',
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
        '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
        '}',
        '"@',
        'Add-Type -TypeDefinition $code',
        "$p = Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
        'if (-not $p) { Write-Output "no-window"; exit 2 }',
        '$h = $p.MainWindowHandle',
        '$origin = New-Object McdevFast+POINT',
        '[McdevFast]::ClientToScreen($h, [ref]$origin) | Out-Null',
        'Write-Output "ready"',
        'while ($true) {',
        '  $line = [Console]::In.ReadLine()',
        '  if ($null -eq $line) { break }',
        '  $parts = $line.Trim().Split(" ")',
        '  if ($parts.Length -lt 2) { continue }',
        '  $sx = $origin.X + [int]$parts[0]',
        '  $sy = $origin.Y + [int]$parts[1]',
        '  # SwitchToThisWindow 才真正把这个窗口激活；SetForegroundWindow 常被系统忽略，',
        '  # 窗口不激活时游戏会丢弃鼠标事件，点哪都没反应。',
        '  [McdevFast]::SwitchToThisWindow($h, $true)',
        '  Start-Sleep -Milliseconds 450',
        '  [McdevFast]::SetCursorPos($sx, $sy) | Out-Null',
        '  Start-Sleep -Milliseconds 350',
        '  [McdevFast]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
        '  Start-Sleep -Milliseconds 200',
        '  [McdevFast]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
        '  Write-Output ("done " + $sx + "," + $sy)',
        '}'
    ].join('\r\n');
}

/** 虚拟键码：下方向键 / 回车 / Esc */
const VK_DOWN = 0x28;
const VK_RETURN = 0x0D;
const VK_ESCAPE = 0x1B;

/**
 * 常驻键盘输入器。
 *
 * 和 FastClicker 同一个思路：常驻一个 PowerShell 进程，逐行接收虚拟键码并
 * 发一次真实的 keybd_event。下拉选项只能用键盘可靠选中，所以必须有它。
 */
export class FastKeys {
    private child?: ReturnType<typeof spawn>;
    private buffer = '';
    private pending?: { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };
    private disposed = false;

    public async start(): Promise<boolean> {
        if (this.child) {
            return true;
        }
        const scriptPath = path.join(os.tmpdir(), 'mcdev-fast-keys-' + Date.now() + '.ps1');
        try {
            fs.writeFileSync(scriptPath, '\uFEFF' + buildFastKeysScript(), 'utf8');
        } catch {
            return false;
        }
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { windowsHide: true }
        );
        this.child = child;
        let readyResolve: ((ok: boolean) => void) | undefined;
        const ready = new Promise<boolean>(resolve => {
            readyResolve = resolve;
        });
        const timer = setTimeout(() => readyResolve?.(false), 8000);
        child.stdout.on('data', chunk => {
            const text = String(chunk);
            if (readyResolve && text.indexOf('ready') >= 0) {
                clearTimeout(timer);
                const resolve = readyResolve;
                readyResolve = undefined;
                resolve(true);
                return;
            }
            if (!readyResolve) {
                this.buffer += text;
                if (this.buffer.indexOf('done') >= 0) {
                    this.buffer = '';
                    this.settle(true);
                }
            }
        });
        child.stderr.on('data', () => undefined);
        child.on('close', () => {
            this.child = undefined;
            readyResolve?.(false);
            this.settle(false);
            try {
                fs.unlinkSync(scriptPath);
            } catch {
                // ignore
            }
        });
        const ok = await ready;
        if (!ok) {
            this.dispose();
        }
        return ok;
    }

    /** 按一次键；返回是否确认送达。首次按键时才启动常驻进程，快路径成功时完全不碰 PowerShell。 */
    public async press(virtualKey: number): Promise<boolean> {
        if (this.disposed) {
            return false;
        }
        if (!this.child && !(await this.start())) {
            return false;
        }
        const stdin = this.child?.stdin;
        if (!stdin) {
            return false;
        }
        return new Promise<boolean>(resolve => {
            const timer = setTimeout(() => this.settle(false), 3000);
            this.pending = { resolve, timer };
            stdin.write(`${Math.trunc(virtualKey)}\n`);
        });
    }

    public dispose(): void {
        this.disposed = true;
        this.settle(false);
        try {
            this.child?.stdin?.end();
            this.child?.kill();
        } catch {
            // ignore
        }
        this.child = undefined;
    }

    private settle(ok: boolean): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(ok);
    }
}

/** 常驻键盘输入器的 PowerShell 主体：启动时把游戏拉到前台，之后逐行发键 */
export function buildFastKeysScript(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        '$code = @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class McdevKeys {',
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);',
        '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
        '}',
        '"@',
        'Add-Type -TypeDefinition $code',
        "$p = Get-Process Minecraft.Windows -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
        'if (-not $p) { Write-Output "no-window"; exit 2 }',
        '$h = $p.MainWindowHandle',
        '[McdevKeys]::SwitchToThisWindow($h, $true)',
        'Start-Sleep -Milliseconds 250',
        'Write-Output "ready"',
        'while ($true) {',
        '  $line = [Console]::In.ReadLine()',
        '  if ($null -eq $line) { break }',
        '  $vk = 0',
        '  if (-not [int]::TryParse($line.Trim(), [ref]$vk)) { continue }',
        '  [McdevKeys]::SwitchToThisWindow($h, $true)',
        '  Start-Sleep -Milliseconds 100',
        '  [McdevKeys]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)',
        '  Start-Sleep -Milliseconds 90',
        '  [McdevKeys]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)',
        '  Write-Output "done"',
        '}'
    ].join('\r\n');
}

// ---------------------------------------------------------------------------
// 等待重载
// ---------------------------------------------------------------------------

const RENDERER_RELOAD_TIMEOUT_MS = 90_000;
const RENDERER_RELOAD_POLL_MS = 700;
/** 点中选项后等下拉显示值变化的最长时间（引擎切换含渲染器重载） */
const OPTION_LABEL_TIMEOUT_MS = 20_000;

/** 等待一次渲染器重载完成；日志里的 marker 必须是本次操作之后新增的。 */
async function waitForLogMarker(
    logFile: string,
    startOffset: number,
    marker: string,
    timeoutMs = RENDERER_RELOAD_TIMEOUT_MS
): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (readLogFromOffset(logFile, startOffset).includes(marker)) {
            return true;
        }
        await delay(RENDERER_RELOAD_POLL_MS);
    }
    return false;
}

function fileSize(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const WANTED_ENGINE: Record<RenderEngineMode, string> = {
    renderdragon: 'RenderDragon',
    opengl: 'OpenGL'
};
const VIBRANT_LABEL = '灵动视效';

interface DropdownState extends DropdownReadResult {
    /** 读到的选项文案（模板实例共用路径，通常只读到当前项） */
    options: string[];
    /** radio_control_group 的直接子节点数 = 真实选项个数 */
    count: number;
    /** 单行高度（UI 单位），用于换算目标行中心 */
    row: number;
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** 读下拉是否已展开 */
async function readDropdownOpenState(execute: ExecuteGameCode, which: DropdownKey): Promise<boolean> {
    try {
        const raw = asRecord(await execute(buildDropdownOpenStateCode(which)));
        return raw?.open === true;
    } catch {
        return false;
    }
}

/**
 * 展开下拉并读取选项几何。
 *
 * 展开本身由游戏内控件 API 完成（`set_toggle_state_new`，实测可靠），
 * 真正「选中某一项」才需要真实鼠标点击选项行。
 */
async function openDropdown(execute: ExecuteGameCode, which: DropdownKey): Promise<DropdownState | undefined> {
    let record: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            record = asRecord(await execute(buildOpenDropdownCode(which)));
        } catch {
            await delay(700);
            continue;
        }
        if (record) {
            break;
        }
    }
    if (!record) {
        return undefined;
    }
    const options = Array.isArray(record.options) ? record.options.filter(item => typeof item === 'string') as string[] : [];
    const h = Number(record.h);
    const count = Number(record.count) || options.length || 1;
    const row = Number(record.row) || (h / Math.max(1, count));
    return {
        label: '',
        options,
        count: Math.max(1, count),
        row: row > 0 ? row : 1,
        x: Number(record.x),
        y: Number(record.y),
        w: Number(record.w),
        h,
        scale: Number(record.scale) || 1
    };
}

function normalizeLabel(value: string | undefined): string {
    return (value ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 下拉选项顺序是固定的（JSON 里的 $radio_buttons 顺序）：
 * - 渲染引擎：OpenGL=0，RenderDragon=1
 * - 图形模式：简约=0，花式=1，灵动视效=2
 * 知道当前值和目标值的下标后，一次方向键 + 一次回车就能完成选择，
 * 不必像以前那样逐项回车、每项都等一次重载。
 */
function optionIndex(which: DropdownKey, label: string | undefined): number | undefined {
    const value = normalizeLabel(label);
    if (!value) {
        return undefined;
    }
    if (which === 'engine_dropdown') {
        if (value.indexOf('opengl') >= 0) {
            return 0;
        }
        if (value.indexOf('renderdragon') >= 0 || value.indexOf('渲') >= 0) {
            return 1;
        }
        return undefined;
    }
    if (value.indexOf('simple') >= 0 || value.indexOf('简约') >= 0) {
        return 0;
    }
    if (value.indexOf('fancy') >= 0 || value.indexOf('花式') >= 0) {
        return 1;
    }
    if (value.indexOf('deferred') >= 0 || value.indexOf('灵动') >= 0 || value.indexOf('vibrant') >= 0) {
        return 2;
    }
    return undefined;
}

/**
 * 读一次下拉框「自身」显示的当前值。
 *
 * 注意不能用下拉框的 unchecked/checked 模板路径：浮层展开时同一套模板名
 * 在浮层里也存在，会读到列表项而不是当前值。所以改读两个状态模板里
 * 真正可见且有尺寸的那一个。
 */
async function readDropdownLabel(execute: ExecuteGameCode, which: DropdownKey): Promise<string | undefined> {
    // 切换渲染器时游戏主线程会阻塞一会儿，读值要能容忍这种抖动
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            const raw = asRecord(await execute(buildReadDropdownCode(which)));
            const label = raw?.label;
            return typeof label === 'string' ? label : undefined;
        } catch {
            await delay(600);
        }
    }
    return undefined;
}

/**
 * 等下拉显示的当前值变成「非空且与 original 不同」。
 *
 * 确认选项后游戏会重建渲染器，期间设置页控件全部消失、读到的 label 是空值。
 * 空值属于「还没准备好」，必须继续等，否则会把重载中的中间态误当成新值。
 */
async function waitForLabelChange(
    execute: ExecuteGameCode,
    which: DropdownKey,
    original: string,
    timeoutMs: number
): Promise<string | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await delay(300);
        const value = await readDropdownLabel(execute, which);
        if (value === undefined || !value.trim()) {
            continue;
        }
        if (normalizeLabel(value) !== original) {
            return value;
        }
    }
    return undefined;
}

/**
 * 在下拉里选中目标值。
 *
 * 选项行是 collection 模板实例：所有实例共用同一条 `{ui_control}` 路径，
 * 控件 API 按名字和索引都取不到单个实例，也就无法「按文案查出下标」。
 * 鼠标点在浮层行上实测不可靠（浮层只对极短时间窗内的点击有响应），
 * 而真实键盘的方向键 + 回车稳定生效，所以这里用键盘逐个试：
 * 每按一次「下」就回车确认一次，然后读下拉的当前值校验。
 */
async function pickOptionByLabel(
    execute: ExecuteGameCode,
    which: DropdownKey,
    wanted: string,
    keys?: FastKeys
): Promise<InGameSwitchResult> {
    const target = normalizeLabel(wanted);
    const original = normalizeLabel(await readDropdownLabel(execute, which));
    if (original === target) {
        return { ok: true };
    }
    if (!keys) {
        return {
            ok: false,
            failure: 'script-failed',
            message: '无法创建键盘输入器，渲染引擎切换中止。'
        };
    }

    const state = await openDropdown(execute, which);
    if (!state || state.count < 1) {
        return {
            ok: false,
            failure: 'script-failed',
            message: '没有读到下拉选项，游戏可能还没重建好设置页控件。'
        };
    }

    // 首选：直接按控件树顺序选中第 targetIndex 个 radio，完全不碰鼠标，
    // 也不依赖下拉键盘焦点从哪一项开始。
    const targetIndex = optionIndex(which, wanted);
    if (targetIndex !== undefined) {
        try {
            const raw = asRecord(await execute(buildPickRadioByPathCode(which, targetIndex)));
            if (raw?.ok === true) {
                const settled = await waitForLabelChange(execute, which, original, OPTION_LABEL_TIMEOUT_MS);
                if (settled !== undefined && normalizeLabel(settled) === target) {
                    return { ok: true };
                }
            }
        } catch {
            // 控件路径不可用时继续走键盘兜底
        }
        if (!(await readDropdownOpenState(execute, which))) {
            await openDropdown(execute, which);
            await delay(150);
        }
    }

    // 键盘兜底：实测下拉展开后焦点在「第一项」，所以从顶部下移 targetIndex 次，
    // 再一次回车。之前用「目标-当前」的差值，焦点其实从第一项开始，
    // 结果把灵动视效点成了花式。
    if (targetIndex !== undefined) {
        // 重新展开一次，强制把键盘焦点重置到顶部
        await openDropdown(execute, which);
        for (let step = 0; step < targetIndex; step += 1) {
            if (!(await keys.press(VK_DOWN))) {
                return { ok: false, failure: 'script-failed', message: '向游戏窗口发送方向键失败。' };
            }
            await delay(90);
        }
        if (await keys.press(VK_RETURN)) {
            const settled = await waitForLabelChange(execute, which, original, OPTION_LABEL_TIMEOUT_MS);
            if (settled !== undefined && normalizeLabel(settled) === target) {
                return { ok: true };
            }
        }
        // 快路径失败，重新展开后走逐项兜底
        await openDropdown(execute, which);
        await delay(150);
    }

    // 兜底：浮层已展开，焦点在下拉里，逐项按「下」并回车确认
    for (let step = 0; step < state.count; step += 1) {
        if (!(await keys.press(VK_DOWN))) {
            return { ok: false, failure: 'script-failed', message: '向游戏窗口发送方向键失败。' };
        }
        await delay(220);
        if (!(await keys.press(VK_RETURN))) {
            return { ok: false, failure: 'script-failed', message: '向游戏窗口发送回车失败。' };
        }
        // 回车确认后游戏会重建渲染器：设置页控件会短暂全部消失，label 读到空，
        // 所以这里必须等控件恢复后再判断，不能按固定时长草率收工。
        const settled = await waitForLabelChange(execute, which, original, OPTION_LABEL_TIMEOUT_MS);
        if (settled !== undefined && normalizeLabel(settled) === target) {
            return { ok: true };
        }
        if (settled !== undefined && normalizeLabel(settled) !== target) {
            // 确认到了别的值：重新展开，继续试下一项
            if (!(await readDropdownOpenState(execute, which))) {
                await openDropdown(execute, which);
                await delay(250);
            }
        }
    }

    return {
        ok: false,
        failure: 'not-switched',
        message: `下拉里没有「${wanted}」这个选项（共 ${state.count} 项，读到：${state.options.join(' / ') || '未读到文案'}）。`
    };
}

/** 读当前引擎 / 图形模式标签 */
async function readLabels(execute: ExecuteGameCode): Promise<{ engine?: string; graphics?: string }> {
    const raw = asRecord(await execute(buildReadLabelsCode()));
    return {
        engine: typeof raw?.engine === 'string' ? raw.engine : undefined,
        graphics: typeof raw?.graphics === 'string' ? raw.graphics : undefined
    };
}

/**
 * 渲染龙初始化完成后，在仍然打开的设置页切换「图形模式 → 灵动视效」。
 * 返回第二阶段脚本执行结果和日志起点，调用方再等待这一次的图形上下文重建。
 */
async function applyVibrantVisuals(
    logFile: string,
    engineStartOffset: number,
    execute: ExecuteGameCode,
    keys?: FastKeys
): Promise<{ result: InGameSwitchResult; startOffset?: number }> {
    // 引擎切换完成后不要根据 isInWorld 放行：此时用户明确要求游戏仍停在原来的设置页。
    // 等渲染龙自己的资源初始化完成，再给设置页一点时间重建控件。
    if (!(await waitForLogMarker(logFile, engineStartOffset, 'Deferred Texture:'))) {
        return {
            result: {
                ok: false,
                failure: 'not-switched',
                message: '渲染龙初始化超时，游戏还没有准备好切换灵动视效。'
            }
        };
    }
    await delay(1800);
    const startOffset = fileSize(logFile);

    // 切到渲染龙后设置页会整体重建，重新选中「视频」并滚到底部让图形模式可见。
    try {
        let selected = false;
        for (let attempt = 0; attempt < 4 && !selected; attempt += 1) {
            try {
                await execute(buildSelectVideoTabCode());
                selected = true;
            } catch {
                await delay(1000);
            }
        }
        if (!selected) {
            throw new Error('video-tab-not-selected');
        }
        await execute(scrollToDropdownCode('graphics_dropdown'));
    } catch (error) {
        return {
            result: {
                ok: false,
                failure: 'script-failed',
                message: '切换灵动视效前准备设置页失败：'
                    + (error instanceof Error ? error.message : String(error)).slice(0, 200)
            }
        };
    }

    const picked = await pickOptionByLabel(execute, 'graphics_dropdown', VIBRANT_LABEL, keys);
    if (!picked.ok) {
        return { result: picked };
    }
    return { result: { ok: true }, startOffset };
}

/**
 * 询问游戏当前的真实界面，失败时退回日志判定。
 * 真实界面列表是准确的，日志只作为 Host Bridge 不可用时的兜底。
 */
async function queryScreen(execute: ExecuteGameCode, logFile: string | undefined): Promise<GameScreen> {
    try {
        const raw = asRecord(await execute(buildQueryScreenCode()));
        const names = raw?.screens;
        if (Array.isArray(names)) {
            return classifyScreens(names.map(name => String(name)));
        }
    } catch {
        // 调试通道不可用时退回日志
    }
    return detectScreen(logFile);
}

/**
 * 打开原版设置页。
 *
 * 分两步：先让游戏内脚本把界面推进到「暂停菜单」并返回「设置」按钮的真实位置，
 * 再由宿主用窗口消息点一下这个位置，最后等设置页出现。
 * 这样暂停菜单的按钮不需要坐标假设，也避开了游戏忽略合成鼠标事件的问题。
 */
/**
 * 打开原版设置页。
 *
 * 用 gui.push_screen 直接压入原版设置页，不经过暂停菜单的「设置」按钮：
 * 那个按钮只能靠真实鼠标点击，而游戏在窗口失焦后会吞掉鼠标输入，
 * push_screen 是纯 UI 栈操作，稳定可靠。
 */
async function openSettingsPage(
    execute: ExecuteGameCode,
    ensureSettingsOpen?: EnsureSettingsOpen
): Promise<InGameSwitchResult> {
    if (ensureSettingsOpen) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const opened = await ensureSettingsOpen();
                if (opened.ok) {
                    await delay(150);
                    await execute(buildWaitSettingsCode());
                    return { ok: true };
                }
                if (attempt === 1) {
                    return {
                        ok: false,
                        failure: 'script-failed',
                        message: '没能打开游戏设置页：'
                            + (opened.message || opened.error || '未知错误')
                    };
                }
            } catch (error) {
                if (attempt === 1) {
                    return {
                        ok: false,
                        failure: 'script-failed',
                        message: '打开游戏设置页失败：'
                            + (error instanceof Error ? error.message : String(error)).slice(0, 200)
                    };
                }
            }
            await delay(1500);
        }
    }
    // 没有原生打开回调时，只能要求设置页已经打开（例如用户手动打开了）
    try {
        await execute(buildWaitSettingsCode());
        return { ok: true };
    } catch {
        return {
            ok: false,
            failure: 'script-failed',
            message: '请先手动打开游戏设置页（ESC → 设置）后再切换渲染引擎。'
        };
    }
}

/** 让设置页滚到底部并选中「视频」分类，让目标下拉可见 */
async function prepareSettingsPage(execute: ExecuteGameCode): Promise<InGameSwitchResult> {
    // 设置页刚打开／刚重建时控件树还没建好，这里必须重试而不是一次失败就放弃
    let lastError: unknown;
    let selected = false;
    for (let attempt = 0; attempt < 4 && !selected; attempt += 1) {
        try {
            await execute(buildSelectVideoTabCode());
            selected = true;
        } catch (error) {
            lastError = error;
            await delay(1000);
        }
    }
    if (!selected) {
        return {
            ok: false,
            failure: 'script-failed',
            message: '没能选中设置里的「视频」分类：'
                + (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 160)
        };
    }
    const raw = asRecord(await execute(scrollToDropdownCode('engine_dropdown')));
    if (raw && raw.visible === false) {
        return {
            ok: false,
            failure: 'script-failed',
            message: '在视频设置里找不到「渲染引擎」，请确认游戏版本仍是网易 3.10 及以上。'
        };
    }
    return { ok: true };
}

function targetStateReached(target: RenderEngineMode): boolean {
    const optionsPath = path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'MinecraftPE_Netease',
        'minecraftpe',
        'options.txt'
    );
    const state = readRenderEngineState(optionsPath);
    return target === 'renderdragon'
        ? state.mode === 'renderdragon'
        : state.mode === 'opengl';
}

/** 在游戏内切换渲染引擎；调用前需要游戏正在运行且停在存档里 */
export async function switchRenderEngineInGame(
    target: RenderEngineMode,
    execute?: ExecuteGameCode,
    ensureSettingsOpen?: EnsureSettingsOpen
): Promise<InGameSwitchResult> {
    if (!execute) {
        return {
            ok: false,
            failure: 'script-failed',
            message: '渲染切换需要已连接的 Host Bridge 游戏会话。请启动调试运行后重试。'
        };
    }
    let logFile = findLatestDebugLog();
    if (!logFile) {
        return { ok: false, failure: 'game-not-running', message: '没有找到游戏日志，请先启动游戏。' };
    }

    // 下拉选项优先用控件树下标直接选中；只有快路径失败才用键盘兜底。
    // 键盘进程也改成首次按键才启动，快路径成功时完全不碰 PowerShell。
    const keys = new FastKeys();
    try {
        return await runSwitchFlow(target, execute, logFile, keys, ensureSettingsOpen);
    } finally {
        keys.dispose();
    }
}

async function runSwitchFlow(
    target: RenderEngineMode,
    execute: ExecuteGameCode,
    initialLogFile: string,
    keys: FastKeys,
    ensureSettingsOpen?: EnsureSettingsOpen
): Promise<InGameSwitchResult> {
    let logFile = initialLogFile;

    // 先把界面收敛到「存档 / 暂停菜单 / 设置页」：用户可能停在自定义界面或主菜单
    let screen = await queryScreen(execute, logFile);
    if (screen === 'other' && !isInWorld(logFile)) {
        return {
            ok: false,
            failure: 'not-in-world',
            message: '检测到游戏当前打开了自定义界面，请先关闭它并回到存档或原版暂停菜单后再切换渲染器。'
        };
    }
    for (let attempt = 0; attempt < 4 && screen === 'other'; attempt += 1) {
        const escape = await runPowerShell(buildEscScript());
        if (escape.code === 2) {
            return { ok: false, failure: 'no-window', message: '没有找到 Minecraft 游戏窗口，请先启动游戏。' };
        }
        await delay(1500);
        logFile = findLatestDebugLog() ?? logFile;
        screen = await queryScreen(execute, logFile);
    }
    if (screen === 'other') {
        return {
            ok: false,
            failure: 'not-in-world',
            message: '请先进入游戏存档（不要停在主菜单或聊天框），再点击本行切换渲染引擎。'
        };
    }

    const opened = await openSettingsPage(execute, ensureSettingsOpen);
    if (!opened.ok) {
        return opened;
    }
    await delay(400);
    logFile = findLatestDebugLog() ?? logFile;

    const prepared = await prepareSettingsPage(execute);
    if (!prepared.ok) {
        return prepared;
    }

    const startOffset = fileSize(logFile);
    const engineLabel = WANTED_ENGINE[target];
    const picked = await pickOptionByLabel(execute, 'engine_dropdown', engineLabel, keys);
    if (!picked.ok) {
        return picked;
    }

    // 引擎切换会重建渲染器：日志是缓冲写入的，结果可能要几秒才落盘。
    const marker = target === 'renderdragon' ? 'Enter the RenderDragon' : 'The graphics context was gained';
    if (!(await waitForLogMarker(logFile, startOffset, marker))) {
        // 日志可能轮转，options.txt 是游戏最终落盘状态的权威来源。
        if (!targetStateReached(target)) {
            return {
                ok: false,
                failure: 'not-switched',
                message:
                    target === 'opengl'
                        ? '游戏内切回 OpenGL 失败。退出游戏后插件会自动把 options.txt 切回 OpenGL，下次启动仍是 OpenGL。'
                        : '没有检测到渲染引擎切换完成。请确认游戏停在存档内、窗口未被最小化后重试。'
            };
        }
    }

    if (target === 'renderdragon') {
        // 关键流程：切换引擎后仍停在原设置页，等待渲染龙初始化完成，再切换灵动视效。
        const graphics = await applyVibrantVisuals(logFile, startOffset, execute, keys);
        if (!graphics.result.ok) {
            return graphics.result;
        }
        const graphicsStartOffset = graphics.startOffset ?? fileSize(logFile);
        // 图形模式切换也会重建上下文；本次必须观察到新一轮初始化完成。
        if (!(await waitForLogMarker(logFile, graphicsStartOffset, 'The graphics context was gained'))) {
            const labels = await readLabels(execute).catch(() => ({ engine: undefined, graphics: undefined }));
            if (!labels.graphics || labels.graphics.indexOf(VIBRANT_LABEL) < 0) {
                return {
                    ok: false,
                    failure: 'graphics-not-switched',
                    message: '渲染龙已启用，但灵动视效的第二次重载没有完成，请稍后重试。'
                };
            }
        }
        // 第二阶段完成后才允许退出设置页，最后返回原存档。
        for (let press = 0; press < 3; press += 1) {
            const closeResult = await runPowerShell(buildEscScript());
            if (closeResult.code === 2 || closeResult.stdout.includes('no-window')) {
                return { ok: false, failure: 'no-window', message: '没有找到 Minecraft 游戏窗口，请先启动游戏。' };
            }
            await delay(900);
        }
    }
    return { ok: true };
}
