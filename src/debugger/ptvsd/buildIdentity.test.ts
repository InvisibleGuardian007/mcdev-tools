import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { CHUNK_SIZE, ChunkedFileReader, classifyBuild } from './buildIdentity';

const VANILLA = new Set([
    'kernel32.dll',
    'user32.dll',
    'dbghelp.dll',
    'microsoft.xbox.services.c.thunks.dll',
    'playfabmultiplayergdk.dll',
    'microsoft.windowsappruntime.bootstrap.dll'
]);

const MODPC = new Set([
    'kernel32.dll',
    'user32.dll',
    'dbghelp.dll',
    'crashhunter_pc3.dll',
    'libenvsdk.dll',
    'physx_64.dll',
    'physxfoundation_64.dll',
    'opengl32.dll'
]);

const PLAYER_CLIENT = new Set([
    'kernel32.dll',
    'user32.dll',
    'crashhunter_pc3.dll',
    'libenvsdk.dll',
    'physx_64.dll',
    'physxfoundation_64.dll',
    'ntunisdkbase.dll',
    'opengl32.dll'
]);

const EDITOR = new Set([
    'kernel32.dll',
    'user32.dll',
    'crashhunter_pc3.dll',
    'libenvsdk.dll',
    'physx_64.dll',
    'physxfoundation_64.dll',
    'opengl32.dll'
]);

test('build classifier recognizes a modpc build', () => {
    const identity = classifyBuild('Minecraft.Windows.exe', MODPC);
    assert.equal(identity.kind, 'modpc');
    assert.equal(identity.hasDevBuildMarker, true);
});

test('build classifier separates the player client from modpc', () => {
    assert.equal(classifyBuild('Minecraft.Windows.exe', PLAYER_CLIENT).kind, 'player-client');
});

test('build classifier separates the editor from modpc', () => {
    assert.equal(classifyBuild('Minecraft.Windows.Editor.exe', EDITOR).kind, 'editor');
});

test('build classifier separates vanilla from modpc', () => {
    assert.equal(classifyBuild('Minecraft.Windows.exe', VANILLA).kind, 'vanilla');
});

test('build classifier does not treat the dev marker alone as modpc', () => {
    const identity = classifyBuild('Minecraft.Windows.exe', VANILLA);
    assert.equal(identity.hasDevBuildMarker, true);
    assert.equal(identity.kind, 'vanilla');
});

test('build classifier does not require the dev marker', () => {
    const stripped = new Set(MODPC);
    stripped.delete('dbghelp.dll');
    const identity = classifyBuild('Minecraft.Windows.exe', stripped);
    assert.equal(identity.kind, 'modpc');
    assert.equal(identity.hasDevBuildMarker, false);
});

test('build classifier reports unknown instead of guessing', () => {
    assert.equal(classifyBuild('Minecraft.Windows.exe', undefined).kind, 'unknown');
});

async function withTempFile(
    size: number,
    body: (reader: ChunkedFileReader, expected: Buffer) => Promise<void>
): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chunked-reader-'));
    const file = path.join(dir, 'data.bin');
    const content = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
        content[i] = i & 0xff;
    }
    await fs.writeFile(file, content);
    const handle = await fs.open(file, 'r');
    try {
        await body(new ChunkedFileReader(handle), content);
    } finally {
        await handle.close();
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test('chunked reader returns the right bytes within, across and beyond chunk boundaries', async () => {
    await withTempFile(CHUNK_SIZE * 3, async (reader, expected) => {
        const cases: Array<[string, number, number]> = [
            ['inside one chunk', 100, 50],
            ['exactly at a chunk start', CHUNK_SIZE, 16],
            ['across one boundary', CHUNK_SIZE - 8, 16],
            ['across two boundaries', CHUNK_SIZE - 4, CHUNK_SIZE + 8],
            ['tail of the last chunk', CHUNK_SIZE * 3 - 10, 10]
        ];
        for (const [label, offset, length] of cases) {
            const actual = await reader.read(offset, length);
            assert.deepEqual(actual, expected.subarray(offset, offset + length), label);
        }
    });
});

test('chunked reader clamps reads that run past the end of file', async () => {
    await withTempFile(CHUNK_SIZE + 100, async (reader, expected) => {
        const tail = await reader.read(CHUNK_SIZE + 50, 500);
        assert.deepEqual(tail, expected.subarray(CHUNK_SIZE + 50));

        const beyond = await reader.read(CHUNK_SIZE * 5, 16);
        assert.equal(beyond.length, 0);
    });
});

test('chunked reader issues one disk read per chunk regardless of how often it is read', async () => {
    await withTempFile(CHUNK_SIZE * 2, async (reader) => {
        await reader.read(0, 16);
        assert.equal(reader.chunksRead, 1);
        for (let offset = 0; offset < CHUNK_SIZE; offset += 512) {
            await reader.read(offset, 64);
        }
        assert.equal(reader.chunksRead, 1);

        await reader.read(CHUNK_SIZE + 8, 16);
        assert.equal(reader.chunksRead, 2);
    });
});

test('chunked reader returns an empty buffer for invalid ranges', async () => {
    await withTempFile(1024, async (reader) => {
        assert.equal((await reader.read(-1, 16)).length, 0);
        assert.equal((await reader.read(0, 0)).length, 0);
        assert.equal((await reader.read(0, -5)).length, 0);
    });
});
