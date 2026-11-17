import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import {
    buildPythonProfilerHistoryEntry,
    formatPythonProfilerComparison,
    readPythonProfilerHistory,
    toHistorySummary,
    writePythonProfilerHistory
} from './pythonProfilerHistory';
import { PythonProfilerFunction, PythonProfilerResult } from './pythonProfiler';

function result(overrides: Partial<PythonProfilerResult> = {}): PythonProfilerResult {
    return {
        clock: 'WALL',
        elapsedSeconds: 10,
        totalFunctions: 3,
        engineFunctions: 1,
        truncated: false,
        functions: [
            { id: 0, target: 'client', module: 'mod/main.py', line: 10, name: 'tick', calls: 100, actualCalls: 100, selfTime: 0.2, totalTime: 1.5, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 1, target: 'client', module: 'mod/skill.py', line: 42, name: 'cast', calls: 500, actualCalls: 500, selfTime: 2.4, totalTime: 3.1, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 2, target: 'client', module: 'mod/server/extraServerApi.py', line: 1, name: 'GetEngineCompFactory', calls: 9, actualCalls: 9, selfTime: 0.9, totalTime: 1.4, contextId: 1, contextName: 'MainThread', isProject: false }
        ],
        calls: [],
        ...overrides
    };
}

test('history entry keeps only mod functions, sorted by total time', () => {
    const entry = buildPythonProfilerHistoryEntry({
        projectRoot: '/tmp/demo',
        target: 'client',
        clock: 'WALL',
        worldName: 'World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, result());
    assert.equal(entry.id, '20260804-123456-client-wall');
    assert.equal(entry.functions.length, 2);
    assert.equal(entry.functions[0].name, 'cast');
    assert.equal(entry.functions[1].name, 'tick');
    assert.equal(entry.totalCalls, 609);
    const summary = toHistorySummary(entry);
    assert.equal(summary.top?.name, 'cast');
    assert.equal('functions' in summary, false);
});

test('history entry keeps call relations plus the engine neighbours they point at', () => {
    const entry = buildPythonProfilerHistoryEntry({
        projectRoot: '/tmp/demo',
        target: 'client',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, result({
        calls: [
            { callerId: 0, calleeId: 1, calls: 500, selfTime: 2.4, totalTime: 3.1 },
            { callerId: 2, calleeId: 0, calls: 9, selfTime: 0.9, totalTime: 1.4 }
        ]
    }));
    // tick（1.5s）和 cast（3.1s）保留；引擎函数只在和它们相连时才带上
    assert.deepEqual(entry.functions.map(item => item.name), ['cast', 'tick', 'GetEngineCompFactory']);
    assert.equal(entry.functions[2].isProject, false);
    assert.equal(toHistorySummary(entry).top?.name, 'cast');
    // 边的两端是下标：tick→cast、GetEngineCompFactory→tick，按耗时降序
    assert.deepEqual(entry.calls, [
        { caller: 1, callee: 0, calls: 500, selfTime: 2.4, totalTime: 3.1 },
        { caller: 2, callee: 1, calls: 9, selfTime: 0.9, totalTime: 1.4 }
    ]);
    // 旧文件没有 calls：解析后不能崩，前端按「没有调用关系」处理
    const legacy = JSON.parse(JSON.stringify({ ...entry, calls: undefined }));
    assert.equal(legacy.calls, undefined);
});

test('history keeps a light mod complete even when another mod is much hotter', () => {
    const hot: PythonProfilerFunction[] = [];
    for (let index = 0; index < 1300; index += 1) {
        hot.push({
            id: index,
            target: 'server',
            module: 'hot_mod/server/x.py',
            line: index + 1,
            name: `fn${index}`,
            calls: 10,
            actualCalls: 10,
            selfTime: 0.01,
            totalTime: 5 - index * 0.001,
            contextId: 1,
            contextName: 'MainThread',
            isProject: true
        });
    }
    const light: PythonProfilerFunction[] = [];
    for (let index = 0; index < 5; index += 1) {
        light.push({
            id: 5000 + index,
            target: 'client',
            module: 'light_mod/client/y.py',
            line: index + 1,
            name: `tick${index}`,
            calls: 2,
            actualCalls: 2,
            selfTime: 0.001,
            totalTime: 0.002,
            contextId: 2,
            contextName: 'MainThread',
            isProject: true
        });
    }
    const entry = buildPythonProfilerHistoryEntry({
        projectRoot: '/tmp/demo',
        target: 'all',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, result({ functions: hot.concat(light), calls: [], totalFunctions: 1305 }));
    // 只按总耗时截断时这 5 个客户端函数会被 1300 个服务端热函数整段挤掉；
    // 现在的上限只是防呆，回看用的历史里就是这次采集的全部函数
    const kept = entry.functions.filter(item => item.module.indexOf('light_mod') === 0);
    assert.equal(kept.length, 5);
    assert.equal(entry.functions.length, 1305);
});

test('history entries round-trip through .mcdev/profiles/python/history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-history-'));
    const first = buildPythonProfilerHistoryEntry({
        projectRoot: root,
        target: 'client',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:00:00.000Z')
    }, result());
    const second = buildPythonProfilerHistoryEntry({
        projectRoot: root,
        target: 'client',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:10:00.000Z')
    }, result({ elapsedSeconds: 8 }));
    const firstId = await writePythonProfilerHistory(root, first);
    const secondId = await writePythonProfilerHistory(root, second);
    // 同一秒内重复采集不能覆盖已有历史
    const duplicateId = await writePythonProfilerHistory(root, first);
    assert.notEqual(duplicateId, firstId);
    const entries = await readPythonProfilerHistory(root);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].id, secondId);
    assert.deepEqual(
        entries.map(item => item.id).sort(),
        [duplicateId, firstId, secondId].sort()
    );
});

test('comparison summary is compact and points at regressions with file:line', () => {
    const base = buildPythonProfilerHistoryEntry({
        projectRoot: '/tmp/demo',
        target: 'client',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:00:00.000Z')
    }, result());
    const head = buildPythonProfilerHistoryEntry({
        projectRoot: '/tmp/demo',
        target: 'client',
        clock: 'WALL',
        capturedAt: new Date('2026-08-04T12:10:00.000Z')
    }, result({
        elapsedSeconds: 14,
        functions: [
            { id: 0, target: 'client', module: 'mod/main.py', line: 10, name: 'tick', calls: 100, actualCalls: 100, selfTime: 0.2, totalTime: 1.5, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 1, target: 'client', module: 'mod/skill.py', line: 42, name: 'cast', calls: 3000, actualCalls: 3000, selfTime: 5.4, totalTime: 6.2, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 3, target: 'client', module: 'mod/new.py', line: 7, name: 'loop', calls: 40, actualCalls: 40, selfTime: 0.6, totalTime: 0.9, contextId: 1, contextName: 'MainThread', isProject: true }
        ],
        totalFunctions: 3
    }));
    const summary = formatPythonProfilerComparison(base, head);
    assert.match(summary, /^# Python 性能对比/);
    assert.match(summary, /## 变慢/);
    assert.match(summary, /\+3\.00s/);
    assert.match(summary, /mod\/skill\.py:42 cast/);
    assert.match(summary, /## 新增热点/);
    assert.match(summary, /mod\/new\.py:7 loop/);
    assert.match(summary, /不要复述数据/);
    assert.ok(summary.length < 2000, `summary too long: ${summary.length}`);
});
