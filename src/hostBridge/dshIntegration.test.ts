import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildDshPatchEntry,
    installDshMcpEntry,
    listDshPatchFiles,
    upsertDshPatchEntry,
} from './dshIntegration';

const URL = 'http://localhost:19133/mcp';

test('buildDshPatchEntry emits a marked dsh-mcp-client insert block', () => {
    const entry = buildDshPatchEntry(URL, { name: 'minecraft' });
    assert.match(entry, /^- insert: # mcdev-tools mcdk$/m);
    assert.match(entry, /^ {4}- id: mcdev-mcp-minecraft$/m);
    assert.match(entry, /^ {6}name: "@deepseek-ai\/dsh-mcp-client"$/m);
    assert.match(entry, /^ {8}transport: "streamable-http"$/m);
    assert.ok(entry.includes(`url: "${URL}"`));
});

test('upsertDshPatchEntry appends once and replaces in place afterwards', () => {
    const original = ['- insert: # magpie', '    - id: magpie-mcp-fetch', '      name: "@deepseek-ai/dsh-mcp-client"', ''].join('\n');
    const entry = buildDshPatchEntry(URL);
    const once = upsertDshPatchEntry(original, entry);
    assert.ok(once.includes('magpie-mcp-fetch'), 'keeps the existing entry');
    assert.equal(once.split('id: mcdev-mcp-minecraft').length - 1, 1);

    const twice = upsertDshPatchEntry(once, buildDshPatchEntry(URL));
    assert.equal(twice, once, 'unchanged url keeps the file byte-identical');

    const replaced = upsertDshPatchEntry(once, buildDshPatchEntry('http://localhost:20000/mcp'));
    assert.ok(replaced.includes('http://localhost:20000/mcp'));
    assert.ok(!replaced.includes('19133/mcp'), 'old endpoint is gone');
    assert.equal(replaced.split('id: mcdev-mcp-minecraft').length - 1, 1, 'no duplicated entries');
});

test('upsertDshPatchEntry replaces the old url and keeps neighbours intact', () => {
    const file = [
        '- insert: # magpie',
        '    - id: magpie-mcp-context7',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: "context7"',
        '        transport: "streamable-http"',
        '        url: "https://mcp.context7.com/mcp"',
        '- insert: # mcdev-tools mcdk',
        '    - id: mcdev-mcp-minecraft',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: "minecraft"',
        '        transport: "streamable-http"',
        '        url: "http://localhost:19133/mcp"',
        '- insert: # magpie',
        '    - id: magpie-mcp-memory',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: "memory"',
        '        transport: "stdio"',
        '        command: "node"',
        '',
    ].join('\n');
    const next = upsertDshPatchEntry(file, buildDshPatchEntry('http://127.0.0.1:20000/mcp'));
    assert.ok(next.includes('url: "http://127.0.0.1:20000/mcp"'));
    assert.ok(!next.includes('http://localhost:19133/mcp'));
    assert.ok(next.includes('magpie-mcp-context7') && next.includes('magpie-mcp-memory'));
    assert.equal(next.split('- insert:').length - 1, 3, 'still three top-level entries');
});

test('installDshMcpEntry writes every profile and is idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdev-dsh-'));
    const webDir = path.join(root, 'profiles', 'web');
    const desktopDir = path.join(root, 'profiles', 'desktop');
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'cordis.patch.yml'), '- insert: # magpie\n    - id: magpie-mcp-fetch\n', 'utf8');
    fs.writeFileSync(path.join(desktopDir, 'cordis.patch.yml'), '[]\n', 'utf8');

    assert.equal(listDshPatchFiles(root).length, 2);
    const first = installDshMcpEntry({ url: URL, root });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.changed.length, 2);
    assert.ok(fs.existsSync(path.join(webDir, 'cordis.patch.yml.mcdev.bak')));
    const webContent = fs.readFileSync(path.join(webDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(webContent.includes('id: mcdev-mcp-minecraft'));
    assert.ok(webContent.includes('magpie-mcp-fetch'));

    const second = installDshMcpEntry({ url: URL, root });
    assert.equal(second.ok, true);
    assert.deepEqual(second.changed, [], 'same url writes nothing');
    assert.equal(fs.readFileSync(path.join(webDir, 'cordis.patch.yml'), 'utf8'), webContent);

    const moved = installDshMcpEntry({ url: 'http://localhost:20000/mcp', root });
    assert.equal(moved.changed.length, 2);
    assert.ok(fs.readFileSync(path.join(webDir, 'cordis.patch.yml'), 'utf8').includes('http://localhost:20000/mcp'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('installDshMcpEntry reports a missing dsh directory instead of throwing', () => {
    const result = installDshMcpEntry({ url: URL, root: path.join(os.tmpdir(), 'mcdev-dsh-does-not-exist-xyz') });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no dsh profiles');
});
