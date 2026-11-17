import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import {
    buildPythonProfilerAnalysisPrompt,
    buildPythonProfilerReportMarkdown,
    writePythonProfilerReport
} from './pythonProfilerReport';

test('Python profiler writes SVG and AI-readable Markdown under .mcdev', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-profile-'));
    const files = await writePythonProfilerReport({
        projectRoot: root,
        target: 'client',
        worldName: 'Test World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, {
        clock: 'CPU',
        elapsedSeconds: 5,
        totalFunctions: 2,
        engineFunctions: 1,
        truncated: false,
        functions: [
            { id: 0, target: 'client', module: 'demo/main.py', line: 10, name: 'tick', calls: 2, actualCalls: 2, selfTime: 0, totalTime: 0.8, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 1, target: 'client', module: 'demo/work.py', line: 4, name: 'work', calls: 4, actualCalls: 4, selfTime: 0.4, totalTime: 0.5, contextId: 1, contextName: 'MainThread', isProject: true },
            { id: 2, target: 'client', module: 'mod/server/extraServerApi.py', line: 1, name: 'GetEngineCompFactory', calls: 9, actualCalls: 9, selfTime: 0.9, totalTime: 1.4, contextId: 1, contextName: 'MainThread', isProject: false }
        ],
        calls: [{ callerId: 0, calleeId: 1, calls: 4, selfTime: 0.4, totalTime: 0.5 }]
    });
    assert.match(files.markdownPath, /\.mcdev[\\/]profiles[\\/]python/);
    const svgPath = files.svgPath ?? '';
    assert.ok(svgPath, 'svg report path is missing');
    const [markdown, svg] = await Promise.all([
        fs.readFile(files.markdownPath, 'utf8'),
        fs.readFile(svgPath, 'utf8')
    ]);
    assert.match(markdown, /## Client Functions \(客户端\)/);
    assert.match(markdown, /## Server Functions \(服务端\)/);
    assert.match(markdown, /## Other Functions \(其他\)/);
    // 引擎 / 原版函数归到「其他」段，不再单独成节
    assert.doesNotMatch(markdown, /## Engine \/ Vanilla Functions/);
    assert.match(markdown, /\| 1 \| GetEngineCompFactory \|/);
    assert.match(markdown, /client \/ MainThread #1/);
    assert.match(markdown, /< clock resolution/);
    assert.match(markdown, /tick \[client \/ MainThread #1\] \| work \[client \/ MainThread #1\]/);
    assert.match(svg, /Python Performance Profile/);
    assert.match(svg, /demo\/main\.py:10/);
    assert.match(svg, /&lt; clock resolution/);
});

test('Python profiler lists each side separately and keeps every function', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-profile-sides-'));
    const make = (id: number, name: string, target: 'client' | 'server') => ({
        id,
        target,
        module: `demo/${target}.py`,
        line: id + 1,
        name,
        calls: 1,
        actualCalls: 1,
        selfTime: 0.01,
        totalTime: 100 - id,
        contextId: 1,
        contextName: target === 'client' ? 'MainThread' : 'DummyThread',
        isProject: true
    });
    const functions = [
        ...Array.from({ length: 60 }, (_, index) => make(index, `clientWork${index}`, 'client')),
        ...Array.from({ length: 3 }, (_, index) => make(100 + index, `serverWork${index}`, 'server'))
    ];
    const files = await writePythonProfilerReport({
        projectRoot: root,
        target: 'all',
        worldName: 'Test World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, {
        clock: 'WALL',
        elapsedSeconds: 10,
        totalFunctions: functions.length,
        engineFunctions: 0,
        truncated: true,
        targets: ['client', 'server'],
        functions,
        calls: []
    });
    const markdown = await fs.readFile(files.markdownPath, 'utf8');
    const clientSection = markdown.slice(
        markdown.indexOf('## Client Functions (客户端)'),
        markdown.indexOf('## Server Functions (服务端)')
    );
    // 不截断：报告和复制出去的文本就是这次采集的全部函数
    assert.match(clientSection, /Showing all 60 functions, ordered by total time\./);
    assert.equal(clientSection.match(/^\| \d+ \| clientWork/gm)?.length, 60);
    assert.match(clientSection, /clientWork0 \|/);
    assert.match(clientSection, /\| 60 \| clientWork59 \|/);
    const serverSection = markdown.slice(
        markdown.indexOf('## Server Functions (服务端)'),
        markdown.indexOf('## Other Functions (其他)')
    );
    assert.match(serverSection, /Showing all 3 functions, ordered by total time\./);
    assert.match(serverSection, /serverWork0 \|/);
});

test('Python profiler writes a MOD-scoped Markdown report only', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-profile-mod-'));
    const files = await writePythonProfilerReport({
        projectRoot: root,
        target: 'client',
        worldName: 'Test World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    }, {
        clock: 'CPU',
        elapsedSeconds: 5,
        totalFunctions: 3,
        engineFunctions: 1,
        truncated: false,
        functions: [
            { id: 0, target: 'client', module: 'MobScript.Scripts.GateMain', line: 10, name: 'tickGate', calls: 2, actualCalls: 2, selfTime: 0.1, totalTime: 0.8, contextId: 1, contextName: 'MainThread', isProject: true, mod: 'MobScript' },
            { id: 1, target: 'client', module: 'MobScript.Scripts.GateMain', line: 40, name: 'scanMobs', calls: 4, actualCalls: 4, selfTime: 0.9, totalTime: 1.2, contextId: 1, contextName: 'MainThread', isProject: true, mod: 'MobScript' },
            { id: 2, target: 'client', module: 'OtherMod.Scripts.Main', line: 7, name: 'otherTick', calls: 3, actualCalls: 3, selfTime: 0.6, totalTime: 0.6, contextId: 1, contextName: 'MainThread', isProject: true, mod: 'OtherMod' },
            { id: 3, target: 'client', module: 'mod/server/extraServerApi.py', line: 1, name: 'GetEngineCompFactory', calls: 9, actualCalls: 9, selfTime: 0.9, totalTime: 1.4, contextId: 1, contextName: 'MainThread', isProject: false }
        ],
        calls: [
            { callerId: 0, calleeId: 1, calls: 4, selfTime: 0.9, totalTime: 1.2 },
            { callerId: 2, calleeId: 3, calls: 9, selfTime: 0.9, totalTime: 1.4 }
        ]
    }, { mod: 'MobScript' });
    assert.match(files.markdownPath, /-mod-MobScript\.md$/);
    assert.equal(files.svgPath, undefined);
    const markdown = await fs.readFile(files.markdownPath, 'utf8');
    assert.match(markdown, /^# Python Performance Profile - MOD MobScript/m);
    assert.match(markdown, /- MOD scope: MobScript/);
    assert.match(markdown, /## MOD Breakdown/);
    assert.match(markdown, /tickGate/);
    assert.match(markdown, /scanMobs/);
    assert.doesNotMatch(markdown, /otherTick/);
    assert.doesNotMatch(markdown, /GetEngineCompFactory/);
});

test('Python profiler copies the top N per section without trimming the saved report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-profile-limit-'));
    const make = (id: number, name: string, target: 'client' | 'server') => ({
        id,
        target,
        module: `demo/${target}.py`,
        line: id + 1,
        name,
        calls: 1,
        actualCalls: 1,
        selfTime: 0.01,
        totalTime: 100 - id,
        contextId: 1,
        contextName: target === 'client' ? 'MainThread' : 'DummyThread',
        isProject: true
    });
    const functions = [
        ...Array.from({ length: 60 }, (_, index) => make(index, `clientWork${index}`, 'client')),
        ...Array.from({ length: 3 }, (_, index) => make(100 + index, `serverWork${index}`, 'server'))
    ];
    const context = {
        projectRoot: root,
        target: 'all' as const,
        worldName: 'Test World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    };
    const result = {
        clock: 'WALL' as const,
        elapsedSeconds: 10,
        totalFunctions: functions.length,
        engineFunctions: 0,
        truncated: false,
        targets: ['client', 'server'] as ('client' | 'server')[],
        functions,
        calls: []
    };
    // 落盘报告不受条数设置影响，始终全量
    const files = await writePythonProfilerReport(context, result);
    const saved = await fs.readFile(files.markdownPath, 'utf8');
    assert.match(saved, /Showing all 60 functions, ordered by total time\./);
    assert.doesNotMatch(saved, /copy limit/);
    // 落盘报告保留调用关系一节；复制正文一律不带
    assert.ok(saved.includes('## Call Relationships'));

    const copied = buildPythonProfilerReportMarkdown(context, result, { limit: 50 });
    assert.ok(copied.includes('- Functions per section: top 50 by total time (copy limit)'));
    // 调用关系是报告里最长的一节（上千条边），复制给 Agent 时整节都不生成
    assert.ok(!copied.includes('## Call Relationships'));
    assert.ok(copied.includes('- Call relationships: not included in this copy (the report file lists them)'));
    // 但「解读说明」还要留着，不能连它一起砍掉
    assert.ok(copied.includes('## Interpretation Notes'));
    // 「全部」勾选（limit 0）走的也是同一条内存渲染路径，同样不带调用关系
    const copiedAll = buildPythonProfilerReportMarkdown(context, result, { limit: 0 });
    assert.ok(!copiedAll.includes('## Call Relationships'));
    assert.match(copiedAll, /Showing all 60 functions, ordered by total time\./);
    const clientSection = copied.slice(
        copied.indexOf('## Client Functions (客户端)'),
        copied.indexOf('## Server Functions (服务端)')
    );
    assert.ok(clientSection.includes(
        'Showing the top 50 of 60 functions by total time (copy limit; the saved report lists all of them).'
    ));
    const clientRows = clientSection.split('\n').filter(line => line.startsWith('| ') && line.includes(' clientWork'));
    assert.equal(clientRows.length, 50);
    assert.ok(clientSection.includes('| 50 | clientWork49 |'));
    assert.ok(!clientSection.includes('| clientWork50 |'));
    // 函数数少于条数上限的段按「全部」表述
    const serverSection = copied.slice(
        copied.indexOf('## Server Functions (服务端)'),
        copied.indexOf('## Other Functions (其他)')
    );
    assert.match(serverSection, /Showing all 3 functions/);

    // 提示词要说明正文是收窄过的，别让 Agent 以为数据就这么点
    const prompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', copied, undefined, 50);
    assert.match(prompt, /每段只保留了总耗时最高的前 50 个函数/);
    assert.ok(prompt.includes('这段正文没有带「调用关系」表'));
    const fullPrompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', saved);
    assert.match(fullPrompt, /每段都是这次采集的全部函数/);
});

test('Python profiler can omit the class rollup or let it stand alone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdev-profile-classes-'));
    const mod = 'demo_mod';
    const make = (
        id: number,
        name: string,
        module: string,
        target: 'client' | 'server',
        totalTime: number
    ) => ({
        id,
        target,
        module,
        line: id + 1,
        name,
        calls: 2,
        actualCalls: 2,
        selfTime: totalTime / 2,
        totalTime,
        contextId: 1,
        contextName: target === 'client' ? 'MainThread' : 'DummyThread',
        isProject: true
    });
    const functions = [
        make(0, 'SleepGoal.CanUse', mod + '.server.goals', 'server', 4),
        make(1, 'SleepGoal.Tick', mod + '.server.goals', 'server', 2),
        make(2, 'helper', mod + '.client.manager', 'client', 1)
    ];
    const context = {
        projectRoot: root,
        target: 'all' as const,
        worldName: 'Test World',
        capturedAt: new Date('2026-08-04T12:34:56.789Z')
    };
    const result = {
        clock: 'WALL' as const,
        elapsedSeconds: 10,
        totalFunctions: functions.length,
        engineFunctions: 0,
        truncated: false,
        targets: ['client', 'server'] as ('client' | 'server')[],
        functions,
        calls: []
    };

    // 默认（both）：汇总 + 三段函数表，汇总名去掉 MOD 与端前缀
    const both = buildPythonProfilerReportMarkdown(context, result, { mod, classes: 'both' });
    assert.ok(both.includes('## Client Functions (客户端)'));
    assert.ok(both.includes('## Hot Classes / Modules'));
    assert.ok(both.includes('Functions rolled up by class / module, already sorted by total time; use this table as is.'));
    assert.match(both, /\| 1 \| SleepGoal \|/);
    assert.match(both, /\| 2 \| manager \|/);
    // Location 列精简：段落标题已写明 MOD 与端，行里只留 goals:1
    assert.ok(both.includes('| goals:1 |'));
    assert.ok(both.includes('Locations omit the MOD name and the server prefix, as noted in the section title.'));

    // only：只给汇总，函数表整段省掉；行名自带 client. / server. 但同样不带 MOD
    const only = buildPythonProfilerReportMarkdown(context, result, { mod, classes: 'only' });
    assert.ok(!only.includes('## Client Functions'));
    assert.ok(!only.includes('## Server Functions'));
    assert.ok(!only.includes('## Other Functions'));
    assert.ok(only.includes('## Hot Classes / Modules'));
    assert.ok(only.includes('- Function tables: omitted; only the class / module rollup is listed'));
    assert.ok(only.includes('every row already carries its client. / server. prefix'));
    assert.match(only, /\| 1 \| server\.SleepGoal \|/);
    assert.match(only, /\| 2 \| client\.manager \|/);

    // none：不生成汇总，函数表照旧，交给 Agent 自己聚合
    const none = buildPythonProfilerReportMarkdown(context, result, { mod, classes: 'none' });
    assert.ok(!none.includes('## Hot Classes / Modules'));
    assert.ok(none.includes('## Server Functions (服务端)'));

    // 提示词要按三态说明口径，别让 Agent 又自己排一遍已经排好的汇总
    const onlyPrompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', only, mod, undefined, 'only');
    assert.ok(onlyPrompt.includes('已按总耗时降序排好'));
    assert.ok(!onlyPrompt.includes('直接用它，不要自己重排'));
    const nonePrompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', none, mod, undefined, 'none');
    assert.ok(nonePrompt.includes('需要按类归并时请自己从函数表聚合'));
    assert.ok(!nonePrompt.includes('直接用它，不要自己重排'));
    const bothPrompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', both, mod, undefined, 'both');
    assert.ok(bothPrompt.includes('直接用它，不要自己重排'));

    // only 模式下汇总行数也吃「每段前 N」这条口径（不再无条件整份列出）
    const onlyLimited = buildPythonProfilerReportMarkdown(context, result, { mod, classes: 'only', limit: 1 });
    assert.ok(onlyLimited.includes('- Classes / modules: top 1 by total time (copy limit)'));
    assert.match(onlyLimited, /\| 1 \| server\.SleepGoal \|/);
    assert.ok(!onlyLimited.includes('client.manager'));
    assert.ok(onlyLimited.includes('Showing the top 1 of 2 class / module rows (copy limit; the saved report lists all of them).'));
    const onlyLimitedPrompt = buildPythonProfilerAnalysisPrompt('C:/tmp/report.md', onlyLimited, mod, 1, 'only');
    assert.ok(onlyLimitedPrompt.includes('汇总只保留了总耗时最高的前 1 类 / 模块'));
    // 不限条数时仍是整份汇总，且不该出现截断说明
    assert.ok(!only.includes('Showing the top'));
    assert.ok(!only.includes('class / module rows'));
});

