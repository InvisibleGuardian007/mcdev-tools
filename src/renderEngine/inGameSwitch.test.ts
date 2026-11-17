import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildClickScript,
    buildDropdownAnchorCode,
    buildDropdownOpenStateCode,
    buildEscScript,
    buildFastClickerScript,
    buildFastKeysScript,
    buildOpenDropdownCode,
    buildOpenSettingsCode,
    buildPickOptionCode,
    buildPickRadioByPathCode,
    buildQueryScreenCode,
    buildReadDropdownCode,
    buildReadLabelsCode,
    buildSelectVideoTabCode,
    buildSwitchScript,
    buildWaitSettingsCode,
    classifyScreens,
    detectScreen,
    dropdownContentPath,
    dropdownOptionsGroupCandidates,
    dropdownOptionsContentCandidates,
    scrollViewCandidates,
    dropdownLabelPath,
    isInWorld,
    optionPointFromGeometry,
    readLogFromOffset
} from './inGameSwitch';

const ENGINE = 'engine_dropdown' as const;
const ALL_SCRIPTS = [
    buildSelectVideoTabCode(),
    buildOpenDropdownCode(ENGINE),
    buildPickOptionCode(ENGINE, 1, 2),
    buildPickRadioByPathCode(ENGINE, 1),
    buildReadDropdownCode(ENGINE),
    buildReadLabelsCode(),
    buildWaitSettingsCode(),
    buildOpenSettingsCode(),
    buildQueryScreenCode(),
    buildDropdownOpenStateCode(ENGINE),
    buildDropdownAnchorCode(ENGINE)
];

test('buildSwitchScript 不再生成任何坐标点击脚本', () => {
    const script = buildSwitchScript('renderdragon');
    assert.equal(script.includes('Click-At'), false);
    assert.equal(script.includes('Drag-From'), false);
    assert.equal(script.includes('Scroll-At'), false);
    assert.equal(script.includes('0x0201'), false);
});

test('buildSwitchScript 不依赖客户区尺寸', () => {
    const script = buildSwitchScript('opengl', 800, 450);
    assert.equal(script.includes('800'), false);
    assert.equal(script.includes('450'), false);
});

test('游戏内脚本不含写死的坐标、格子序号或鼠标模拟', () => {
    for (const script of ALL_SCRIPTS) {
        // 不允许写死的滚动像素点（历史实现里的 320/700 拖拽点）
        assert.equal(/set_scroll_view_percent_value\([^)]*\b(320|700)\b/.test(script), false);
        // 不允许按序号猜分类按钮（video_button_1 这类格子写法）
        assert.equal(/video_button_\d/.test(script), false, '不应再依赖写死的分类格子');
        // 不允许在游戏内模拟鼠标：合成事件会被游戏丢弃，点击一律交给宿主
        assert.equal(script.includes('simulate_button_event'), false);
        assert.equal(script.includes('simulate_touch_with_mouse'), false);
    }
});

test('游戏内脚本一律走真实控件路径定位', () => {
    const open = buildOpenDropdownCode(ENGINE);
    assert.equal(open.includes('rendering_engine_dropdown'), true);
    assert.equal(open.includes('dropdown_content'), true);
    assert.equal(open.includes('radio_control_group'), true);
    const tab = buildSelectVideoTabCode();
    assert.equal(tab.includes('video_button_toggle'), true);
});

test('dropdownContentPath 由下拉路径推出同级浮层', () => {
    assert.equal(dropdownContentPath('/root/rendering_engine/dropdown/rendering_engine_dropdown'), '/root/rendering_engine/dropdown/dropdown_content');
});

test('dropdownLabelPath 指向未选中态标签', () => {
    const dropdown = '/root/rendering_engine/dropdown/rendering_engine_dropdown';
    const label = dropdownLabelPath(dropdown);
    assert.equal(label.indexOf(dropdown + '/unchecked/'), 0);
    assert.equal(label.endsWith('/label_panel/label'), true);
});

