import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDebugSwitchSetCode,
    buildDebugSwitchesStateCode,
    DEBUG_SWITCHES,
    findDebugSwitch,
    parseDebugSwitchSetResult,
    parseDebugSwitchesState,
} from './debugSwitches';

test('debug switch definitions are unique and complete', () => {
    const ids = new Set<string>();
    for (const definition of DEBUG_SWITCHES) {
        assert.ok(!ids.has(definition.id), `duplicate switch id: ${definition.id}`);
        ids.add(definition.id);
        assert.ok(definition.optionKeys.length > 0, `${definition.id} has no option key`);
        assert.ok(definition.controlNames.length > 0, `${definition.id} has no control name`);
    }
    assert.equal(findDebugSwitch('bounds')?.optionKeys[0], 'dev_renderBoundingBox');
    assert.equal(findDebugSwitch('chunkMap')?.optionKeys[0], 'dev_showchunkmap');
    assert.equal(findDebugSwitch('missing'), undefined);
});

test('state code reads every option key through the debug channel', () => {
    const code = buildDebugSwitchesStateCode();
    assert.match(code, /import _setting/);
    assert.match(code, /_setting\.get_option/);
    for (const definition of DEBUG_SWITCHES) {
        for (const key of definition.optionKeys) {
            assert.ok(code.includes(`"${key}"`), `state code is missing ${key}`);
        }
        assert.ok(code.includes(`"${definition.id}"`), `state code is missing ${definition.id}`);
    }
    assert.ok(!/[^\x00-\x7f]/.test(code), 'generated Python must stay ASCII');
});

test('set code tries engine options before the settings screen', () => {
    const code = buildDebugSwitchSetCode('bounds', true);
    assert.match(code, /_setting\.set_option\(_key,_value,False\)/);
    assert.match(code, /_setting\.get_option\(_key,0\)/);
    // 设置页必须由宿主用原生方式打开；脚本自己绝不 push（push 出来的页面是错乱的）
    assert.match(code, /settings-closed/);
    assert.doesNotMatch(code, /gui\.push_screen/);
    // 设置页的滚动容器有两种布局：老版本的 panel 和新版本的 stack_panel
    assert.match(code, /_wrappers=\['panel','stack_panel'\]/);
    assert.match(code, /'\/scroll_view\/'\+_w\+_suffix/);
    assert.match(code, /debug_button\/debug_button_toggle/);
    assert.match(code, /general_and_controls_sections\/debug_section/);
    assert.match(code, /option_toggle_0_1/);
    assert.match(code, /gui\.set_toggle_state_new/);
    assert.match(code, /gui\.get_toggle_state/);
    assert.match(code, /_id="bounds";_value=True/);
    assert.ok(!/[^\x00-\x7f]/.test(code), 'generated Python must stay ASCII');
});

test('set code rejects unknown switches and keeps values boolean', () => {
    assert.throws(() => buildDebugSwitchSetCode('nope', true), /Unknown debug switch/);
    const off = buildDebugSwitchSetCode('disableTerrain', false);
    assert.match(off, /_value=False/);
    assert.match(off, /"dev_disable_render_terrain"/);
    assert.match(off, /"option_toggle_disable_render_terrain"/);
});

test('state parser keeps known switches and drops unknown values', () => {
    const parsed = parseDebugSwitchesState({
        states: { bounds: true, chunkMap: null, unknown: true, paths: 'yes' },
        settingsOpen: true,
    });
    assert.equal(parsed.states.bounds, true);
    assert.equal(parsed.states.chunkMap, null);
    assert.equal(parsed.states.paths, undefined);
    assert.equal(parsed.states.unknown, undefined);
    assert.equal(parsed.settingsOpen, true);
    assert.equal(parsed.error, undefined);

    const invalid = parseDebugSwitchesState(null);
    assert.deepEqual(invalid, { states: {}, settingsOpen: false, error: 'invalid-result' });
});

test('set result parser validates channel, value and error', () => {
    assert.deepEqual(parseDebugSwitchSetResult({
        ok: true,
        via: 'option',
        value: true,
    }), { ok: true, via: 'option', value: true, error: undefined, detail: undefined });

    const rejected = parseDebugSwitchSetResult({
        ok: false,
        via: 'ui',
        value: null,
        error: 'ui-rejected',
        detail: 'toggle stayed off',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.via, 'ui');
    assert.equal(rejected.value, null);
    assert.equal(rejected.error, 'ui-rejected');
    assert.equal(rejected.detail, 'toggle stayed off');

    assert.deepEqual(parseDebugSwitchSetResult('bad'), { ok: false, error: 'invalid-result' });
});
