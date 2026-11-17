/**
 * 游戏内「设置 → 调试」里的开发者开关。
 *
 * 这些开关没有 ModSDK 公开接口，实测有两条可用路径：
 * - 普通引擎选项：`_setting.set_option(key, value, False)` 立即生效，`get_option` 能读回；
 * - 渲染类调试开关（边界框 / 路径 / 目标状态 / 生物信息）：没有注册成普通选项，
 *   要通过设置页 `debug_section` 里的 Toggle 控件切换。
 *
 * 这里只负责生成游戏内 Python 与校验回包，不引入任何网络或文件副作用。
 */

export const DEBUG_SWITCH_SETTINGS_SCREEN = 'settings.screen_world_controls_and_settings';

export type DebugSwitchId =
    | 'bounds'
    | 'findMobs'
    | 'paths'
    | 'goalState'
    | 'mobInfo'
    | 'chunkMap'
    | 'disableTerrain';

export interface DebugSwitchDefinition {
    id: DebugSwitchId;
    /** 引擎选项键，按优先级尝试；第一个是设置页绑定名对应的驼峰写法 */
    optionKeys: readonly string[];
    /** `debug_section` 里的控件名，找不到时会在该控件子树里搜 Toggle */
    controlNames: readonly string[];
}

export const DEBUG_SWITCHES: readonly DebugSwitchDefinition[] = [
    {
        id: 'bounds',
        optionKeys: ['dev_renderBoundingBox', 'dev_render_bounding_box'],
        controlNames: ['option_toggle_0_1'],
    },
    {
        id: 'findMobs',
        optionKeys: ['dev_findMobs', 'dev_find_mobs'],
        controlNames: ['option_toggle_0_2'],
    },
    {
        id: 'paths',
        optionKeys: ['dev_renderPaths', 'dev_render_paths'],
        controlNames: ['option_toggle_3'],
    },
    {
        id: 'goalState',
        optionKeys: ['dev_renderGoalState', 'dev_render_goal_state'],
        controlNames: ['option_toggle_4'],
    },
    {
        id: 'mobInfo',
        optionKeys: ['dev_renderMobInfoState', 'dev_render_mob_info_state'],
        controlNames: ['option_toggle_9'],
    },
    {
        id: 'chunkMap',
        optionKeys: ['dev_showchunkmap', 'dev_show_chunk_map'],
        controlNames: ['option_toggle_6'],
    },
    {
        id: 'disableTerrain',
        optionKeys: ['dev_disable_render_terrain'],
        controlNames: ['option_toggle_disable_render_terrain'],
    },
];

export function findDebugSwitch(id: string): DebugSwitchDefinition | undefined {
    return DEBUG_SWITCHES.find(item => item.id === id);
}

function pyString(value: string): string {
    return JSON.stringify(value);
}

function pyList(values: readonly string[]): string {
    return '[' + values.map(pyString).join(',') + ']';
}

function pySpecs(): string {
    const parts = DEBUG_SWITCHES.map(item => (
        pyString(item.id) + ':' + pyList(item.optionKeys)
    ));
    return '{' + parts.join(',') + '}';
}

/** 读取各开关当前值；读不到的返回 None（渲染类开关通常如此）。 */
export function buildDebugSwitchesStateCode(): string {
    return [
        'try:',
        ' import _setting',
        'except:',
        " _result={'states':{},'settingsOpen':False,'error':'debug-channel-unavailable'}",
        'else:',
        ' try:',
        '  import gui',
        '  _screens=gui.get_all_screen_fullnames() or []',
        ' except:',
        '  _screens=[]',
        ` _specs=${pySpecs()}`,
        ' _states={}',
        ' for _id in _specs:',
        '  _value=None',
        '  for _key in _specs[_id]:',
        '   try:',
        '    _raw=_setting.get_option(_key,0)',
        '   except:',
        '    _raw=None',
        '   if _raw is not None:',
        '    _value=bool(_raw)',
        '    break',
        '  _states[_id]=_value',
        ` _result={'states':_states,'settingsOpen':${pyString(DEBUG_SWITCH_SETTINGS_SCREEN)} in _screens}`,
    ].join('\n');
}

/**
 * 切换一个开关。
 *
 * 先按普通引擎选项写入并读回校验；选项不存在时退到设置页控件：
 * 打开设置页 → 必要时切到「调试」分类 → 在 debug_section 里找对应 Toggle →
 * 写入 → 读回 → 如果设置页是这次打开的，再关掉。
 */
