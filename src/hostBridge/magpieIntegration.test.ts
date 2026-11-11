import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildMagpieAddArgs,
    buildMagpieShowArgs,
    buildMagpieSyncArgs,
    listMagpieExecutables,
    parseWrittenAgents,
} from './magpieIntegration';

const URL = 'http://localhost:19133/mcp';

test('buildMagpieAddArgs 拼出 library mcp add + agents', () => {
    assert.deepEqual(buildMagpieAddArgs(URL), [
        'library',
        'mcp',
        'add',
        'minecraft',
        URL,
        'agents=claude,codex,dsh,workbuddy,zcode',
    ]);
    assert.deepEqual(buildMagpieAddArgs(` ${URL} `, { name: 'mc', agents: ['dsh'] }), [
        'library',
        'mcp',
        'add',
        'mc',
        URL,
        'agents=dsh',
    ]);
    assert.deepEqual(buildMagpieSyncArgs(), ['library', 'sync']);
    assert.deepEqual(buildMagpieShowArgs(), ['library', 'mcp', 'show', 'minecraft']);
});

test('parseWrittenAgents 只取 written into 后面的 agent 名并去重', () => {
    assert.deepEqual(parseWrittenAgents('✓ written into claude, codex, zcode, workbuddy'), [
        'claude',
        'codex',
        'zcode',
        'workbuddy',
    ]);
    assert.deepEqual(
        parseWrittenAgents(['prefix', '✓ written into claude, dsh', '✓ written into dsh, claude', 'unrelated line'].join('\n')),
        ['claude', 'dsh'],
        '多行合并 + 去重'
    );
    assert.deepEqual(parseWrittenAgents('  C:\\Users\\x before what was there'), [], '没有 written into 就返回空');
    assert.deepEqual(parseWrittenAgents(''), []);
});

test('listMagpieExecutables 按顺序找到真实存在的可执行文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-magpie-'));
    const configured = path.join(root, 'custom-magpie.exe');
    const localAppData = path.join(root, 'local');
    const inLocal = path.join(localAppData, 'magpie', 'magpie.exe');
    fs.mkdirSync(path.dirname(inLocal), { recursive: true });
    fs.writeFileSync(configured, 'x');
    fs.writeFileSync(inLocal, 'x');

    const env = {
        LOCALAPPDATA: localAppData,
        APPDATA: path.join(root, 'roaming'),
        USERPROFILE: path.join(root, 'home'),
        PATH: path.join(root, 'bin'),
    } as unknown as NodeJS.ProcessEnv;

    const found = listMagpieExecutables(env, [configured, path.join(root, 'missing.exe')]);
    assert.equal(found[0], configured, '显式配置优先');
    assert.ok(found.includes(inLocal), '常见安装位置也能找到');
    assert.equal(
        found.filter(item => item.toLowerCase() === configured.toLowerCase()).length,
        1,
        '重复候选只保留一份'
    );

    assert.deepEqual(listMagpieExecutables(env, []).length >= 0, true);
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-magpie-empty-'));
    assert.deepEqual(
        listMagpieExecutables({ LOCALAPPDATA: emptyRoot, PATH: emptyRoot } as unknown as NodeJS.ProcessEnv, []),
        [],
        '什么都没有时返回空数组而不是抛错'
    );
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(emptyRoot, { recursive: true, force: true });
});
