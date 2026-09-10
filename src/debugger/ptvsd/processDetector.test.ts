import assert from 'node:assert/strict';
import test from 'node:test';
import { MinecraftProcess, ProcessKindCache } from './processDetector';

function proc(pid: number, startedAt?: string, path?: string): MinecraftProcess {
    return { pid, name: 'Minecraft.Windows.exe', startedAt, path };
}

test('process kind cache hits on a repeated lookup of the same process', () => {
    const cache = new ProcessKindCache();
    const running = proc(1234, '639240489511955380');
    assert.equal(cache.get(running), undefined);
    cache.set(running, 'modpc');
    assert.equal(cache.get(running), 'modpc');
});

test('process kind cache misses when a pid has been reused', () => {
    const cache = new ProcessKindCache();
    cache.set(proc(1234, '639240489511955380'), 'modpc');
    const reused = proc(1234, '639243335395626700');
    assert.equal(cache.get(reused), undefined);
});

test('process kind cache stores nothing without a start time', () => {
    const cache = new ProcessKindCache();
    const noStartTime = proc(1234);
    cache.set(noStartTime, 'modpc');
    assert.equal(cache.size, 0);
    assert.equal(cache.get(noStartTime), undefined);
});

test('process kind cache evicts entries for processes that have exited', () => {
    const cache = new ProcessKindCache();
    cache.set(proc(1, 'a'), 'modpc');
    cache.set(proc(2, 'b'), 'player-client');
    cache.set(proc(3, 'c'), 'vanilla');
    assert.equal(cache.size, 3);

    cache.retainOnly([proc(2, 'b')]);
    assert.equal(cache.size, 1);
    assert.equal(cache.get(proc(2, 'b')), 'player-client');
    assert.equal(cache.get(proc(1, 'a')), undefined);
});

test('process kind cache empties when nothing is running', () => {
    const cache = new ProcessKindCache();
    cache.set(proc(1, 'a'), 'modpc');
    cache.retainOnly([]);
    assert.equal(cache.size, 0);
});

test('process kind cache keeps entries for processes that are still running', () => {
    const cache = new ProcessKindCache();
    cache.set(proc(7, 'x'), 'modpc');
    cache.retainOnly([proc(7, 'x'), proc(8, 'y')]);
    assert.equal(cache.get(proc(7, 'x')), 'modpc');
    assert.equal(cache.size, 1);
});

test('process kind cache stays bounded across repeated process generations', () => {
    const cache = new ProcessKindCache();
    for (let round = 0; round < 10000; round += 1) {
        const alive = [
            proc(round * 2, `t${round}`),
            proc(round * 2 + 1, `t${round}`)
        ];
        cache.retainOnly(alive);
        for (const running of alive) {
            cache.set(running, 'modpc');
        }
        assert.ok(cache.size <= 2, `size grew to ${cache.size} at round ${round}`);
    }
});

test('process kind cache stays bounded even without eviction calls', () => {
    const cache = new ProcessKindCache();
    for (let i = 0; i < 10000; i += 1) {
        cache.set(proc(i, `t${i}`), 'modpc');
    }
    assert.ok(cache.size <= 32, `size grew to ${cache.size}`);
});

test('process kind cache does not evict when overwriting an existing pid', () => {
    const cache = new ProcessKindCache();
    for (let i = 0; i < 32; i += 1) {
        cache.set(proc(i, `t${i}`), 'modpc');
    }
    assert.equal(cache.size, 32);
    cache.set(proc(0, 't0-new'), 'player-client');
    assert.equal(cache.size, 32);
    assert.equal(cache.get(proc(0, 't0-new')), 'player-client');
});
