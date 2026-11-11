import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PerfMonitorSeries } from './perfMonitor';

function sample(time: number, fps: number | undefined, cpuPercent: number, workingSetBytes: number) {
    return { time, fps, cpuPercent, workingSetBytes, pagefileBytes: workingSetBytes / 2 };
}

test('summarises cpu and memory across the recorded window', () => {
    const series = new PerfMonitorSeries();
    series.push(sample(1_000, 60, 10, 100));
    series.push(sample(2_000, 30, 20, 300));
    series.push(sample(3_000, 50, 30, 500));

    const stats = series.stats();
    assert.equal(stats.sampleCount, 3);
    assert.equal(stats.windowSeconds, 2);
    assert.deepEqual(stats.cpu, { current: 30, average: 20, peak: 30 });
    assert.deepEqual(stats.memory, { current: 500, average: 300, peak: 500, growth: 400 });
});

test('reports fps current, average, extremes and the slowest one percent', () => {
    const series = new PerfMonitorSeries();
    for (let index = 0; index < 100; index += 1) {
        series.push(sample(index * 1_000, index === 0 ? 4 : 60, 5, 1024));
    }

    const fps = series.stats().fps;
    assert.ok(fps);
    assert.equal(fps.current, 60);
    assert.equal(fps.min, 4);
    assert.equal(fps.max, 60);
    assert.equal(fps.low1, 4);
    assert.equal(fps.average, 59.4);
});

test('omits fps statistics when the game counter never answered', () => {
    const series = new PerfMonitorSeries();
    series.push(sample(1_000, undefined, 12, 2048));
    assert.equal(series.stats().fps, undefined);
});

test('drops the oldest samples once the capacity is reached', () => {
    const series = new PerfMonitorSeries(3);
    for (let index = 0; index < 5; index += 1) {
        series.push(sample(index * 1_000, 30, index, 1024));
    }
    assert.equal(series.size, 3);
    assert.deepEqual(series.samples().map(item => item.cpuPercent), [2, 3, 4]);
});

test('exports csv with an empty fps cell when the counter is missing', () => {
    const series = new PerfMonitorSeries();
    series.push(sample(0, undefined, 12.345, 2048));
    const rows = series.toCsv().split('\n');
    assert.equal(rows[0], 'time,isoTime,fps,cpuPercent,workingSetBytes,pagefileBytes');
    assert.equal(rows[1], '0,1970-01-01T00:00:00.000Z,,12.35,2048,1024');
});
