import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    FANCY_GRAPHICS_MODE,
    VIBRANT_GRAPHICS_MODE,
    applyRenderEngine,
    buildRenderEngineValues,
    clampOpenGLGraphicsMode,
    parseRenderEngineState,
    readRenderEngineState,
    resolveOptionsPath,
    setOptionValues
} from './options';

const CRLF_SAMPLE = [
    'mp_username:"steve"',
    'gfx_viewdistance:256',
    'gfx_renderengine:0',
    'graphics_mode:1',
    ''
].join('\r\n');

test('setOptionValues updates existing keys and keeps every other byte', () => {
    const result = setOptionValues(CRLF_SAMPLE, {
        gfx_renderengine: '1',
        graphics_mode: '2'
    });

    assert.equal(result.changed, true);
    assert.equal(result.text, [
        'mp_username:"steve"',
        'gfx_viewdistance:256',
        'gfx_renderengine:1',
        'graphics_mode:2',
        ''
    ].join('\r\n'));
});

test('setOptionValues appends keys that do not exist yet', () => {
    const result = setOptionValues('a:1\r\n', { graphics_mode: '2' });

    assert.equal(result.changed, true);
    assert.equal(result.text, 'a:1\r\ngraphics_mode:2\r\n');
});

test('setOptionValues reports no change when the file already matches', () => {
    const result = setOptionValues(CRLF_SAMPLE, {
        gfx_renderengine: '0',
        graphics_mode: '1'
    });

    assert.equal(result.changed, false);
    assert.equal(result.text, CRLF_SAMPLE);
});

test('setOptionValues keeps files without a trailing newline', () => {
    const result = setOptionValues('a:1\r\nb:2', { b: '3' });
    assert.equal(result.text, 'a:1\r\nb:3');
});

test('parseRenderEngineState maps the options to the two supported engines', () => {
    assert.equal(parseRenderEngineState('gfx_renderengine:1\r\ngraphics_mode:2\r\n', 'x').mode, 'renderdragon');
    assert.equal(parseRenderEngineState('gfx_renderengine:1\r\ngraphics_mode:2\r\n', 'x').graphicsMode, VIBRANT_GRAPHICS_MODE);
    assert.equal(parseRenderEngineState('gfx_renderengine:0\r\ngraphics_mode:0\r\n', 'x').mode, 'opengl');
    assert.equal(parseRenderEngineState('gfx_renderengine:0\r\ngraphics_mode:0\r\n', 'x').graphicsMode, 0);
    // 缺少键时按游戏默认值处理：OpenGL
    assert.equal(parseRenderEngineState('a:1\r\n', 'x').mode, 'opengl');
    assert.equal(parseRenderEngineState('a:1\r\n', 'x').graphicsMode, 0);
});

test('buildRenderEngineValues keeps OpenGL on a supported graphics mode', () => {
    assert.deepEqual(buildRenderEngineValues('renderdragon'), {
        gfx_renderengine: '1',
        graphics_mode: String(VIBRANT_GRAPHICS_MODE)
    });
    assert.deepEqual(buildRenderEngineValues('opengl', 0), {
        gfx_renderengine: '0',
        graphics_mode: '0'
    });
    assert.deepEqual(buildRenderEngineValues('opengl', VIBRANT_GRAPHICS_MODE), {
        gfx_renderengine: '0',
        graphics_mode: String(FANCY_GRAPHICS_MODE)
    });
});

test('clampOpenGLGraphicsMode falls back to fancy for unknown values', () => {
    assert.equal(clampOpenGLGraphicsMode(0), 0);
    assert.equal(clampOpenGLGraphicsMode(1), 1);
    assert.equal(clampOpenGLGraphicsMode(2), 1);
    assert.equal(clampOpenGLGraphicsMode(undefined), 1);
});

test('resolveOptionsPath uses APPDATA of the China edition', () => {
    assert.equal(
        resolveOptionsPath({ APPDATA: 'C:/Users/me/AppData/Roaming' } as NodeJS.ProcessEnv),
        path.join('C:/Users/me/AppData/Roaming', 'MinecraftPE_Netease', 'minecraftpe', 'options.txt')
    );
    assert.equal(resolveOptionsPath({} as NodeJS.ProcessEnv), undefined);
});

test('applyRenderEngine writes renderdragon then restores OpenGL with the previous graphics mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-render-engine-'));
    const optionsPath = path.join(dir, 'options.txt');
    try {
        fs.writeFileSync(optionsPath, 'mp_username:"steve"\r\ngfx_renderengine:0\r\ngraphics_mode:0\r\n', 'utf8');

        const dragon = applyRenderEngine('renderdragon', optionsPath);
        assert.equal(dragon.ok, true);
        assert.equal(dragon.changed, true);
        assert.equal(dragon.state?.mode, 'renderdragon');
        assert.equal(dragon.state?.graphicsMode, VIBRANT_GRAPHICS_MODE);
        assert.match(fs.readFileSync(optionsPath, 'utf8'), /gfx_renderengine:1\r\ngraphics_mode:2\r\n$/);

        const openGL = applyRenderEngine('opengl', optionsPath, 0);
        assert.equal(openGL.ok, true);
        assert.equal(openGL.state?.mode, 'opengl');
        assert.equal(openGL.state?.graphicsMode, 0);
        assert.match(fs.readFileSync(optionsPath, 'utf8'), /gfx_renderengine:0\r\ngraphics_mode:0\r\n$/);

        assert.equal(readRenderEngineState(optionsPath).mode, 'opengl');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('applyRenderEngine reports a missing options.txt instead of creating one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-render-engine-missing-'));
    const optionsPath = path.join(dir, 'options.txt');
    try {
        const result = applyRenderEngine('renderdragon', optionsPath);
        assert.equal(result.ok, false);
        assert.equal(result.error, 'options-not-found');
        assert.equal(fs.existsSync(optionsPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