export function buildDebugSwitchSetCode(id: string, enabled: boolean): string {
    const definition = findDebugSwitch(id);
    if (!definition) {
        throw new Error('Unknown debug switch');
    }
    const settings = pyString(DEBUG_SWITCH_SETTINGS_SCREEN);
    return [
        'try:',
        ' import _setting',
        'except:',
        ' _setting=None',
        'import time',
        'try:',
        ' import gui',
        'except:',
        ' gui=None',
        `_id=${pyString(definition.id)};_value=${enabled ? 'True' : 'False'}`,
        `_keys=${pyList(definition.optionKeys)};_controls=${pyList(definition.controlNames)}`,
        `_settings=${settings}`,
        "_dialog='/variables_button_mappings_and_controls/safezone_screen_matrix/inner_matrix/safezone_screen_panel/root_screen_panel/stack_panel/content_panel/container/settings_common.dialog_content'",
        "_right=_dialog+'/content_area/control/scrolling_panel'",
        "_left=_dialog+'/selector_area/scrolling_panel'",
        "_suffix='/background_and_viewport/scrolling_view_port/scrolling_content'",
        "_wrappers=['panel','stack_panel']",
        "_scrolling=['scroll_touch','scroll_mouse']",
        '',
        'def _screens():',
        ' try:return gui.get_all_screen_fullnames() or []',
        ' except:return []',
        '',
        'def _children(s,p):',
        ' try:return gui.get_children_name_from_parent(s,p) or []',
        ' except:return []',
        '',
        'def _type(s,p):',
        ' try:return gui.get_control_def_type(s,p)',
        ' except:return None',
        '',
        'def _right_base(s):',
        ' for _n in _scrolling:',
        '  for _w in _wrappers:',
        "   _p=_right+'/'+_n+'/scroll_view/'+_w+_suffix",
        '   if _children(s,_p):return _p',
        ' return None',
        '',
        'def _left_pane(s):',
        ' for _n in _scrolling:',
        '  for _w in _wrappers:',
        "   _p=_left+'/'+_n+'/scroll_view/'+_w+_suffix+'/settings.selector_stack_panel/controls_and_settings_selector_pane'",
        '   if _children(s,_p):return _p',
        ' return None',
        '',
        'def _find_toggle(s,root):',
        ' _queue=[(root,0)];_seen=0',
        ' while _queue and _seen<192:',
        '  _path,_depth=_queue.pop(0);_seen+=1',
        '  if _type(s,_path)==19:return _path',
        '  if _depth>=5:continue',
        '  for _child in _children(s,_path)[:32]:',
        "   _queue.append((_path.rstrip('/')+'/'+_child,_depth+1))",
        ' return None',
        '',
        '# 1) engine option: readable back means it took effect',
        '_via=None;_applied=None',
        'if _setting is not None:',
        ' for _key in _keys:',
        '  try:',
        '   _setting.set_option(_key,_value,False)',
        '  except:',
        '   pass',
        '  try:',
        '   _raw=_setting.get_option(_key,0)',
        '  except:',
        '   _raw=None',
        '  if _raw is not None:',
        "   _via='option';_applied=bool(_raw);break",
        'if _via:',
        " _result={'ok':_applied==_value,'via':_via,'value':_applied,'error':None if _applied==_value else 'option-rejected'}",
        'elif gui is None:',
        " _result={'ok':False,'error':'debug-channel-unavailable'}",
        'else:',
        ' if _settings not in _screens():',
        "  _result={'ok':False,'error':'settings-closed'}",
        ' else:',
        '  _base=_right_base(_settings)',
        '  if _base is None:',
        "   _result={'ok':False,'error':'settings-layout-unknown'}",
        '  else:',
        "   _section=_base+'/general_and_controls_sections/debug_section'",
        '   if not _children(_settings,_section):',
        '    _pane=_left_pane(_settings)',
        '    if _pane:',
        "     _debug=_pane+'/debug_button/debug_button_toggle'",
        '     try:gui.set_toggle_state_new(_settings,_debug,True)',
        '     except:pass',
        '     for _ in range(12):',
        '      time.sleep(0.1)',
        '      if _children(_settings,_section):break',
        '   if not _children(_settings,_section):',
        "    _result={'ok':False,'error':'debug-ui-unavailable'}",
        '   else:',
        '    _toggle=None',
        '    for _name in _controls:',
        "     _toggle=_find_toggle(_settings,_section+'/'+_name)",
        '     if _toggle:break',
        '    if not _toggle:',
        "     _result={'ok':False,'error':'switch-not-found'}",
        '    else:',
        '     try:',
        '      gui.set_toggle_state_new(_settings,_toggle,_value)',
        '     except Exception as _e:',
        "      _result={'ok':False,'error':'set-failed','detail':str(_e)}",
        '     else:',
        '      try:_state=bool(gui.get_toggle_state(_settings,_toggle))',
        '      except:_state=None',
        "      _result={'ok':_state==_value,'via':'ui','value':_state,'error':None if _state==_value else 'ui-rejected'}",
    ].join('\n');
}

export interface DebugSwitchesState {
    states: Record<string, boolean | null>;
    settingsOpen: boolean;
    error?: string;
}

export interface DebugSwitchSetResult {
    ok: boolean;
    via?: 'option' | 'ui';
    value?: boolean | null;
    error?: string;
    detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBooleanOrNull(value: unknown): boolean | null | undefined {
    if (value === null) {
        return null;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    return undefined;
}

export function parseDebugSwitchesState(value: unknown): DebugSwitchesState {
    if (!isRecord(value)) {
        return { states: {}, settingsOpen: false, error: 'invalid-result' };
    }
    const states: Record<string, boolean | null> = {};
    const rawStates = isRecord(value.states) ? value.states : {};
    for (const definition of DEBUG_SWITCHES) {
        const parsed = readBooleanOrNull(rawStates[definition.id]);
        if (parsed !== undefined) {
            states[definition.id] = parsed;
        }
    }
    return {
        states,
        settingsOpen: value.settingsOpen === true,
        error: typeof value.error === 'string' ? value.error : undefined,
    };
}

export function parseDebugSwitchSetResult(value: unknown): DebugSwitchSetResult {
    if (!isRecord(value)) {
        return { ok: false, error: 'invalid-result' };
    }
    const parsedValue = readBooleanOrNull(value.value);
    const via = value.via === 'option' || value.via === 'ui' ? value.via : undefined;
    return {
        ok: value.ok === true,
        via,
        value: parsedValue === undefined ? null : parsedValue,
        error: typeof value.error === 'string' ? value.error : undefined,
        detail: typeof value.detail === 'string' ? value.detail : undefined,
    };
}
