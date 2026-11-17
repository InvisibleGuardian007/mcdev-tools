import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildDebugSettingsProbeCode,
    buildOpenPauseCode,
    buildOpenSettingsViaControlCode,
    parseDebugSettingsProbe,
} from './debugSwitchSettings';

test('settings probe code reads screens and the pause settings button geometry', () => {
    const code = buildDebugSettingsProbeCode();
    assert.match(code, /settings\.screen_world_controls_and_settings/);
    assert.match(code, /pause\.pause_screen/);
    assert.match(code, /settings_button/);
    assert.match(code, /get_global_position/);
    assert.match(code, /get_size/);
    assert.match(code, /get_client_ui_screen_size/);
    assert.match(code, /get_client_screen_size/);
    assert.ok(!/[^\x00-\x7f]/.test(code), 'generated Python must stay ASCII');
});

test('pause opener never pushes the settings screen', () => {
    const code = buildOpenPauseCode();
    assert.match(code, /open_pause_gui\(True\)/);
    assert.doesNotMatch(code, /settings\.screen_world_controls_and_settings/);
});

test('settings can be opened through the native button id without the mouse', () => {
    const code = buildOpenSettingsViaControlCode();
    assert.match(code, /get_button_id/);
    assert.match(code, /simulate_button_event/);
    assert.doesNotMatch(code, /set_toggle_state_new/);
    assert.doesNotMatch(code, /push_screen/);
    assert.ok(!/[^\x00-\x7f]/.test(code), 'generated Python must stay ASCII');
});

test('probe parser keeps valid geometry and drops malformed points', () => {
    const parsed = parseDebugSettingsProbe({
        settingsOpen: false,
        pauseOpen: true,
        pos: [52, 153],
        size: [178, 28],
        ui: [534, 300],
        client: [1602, 900],
    });
    assert.deepEqual(parsed, {
        settingsOpen: false,
        pauseOpen: true,
        pos: [52, 153],
        size: [178, 28],
        ui: [534, 300],
        client: [1602, 900],
        error: undefined,
    });

    const malformed = parseDebugSettingsProbe({
        settingsOpen: true,
        pauseOpen: false,
        pos: ['52', 153],
        size: [178],
    });
    assert.equal(malformed?.settingsOpen, true);
    assert.equal(malformed?.pos, undefined);
    assert.equal(malformed?.size, undefined);
    assert.equal(parseDebugSettingsProbe(null), undefined);
});