test('选项路径同时支持 scroll_mouse 与 scroll_touch 两种输入模式', () => {
    const groups = dropdownOptionsGroupCandidates('/a/dropdown_content');
    const contents = dropdownOptionsContentCandidates('/a/dropdown_content');
    assert.equal(groups.some((g: string) => g.indexOf('/scroll/scroll_mouse/scroll_view/') > 0), true);
    assert.equal(groups.some((g: string) => g.indexOf('/scroll/scroll_touch/scroll_view/') > 0), true);
    assert.equal(contents.some((c: string) => c.indexOf('/scroll/scroll_mouse/scroll_view/') > 0), true);
    assert.equal(contents.some((c: string) => c.indexOf('/scroll/scroll_touch/scroll_view/') > 0), true);
    assert.equal(groups.every((g: string) => g.endsWith('/radio_control_group')), true);
});

test('设置页左右栏滚动容器也支持两种输入模式', () => {
    const left = scrollViewCandidates('/x/selector_area/scrolling_panel');
    assert.equal(left.some((p: string) => p.indexOf('/scroll_mouse/') > 0), true);
    assert.equal(left.some((p: string) => p.indexOf('/scroll_touch/') > 0), true);
    assert.equal(left.every((p: string) => p.endsWith('/scroll_view')), true);
});

test('下拉选项优先按控件树下标直接选中，不依赖鼠标', () => {
    const code = buildPickRadioByPathCode('graphics_dropdown', 2);
    assert.match(code, /IDX=2/);
    assert.match(code, /radio_with_label_core/);
    assert.match(code, /set_toggle_state_new/);
    assert.doesNotMatch(code, /mouse_event/);
});

