import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProcessAlive, parseTasklistCsv } from './processLiveness';

test('parseTasklistCsv extracts pids and ignores the localized "no tasks" line', () => {
    const output = [
        '"Minecraft.Windows.exe","18232","Console","1","3.562 K"',
        '"Minecraft.Windows.exe","20480","Console","1","120 K"',
        ''
    ].join('\r\n');
    assert.deepEqual(parseTasklistCsv(output), [18232, 20480]);
    assert.deepEqual(parseTasklistCsv('信息: 没有运行的任务匹配指定标准。'), []);
    assert.deepEqual(parseTasklistCsv(''), []);
});

test('isProcessAlive detects the current process and rejects impossible pids', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(Number.NaN), false);
    // 一个几乎不可能存在的 pid（Windows 上 process.kill 会抛 ESRCH）
    assert.equal(isProcessAlive(0x7ffffffe), false);
});
