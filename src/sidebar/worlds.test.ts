import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listMinecraftWorlds } from './worlds';

function makeWorld(root: string, folder: string, options: { name?: string; packs?: unknown; levelMtime?: Date }): void {
    const dir = path.join(root, folder);
    fs.mkdirSync(dir, { recursive: true });
    if (typeof options.name === 'string') {
        fs.writeFileSync(path.join(dir, 'levelname.txt'), options.name, 'utf8');
    }
    if (options.packs !== undefined) {
        fs.writeFileSync(path.join(dir, 'world_behavior_packs.json'), JSON.stringify(options.packs), 'utf8');
    }
    fs.writeFileSync(path.join(dir, 'level.dat'), 'level', 'utf8');
    if (options.levelMtime) {
        fs.utimesSync(path.join(dir, 'level.dat'), options.levelMtime, options.levelMtime);
    }
}

test('listMinecraftWorlds 读取世界名、包数量并按修改时间倒序', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-worlds-'));
    try {
        makeWorld(root, 'old_world', {
            name: '\uFEFF旧存档\r\nsecond line',
            packs: [{ pack_id: 'a' }, { pack_id: 'b' }],
            levelMtime: new Date('2024-01-01T00:00:00Z'),
        });
        makeWorld(root, 'new_world', {
            name: '新存档',
            packs: [],
            levelMtime: new Date('2024-06-01T00:00:00Z'),
        });
        fs.mkdirSync(path.join(root, 'broken_world'), { recursive: true });

        const worlds = listMinecraftWorlds(root);
        assert.equal(worlds.length, 3);
        assert.equal(worlds[0].folder, 'new_world');
        assert.equal(worlds[0].name, '新存档');
        assert.equal(worlds[0].packs, 0);
        assert.equal(worlds[1].folder, 'old_world');
        // BOM 与第二行都要被去掉，只保留世界名
        assert.equal(worlds[1].name, '旧存档');
        assert.equal(worlds[1].packs, 2);
        // 缺少 levelname.txt / 包清单时回退到文件夹名与 0
        assert.equal(worlds[2].folder, 'broken_world');
        assert.equal(worlds[2].name, 'broken_world');
        assert.equal(worlds[2].packs, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('listMinecraftWorlds 在目录不存在时返回空数组', () => {
    assert.deepEqual(listMinecraftWorlds(path.join(os.tmpdir(), 'mcdev-missing-worlds-dir')), []);
});