test('设置页内容与下拉浮层同时支持 panel / stack_panel 包裹层', () => {
    const select = buildSelectVideoTabCode();
    assert.match(select, /stack_panel/);
    assert.match(select, /_content\(/);
    const options = dropdownOptionsContentCandidates('/x/dropdown_content');
    assert.equal(options.some((p: string) => p.indexOf('/panel/') > 0), true);
    assert.equal(options.some((p: string) => p.indexOf('/stack_panel/') > 0), true);
});

test('optionPointFromGeometry 按选项数均分浮层高度', () => {
    const geometry = { x: 100, y: 200, w: 300, h: 57, scale: 3 };
    const first = optionPointFromGeometry(geometry, 0, 3);
    const third = optionPointFromGeometry(geometry, 2, 3);
    assert.deepEqual(first, { x: 750, y: 629 });
    assert.deepEqual(third, { x: 750, y: 743 });
});

test('optionPointFromGeometry 优先使用传入的行高', () => {
    const geometry = { x: 226.6, y: 197, w: 300.4, h: 38, scale: 3 };
    assert.deepEqual(optionPointFromGeometry(geometry, 0, 2, 19), { x: 1130, y: 620 });
    assert.deepEqual(optionPointFromGeometry(geometry, 1, 2, 19), { x: 1130, y: 677 });
});

test('optionPointFromGeometry 对越界索引做收敛', () => {
    const geometry = { x: 0, y: 0, w: 10, h: 40, scale: 1 };
    assert.deepEqual(optionPointFromGeometry(geometry, -5, 2), { x: 5, y: 10 });
});

test('optionPointFromGeometry 在选项数为 0 时不会除以零', () => {
    const point = optionPointFromGeometry({ x: 0, y: 0, w: 10, h: 20, scale: 2 }, 0, 0);
    assert.equal(Number.isFinite(point.y), true);
    assert.deepEqual(point, { x: 10, y: 20 });
});

test('buildClickScript 用真实鼠标事件，不用 PostMessage', () => {
    const script = buildClickScript(423, 500);
    assert.equal(script.includes('SetCursorPos'), true);
    assert.equal(script.includes('mouse_event'), true);
    assert.equal(script.includes('0x0201'), false, 'PostMessage 会被游戏丢弃');
    // 客户区原点由 ClientToScreen 求，不写死窗口位置
    assert.equal(script.includes('ClientToScreen'), true);
    assert.equal(script.includes('423'), true);
    assert.equal(script.includes('500'), true);
});

test('buildClickScript 负坐标收敛到 0', () => {
    const script = buildClickScript(-30, -8);
    assert.equal(script.includes('-30'), false);
    assert.equal(script.includes('-8'), false);
});

test('buildEscScript 用真实键盘事件', () => {
    const script = buildEscScript();
    assert.equal(script.includes('keybd_event'), true);
    assert.equal(script.includes('0x1B'), true);
    assert.equal(script.includes('0x100'), false, 'PostMessage 的 WM_KEY 会被丢弃');
});

test('常驻点击器脚本按行接收坐标并缓存客户区原点', () => {
    const script = buildFastClickerScript();
    assert.equal(script.includes('ReadLine'), true);
    assert.equal(script.includes('ClientToScreen'), true);
    assert.equal(script.includes('mouse_event'), true);
    assert.equal(script.includes('ready'), true);
});

test('常驻键盘输入器脚本按行接收虚拟键码', () => {
    const script = buildFastKeysScript();
    assert.equal(script.includes('ReadLine'), true);
    assert.equal(script.includes('keybd_event'), true);
    assert.equal(script.includes('TryParse'), true);
    assert.equal(script.includes('ready'), true);
});

test('classifyScreens 识别原版设置页与存档', () => {
    assert.equal(classifyScreens(['hud.hud_screen', 'pause.pause_screen',
        'settings.screen_world_controls_and_settings']), 'settings');
    assert.equal(classifyScreens(['hud.hud_screen', 'pause.pause_screen']), 'pause');
    assert.equal(classifyScreens(['hud.hud_screen']), 'world');
});

test('classifyScreens 遇到自定义界面返回 other', () => {
    assert.equal(classifyScreens(['hud.hud_screen', 'arrisCustomKeyBinding.arrisKeyBindingScreen']), 'other');
});

test('classifyScreens 忽略原版进度界面', () => {
    assert.equal(classifyScreens(['progress.modal_progress_screen']), 'other');
    assert.equal(classifyScreens(['hud.hud_screen', 'toast_screen.toast_screen']), 'world');
});

test('isInWorld 依据最后一条输入映射判断是否在存档内', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-inworld-'));
    const file = path.join(dir, 'Debug_Log.txt');
    fs.writeFileSync(file, "[x] Controller 0: Pushing input mapping: 'gamePlayNormal'\n");
    assert.equal(isInWorld(file), true);
    fs.appendFileSync(file, "[x] Controller 0: Popping input mapping: 'screen', new mapping: 'gamePlayNormal'.\n");
    fs.appendFileSync(file, "[x] Controller 0: Pushing input mapping: 'screen'\n");
    assert.equal(isInWorld(file), false);
    assert.equal(isInWorld(undefined), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('detectScreen 遇到未识别的自定义顶层界面时停止自动操作', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-custom-screen-'));
    const file = path.join(dir, 'Debug_Log.txt');
    fs.writeFileSync(file, [
        "[x] GUI: Created 'pause.pause_screen' screen in 1ms",
        "[x] GUI: Created 'settings.screen_world_controls_and_settings' screen in 1ms",
        "[x] GUI: Created 'arrisCustomKeyBinding.arrisKeyBindingScreen' screen in 1ms",
        "[x] INPUT: Pushing input mapping: 'screen'"
    ].join('\n'));
    assert.equal(detectScreen(file), 'other');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('detectScreen 识别原版设置页', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-settings-'));
    const file = path.join(dir, 'Debug_Log.txt');
    fs.writeFileSync(file, [
        "[x] GUI: Created 'pause.pause_screen' screen in 1ms",
        "[x] GUI: Created 'settings.screen_world_controls_and_settings' screen in 1ms",
        "[x] INPUT: Pushing input mapping: 'screen'"
    ].join('\n'));
    assert.equal(detectScreen(file), 'settings');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readLogFromOffset 只返回新增内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-log-'));
    const file = path.join(dir, 'Debug_Log.txt');
    fs.writeFileSync(file, 'old line\n');
    const offset = fs.statSync(file).size;
    fs.appendFileSync(file, 'Enter the RenderDragon!\n');
    const fresh = readLogFromOffset(file, offset);
    assert.equal(fresh.includes('Enter the RenderDragon'), true);
    assert.equal(fresh.includes('old line'), false);
    fs.rmSync(dir, { recursive: true, force: true });
});
