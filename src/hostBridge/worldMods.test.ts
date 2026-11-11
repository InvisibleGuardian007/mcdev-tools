import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    applyWorldAutoMods,
    collectModCandidates,
    indexModPacks,
    readIncludedModDirs,
    readWorldPackIds,
    resolveWorldModDirs,
} from './worldMods';

const MOD_PACK_UUID = '5b6f554f-3077-4d71-8be8-39af1634fcde';
const MOD_RES_UUID = '33ab82f9-340e-4951-9136-5c9408a18d6e';
const SIBLING_UUID = 'A2023BC8-BE88-BE88-BE88-ABC888CED000';
const DEBUG_UUID = 'c329b06f-7492-4457-9af3-b19ff29999f9';

function writeManifest(packDir: string, uuid: string): void {
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
        path.join(packDir, 'manifest.json'),
        JSON.stringify({ format_version: 1, header: { uuid, version: [1, 0, 0] }, modules: [] }),
        'utf8',
    );
}

function setup(): { root: string; workspace: string; sibling: string; world: string; worldsRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-worldmods-'));
    const workspace = path.join(root, 'MyMod');
    const sibling = path.join(root, 'Sibling');
    const world = path.join(root, 'worlds', '魔物娘项目3.10');
    // 工作区根下的行为包 / 资源包
    writeManifest(path.join(workspace, 'my_mod_behavior_pack'), MOD_PACK_UUID);
    writeManifest(path.join(workspace, 'my_mod_resource_pack'), MOD_RES_UUID);
    // 同级目录里的第三方 mod
    writeManifest(path.join(sibling, 'Sibling_behavior_pack'), SIBLING_UUID);
    fs.mkdirSync(world, { recursive: true });
    fs.writeFileSync(
        path.join(world, 'world_behavior_packs.json'),
        '\uFEFF' + JSON.stringify([{ pack_id: MOD_PACK_UUID }, { pack_id: SIBLING_UUID }, { pack_id: DEBUG_UUID }]),
        'utf8',
    );
    fs.writeFileSync(
        path.join(world, 'world_resource_packs.json'),
        JSON.stringify([{ pack_id: MOD_RES_UUID }]),
        'utf8',
    );
    return { root, workspace, sibling, world, worldsRoot: path.join(root, 'worlds') };
}

test('readWorldPackIds 读取行为包与资源包 id（容忍 BOM）', () => {
    const ctx = setup();
    try {
        const ids = readWorldPackIds(ctx.world);
        assert.equal(ids.behavior.length, 3);
        assert.equal(ids.resource.length, 1);
        assert.ok(ids.behavior.includes(MOD_PACK_UUID.replace(/-/g, '').toLowerCase()));
    } finally {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    }
});

test('indexModPacks 建立 uuid -> pack 目录索引', () => {
    const ctx = setup();
    try {
        const index = indexModPacks(collectModCandidates(ctx.workspace, ['.', ctx.sibling]));
        assert.equal(index.get(MOD_PACK_UUID.replace(/-/g, '').toLowerCase())?.length, 1);
        assert.equal(index.get(SIBLING_UUID.replace(/-/g, '').toLowerCase())?.length, 1);
    } finally {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    }
});

test('resolveWorldModDirs 把工作区根写成 ./ 并把找不到的包记为 unknown', () => {
    const ctx = setup();
    try {
        const resolution = resolveWorldModDirs(ctx.workspace, ctx.world, ['.', ctx.sibling]);
        assert.deepEqual(resolution.dirs, ['./', ctx.sibling]);
        assert.equal(resolution.matchedPacks, 3);
        assert.deepEqual(resolution.unknownPacks, [DEBUG_UUID.replace(/-/g, '').toLowerCase().trim()]);
    } finally {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    }
});

test('applyWorldAutoMods 重写 included_mod_dirs 并保留原有条目的开关', () => {
    const ctx = setup();
    try {
        const configPath = path.join(ctx.workspace, '.mcdev.json');
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                world_folder_name: '魔物娘项目3.10',
                // 第三个目录该存档没引用，装配时会被移出列表
                included_mod_dirs: ['./', { path: ctx.sibling, enabled: false }, path.join(ctx.root, 'UnusedMod')],
            }),
            'utf8',
        );
        const result = applyWorldAutoMods(ctx.workspace, { worldsRoot: ctx.worldsRoot });
        assert.equal(result.status, 'applied');
        assert.equal(result.dirs.length, 2);
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // 未引用的目录被移出，原有条目的 enabled 开关保留
        assert.deepEqual(saved.included_mod_dirs, ['./', { path: ctx.sibling, enabled: false }]);
        assert.deepEqual(readIncludedModDirs(ctx.workspace), ['./', ctx.sibling]);

        // 再次执行应判定为无需改动
        const again = applyWorldAutoMods(ctx.workspace, { worldsRoot: ctx.worldsRoot });
        assert.equal(again.status, 'unchanged');
    } finally {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    }
});

test('applyWorldAutoMods 尊重 world_auto_mods=false，force 时仍然生效', () => {
    const ctx = setup();
    try {
        const configPath = path.join(ctx.workspace, '.mcdev.json');
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                world_folder_name: '魔物娘项目3.10',
                world_auto_mods: false,
                included_mod_dirs: ['./', { path: ctx.sibling, enabled: false }, path.join(ctx.root, 'UnusedMod')],
            }),
            'utf8',
        );
        assert.equal(applyWorldAutoMods(ctx.workspace, { worldsRoot: ctx.worldsRoot }).status, 'skipped');
        const forced = applyWorldAutoMods(ctx.workspace, { worldsRoot: ctx.worldsRoot, force: true });
        assert.equal(forced.status, 'applied');
        assert.equal(forced.dirs.length, 2);
    } finally {
        fs.rmSync(ctx.root, { recursive: true, force: true });
    }
});
