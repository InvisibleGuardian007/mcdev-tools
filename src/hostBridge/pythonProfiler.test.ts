import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    buildPythonProfilerCleanupCode,
    buildPythonProfilerCollectCode,
    buildPythonProfilerJoinCode,
    buildPythonProfilerMarkCode,
    buildPythonProfilerStartCode,
    filterPythonProfilerResultByMod,
    parsePythonProfilerJoin,
    parsePythonProfilerResult,
    parsePythonProfilerStart,
    profilerFunctionMod
} from './pythonProfiler';

test('Python profiler scripts stay bounded and distinguish client and server projects', () => {
    const timed = buildPythonProfilerStartCode({ target: 'client', clock: 'CPU', durationSeconds: 12.5 });
    const manual = buildPythonProfilerStartCode({ target: 'server', clock: 'WALL' });
    const both = buildPythonProfilerStartCode({ target: 'client', clock: 'CPU', allSides: true });
    assert.match(timed, /threading\.Timer\(_mcdev_pp_duration/);
    // 单侧默认不开多线程 hook；'all' 才开，让 yappi 枚举进程里已存在的线程
    // （服务端线程早就跑着了，只靠 threading.setprofile 挂不上）
    assert.match(timed, /yappi\.start\(False,_mcdev_pp_all_sides\)/);
    assert.match(timed, /_mcdev_pp_all_sides=False/);
    assert.match(both, /_mcdev_pp_all_sides=True/);
    assert.doesNotMatch(manual, /_mcdev_pp_all_sides=True/);
    assert.match(timed, /_mcdev_pp_duration=12\.5/);
    assert.match(manual, /_mcdev_pp_duration=None/);
    assert.match(manual, /_mcdev_pp_clock='WALL'/);
    assert.match(buildPythonProfilerCollectCode('client'), /clientScriptNameList/);
    assert.match(buildPythonProfilerCollectCode('server'), /serverScriptNameList/);
    assert.match(buildPythonProfilerCollectCode('client'), /_mcdev_pp_module\.startswith\(_mcdev_pp_name\+'\.'\)/);
    assert.doesNotMatch(buildPythonProfilerCollectCode('client'), /not _mcdev_pp_scripts/);
    const server = buildPythonProfilerCollectCode('server');
    assert.match(server, /\(_mcdev_pp_item\[0\],_mcdev_pp_child\.index\)/);
    // 单侧采集脚本不碰 marker / context id：整份统计都属于那一端
    for (const side of ['client', 'server'] as const) {
        const code = buildPythonProfilerCollectCode(side);
        assert.equal(code.includes('_marker'), false, '单侧不应有 marker 探测');
        assert.equal(code.includes("'ctx_id':"), false, '单侧不应按 context id 过滤统计');
        assert.equal(code.includes(` _mcdev_pp_sources=[('${side}',_mcdev_pp_stats,_mcdev_pp_scripts)]`), true);
    }
    // 'all' 采集：一次 get_func_stats，按 marker 的 ctx_id 切成两端，缺端只记 missing
    const all = buildPythonProfilerCollectCode('all');
    assert.match(all, /_mcdev_pp_scripts_for=\{'client':/);
    assert.match(all, /_mcdev_pp_ctxs\['client'\]=int\(getattr\(_mcdev_pp_stat,'ctx_id',0\) or 0\)/);
    assert.match(all, /_mcdev_pp_ctxs\['server'\]=int\(getattr\(_mcdev_pp_stat,'ctx_id',0\) or 0\)/);
    assert.match(all, /yappi\.get_func_stats\(\{'ctx_id':_mcdev_pp_ctx\}\)/);
    assert.match(all, /_mcdev_pp_missing\.append\(_mcdev_pp_side\)/);
    assert.match(all, /'missing':_mcdev_pp_missing/);
    assert.match(all, /'targets':\[_mcdev_pp_source\[0\] for _mcdev_pp_source in _mcdev_pp_sources\]/);
    assert.equal(all.includes('_mcdev_pp_stats=list(yappi.get_func_stats() or ())'), true, 'all 只应扫一遍全量统计');
    // 项目函数按 (端, mod) 分组分预算：单采一个 mod 时要能拿到这个 mod 的全部函数
    assert.match(all, /_mcdev_pp_groups\.setdefault\(\(_mcdev_pp_item\[0\],_mcdev_pp_item\[2\]\),\[\]\)\.append\(_mcdev_pp_item\)/);
    assert.match(all, /_mcdev_pp_quota=int\(20000\*len\(_mcdev_pp_group\)\/max\(1,len\(_mcdev_pp_project\)\)\)/);
    // 报告要的是全部函数：端点上的条数上限只是防呆，真正的界是回包字节预算
    for (const code of [all, buildPythonProfilerCollectCode('client')]) {
        assert.match(code, /_mcdev_pp_truncated=len\(_mcdev_pp_all\)>len\(_mcdev_pp_keep\)/);
        assert.match(code, /if _mcdev_pp_bytes>7340032:/);
        assert.match(code, /_mcdev_pp_keep=_mcdev_pp_keep\[:_mcdev_pp_cut\]/);
        assert.match(code, /if len\(_mcdev_pp_edges\)>=200000 or _mcdev_pp_edge_bytes>7340032:/);
        assert.match(code, /'truncated':_mcdev_pp_truncated/);
    }
    assert.match(all, /if _mcdev_pp_quota<24: _mcdev_pp_quota=24/);
    // 归属标记丢了但采样确实是这次起的（yappi 在多线程模式跑着）：继续收，别白采一趟
    for (const code of [all, buildPythonProfilerCollectCode('client')]) {
        assert.match(code, /_mcdev_pp_owned=globals\(\)\.get\('_mcdev_pp_owned',False\)/);
        assert.match(code, /_mcdev_pp_owned=bool\(yappi\.is_running\(\) and _mcdev_pp_flags and _mcdev_pp_flags\.get\('profile_multithread'\)\)/);
        assert.match(code, /'reason':'not_owned','running':bool\(yappi\.is_running\(\)\)/);
    }
    assert.ok(timed.length < 2_000);
    // 脚本体积上限只是防呆：现在多了「按 (端,mod) 分预算」的分配逻辑
    assert.ok(buildPythonProfilerCollectCode('client').length < 8_000);
    assert.ok(all.length < 9_000);
    assert.match(buildPythonProfilerCleanupCode(), /_mcdev_pp_owned/);
    // 服务端加入过一次采样：清理时要复位它的 profile 钩子
    assert.match(buildPythonProfilerCleanupCode(), /_mcdev_pp_joined/);
    assert.match(buildPythonProfilerCleanupCode(), /sys\.setprofile\(None\)/);
});

test('Python profiler refuses invalid durations and existing external profilers', () => {
    assert.throws(
        () => buildPythonProfilerStartCode({ target: 'client', clock: 'CPU', durationSeconds: 0 }),
        /greater than zero/
    );
    assert.throws(() => parsePythonProfilerStart({ ok: false, reason: 'busy' }), /already running/);
    assert.throws(() => parsePythonProfilerResult({ ok: false, reason: 'not_owned' }, 'all'), /No MC Dev Tools Python profile is active/);
    assert.throws(
        () => parsePythonProfilerResult({ ok: false, reason: 'not_owned', running: true }, 'all'),
        /ownership marker was lost/
    );
    assert.doesNotThrow(() => parsePythonProfilerStart({ ok: true }));
});

test('Python profiler parses compact bounded call graph data', () => {
    const result = parsePythonProfilerResult({
        ok: true,
        clock: 'WALL',
        elapsed: 3.25,
        total: 2,
        truncated: false,
        nodes: [
            [0, 'demo/main.py', 12, 'tick', 5, 5, 0.1, 0.8, 1, 'MainThread'],
            [1, 'demo/util.py', 8, 'work', 10, 10, 0.5, 0.6, 1, 'MainThread']
        ],
        edges: [[0, 1, 10, 0.5, 0.6], [0, 999, 1, 0, 0.1]]
    });
    assert.equal(result.clock, 'WALL');
    assert.equal(result.elapsedSeconds, 3.25);
    assert.equal(result.functions[0].target, 'client');
    assert.equal(result.functions[0].name, 'tick');
    assert.deepEqual(result.calls, [{ callerId: 0, calleeId: 1, calls: 10, selfTime: 0.5, totalTime: 0.6 }]);
});

test('Python profiler 的 all 载荷按行分端，缺端只记 missing 不报错', () => {
    const result = parsePythonProfilerResult({
        ok: true,
        clock: 'CPU',
        elapsed: 2,
        total: 2,
        truncated: false,
        targets: ['client', 'server'],
        missing: [],
        nodes: [
            [0, 'demo/client.py', 1, 'ClientRoot', 1, 1, 0.1, 0.4, 1, 'MainThread', 'client'],
            [1, 'demo/server.py', 2, 'ServerRoot', 1, 1, 0.2, 0.3, 2, 'Dummy', 'server']
        ],
        // 两端在同一次采样里，但栈不相通：跨端调用边必须丢掉
        edges: [[0, 1, 1, 0.2, 0.3]]
    }, 'all');
    assert.deepEqual(result.functions.map(item => item.target), ['client', 'server']);
    assert.deepEqual(result.targets, ['client', 'server']);
    assert.deepEqual(result.missingSides, []);
    assert.deepEqual(result.calls, []);
    // 行内显式 side 优先于目标端兜底
    const explicit = parsePythonProfilerResult({
        ok: true, clock: 'CPU', elapsed: 1, total: 1, truncated: false,
        nodes: [[0, 'demo/server.py', 1, 'ServerRoot', 1, 1, 0.1, 0.4, 2, 'Dummy', 'server']],
        edges: []
    }, 'client');
    assert.equal(explicit.functions[0].target, 'server');
    // 服务端没挂上：如实记下来，客户端那部分照常出结果
    const partial = parsePythonProfilerResult({
        ok: true, clock: 'CPU', elapsed: 1, total: 1, truncated: false,
        targets: ['client'],
        missing: ['server'],
        nodes: [[0, 'demo/client.py', 1, 'Only', 1, 1, 0.1, 0.4, 1, 'MainThread', 'client']],
        edges: []
    }, 'all');
    assert.deepEqual(partial.missingSides, ['server']);
    assert.deepEqual(partial.targets, ['client']);
    // 两端都没采到才算整次失败，并把没加入的端说清楚
    assert.throws(() => parsePythonProfilerResult({
        ok: true, clock: 'CPU', elapsed: 1, total: 0, truncated: false,
        targets: [], missing: ['client', 'server'], nodes: [], edges: []
    }, 'all'), /client and server never joined the profile/);
    assert.throws(() => parsePythonProfilerResult({
        ok: true, clock: 'CPU', elapsed: 1, total: 0, truncated: false, nodes: [], edges: []
    }, 'all'), /No Python samples were captured/);
});

test('Python profiler 要求对端真的加入同一次采样，加入失败立刻报错', () => {
    assert.doesNotThrow(() => parsePythonProfilerJoin({ ok: true, joined: true, hooked: true, reason: '' }));
    assert.throws(
        () => parsePythonProfilerJoin({ ok: true, joined: true, hooked: false, reason: 'not_running' }),
        /no Python profile is running/
    );
    assert.throws(
        () => parsePythonProfilerJoin({ ok: true, joined: true, hooked: false, reason: 'not_multithreaded' }),
        /not started in multithread mode/
    );
    assert.throws(
        () => parsePythonProfilerJoin({ ok: true, joined: true, hooked: false, reason: 'marker_missing' }),
        /could not be profiled \(marker_missing\)/
    );
    assert.throws(() => parsePythonProfilerJoin({ ok: false }), /could not join this profile/);
    const join = buildPythonProfilerJoinCode('server');
    // 采样已经在跑时 yappi.start() 直接返回，必须走 _yappi 内部补挂路径
    assert.doesNotMatch(join, /yappi\.start\(/);
    assert.match(join, /sys\.setprofile\(_mcdev_pp_side_hook\)/);
    assert.match(join, /_mcdev_pp_c\._profile_event\(_mcdev_pp_frame,_mcdev_pp_event,_mcdev_pp_arg\)/);
    assert.match(join, /_mcdev_pp_flags=_mcdev_pp_c\._get_start_flags\(\)/);
    assert.match(join, /_mcdev_pp_flags\.get\('profile_multithread'\)/);
    // 加入是否成功由「标记函数有没有产生统计条目」来判定，不能只看 setprofile 没抛错
    assert.match(join, /def _mcdev_pp_server_marker\(\): pass/);
    assert.match(join, /_mcdev_pp_seen=True/);
    assert.match(join, /sys\.setprofile\(None\)/);
    // 加入端不许碰会话状态：两端可能共用同一份 globals()，写 owned=False 会让采集直接 not_owned
    for (const forbidden of ['_mcdev_pp_owned', '_mcdev_pp_started', '_mcdev_pp_stopped', '_mcdev_pp_timer']) {
        assert.equal(join.includes(forbidden), false, `加入脚本不应改写 ${forbidden}`);
    }
    assert.match(join, /globals\(\)\['_mcdev_pp_joined'\]=True/);
    // 标记函数必须真的跑一次，否则拿不到带 ctx_id 的统计条目
    assert.match(
        buildPythonProfilerMarkCode('client'),
        /def _mcdev_pp_client_marker\(\): pass\n_mcdev_pp_client_marker\(\)/
    );
});

test('generated Python profiler scripts are syntactically valid', t => {
    const scripts = [
        buildPythonProfilerStartCode({ target: 'client', clock: 'CPU', durationSeconds: 1.5 }),
        buildPythonProfilerStartCode({ target: 'server', clock: 'WALL' }),
        buildPythonProfilerStartCode({ target: 'client', clock: 'WALL', allSides: true }),
        buildPythonProfilerCollectCode('client'),
        buildPythonProfilerCollectCode('server'),
        buildPythonProfilerCollectCode('all'),
        buildPythonProfilerJoinCode('server'),
        buildPythonProfilerMarkCode('client'),
        buildPythonProfilerCleanupCode()
    ];
    for (const script of scripts) {
        const result = spawnSync('python', [
            '-c',
            "import sys; compile(sys.stdin.read(), '<mcdev-profiler>', 'exec')"
        ], { input: script, encoding: 'utf8' });
        if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
            t.skip('Python is unavailable');
            return;
        }
        assert.equal(result.status, 0, result.stderr);
    }
});

test('Python profiler groups functions by MOD and scopes results to one MOD', () => {
    const parsed = parsePythonProfilerResult({
        ok: true,
        clock: 'WALL',
        elapsed: 2,
        total: 4,
        truncated: false,
        nodes: [
            [0, 'MobScript.Scripts.GateMain', 10, 'tickGate', 2, 2, 0.1, 0.8, 1, 'MainThread', 'client', 1, 'MobScript'],
            [1, 'MobScript.Scripts.GateMain', 40, 'scanMobs', 4, 4, 0.9, 1.2, 1, 'MainThread', 'client', 1, 'MobScript'],
            [2, 'OtherMod.Scripts.Main', 7, 'otherTick', 3, 3, 0.6, 0.6, 1, 'MainThread', 'client', 1, 'OtherMod'],
            [3, 'mod/server/extraServerApi.py', 1, 'GetEngineCompFactory', 9, 9, 0.9, 1.4, 1, 'MainThread', 'client', 0, '']
        ],
        edges: [[0, 1, 4, 0.9, 1.2], [2, 3, 9, 0.9, 1.4], [0, 2, 1, 0, 0.1]]
    });
    assert.equal(parsed.functions[0].mod, 'MobScript');
    assert.equal(profilerFunctionMod(parsed.functions[0]), 'MobScript');
    assert.equal(profilerFunctionMod(parsed.functions[3]), '');
    const mods = parsed.mods ?? [];
    assert.deepEqual(mods.map(item => item.name), ['MobScript', 'OtherMod']);
    assert.equal(mods[0].functions, 2);
    assert.equal(mods[0].calls, 6);
    assert.equal(mods[0].selfTime.toFixed(2), '1.00');
    const scoped = filterPythonProfilerResultByMod(parsed, 'MobScript');
    assert.deepEqual(scoped.functions.map(item => item.name), ['tickGate', 'scanMobs']);
    assert.equal(scoped.totalFunctions, 2);
    assert.deepEqual(scoped.calls.map(item => [item.callerId, item.calleeId]), [[0, 1]]);
    assert.deepEqual((scoped.mods ?? []).map(item => item.name), ['MobScript']);
    assert.equal(scoped.clock, 'WALL');
    assert.equal(scoped.engineFunctions, parsed.engineFunctions);
    // 采集脚本要把 mod 归属一起带回来，并且按最长匹配取名
    const collect = buildPythonProfilerCollectCode('client');
    assert.match(collect, /_mcdev_pp_owner=_mcdev_pp_name/);
    assert.match(collect, /_mcdev_pp_module==_mcdev_pp_name or _mcdev_pp_module\.startswith\(_mcdev_pp_name\+'\.'\)/);
    // `_mcdev_pp_entry` 是 mod 名字符串（引擎函数是 ''），绝不能对它取下标：''[2] 会抛 IndexError
    assert.match(collect, /1 if _mcdev_pp_entry else 0,_mcdev_pp_entry\]/);
    assert.doesNotMatch(collect, /_mcdev_pp_entry\[/);
    // 调用关系要稳定保留：补一跳邻居（调用者/被调用者）；边也全量保留，条数只是防呆
    assert.match(collect, /def _mcdev_pp_owner_of\(_mcdev_pp_side,_mcdev_pp_module\):/);
    assert.match(collect, /_mcdev_pp_extra=\[\]/);
    assert.match(collect, /if _mcdev_pp_key in _mcdev_pp_ids: continue/);
    // 子节点是 YChildFuncStat，属性必须 getattr 兜底
    assert.match(collect, /_mcdev_pp_kids\.sort\(key=lambda _mcdev_pp_child:float\(getattr\(_mcdev_pp_child,'ttot',0\) or 0\),reverse=True\)/);
    assert.match(collect, /_mcdev_pp_kids\[:100000\]/);
    assert.match(collect, /_mcdev_pp_keep\+=_mcdev_pp_extra/);
    // 子节点 YChildFuncStat 没有 children 属性，必须走安全取子函数
    assert.match(collect, /def _mcdev_pp_kids_of\(_mcdev_pp_stat\):/);
    assert.equal(collect.includes('[1].children'), false, '不应直接访问 .children');
    // 旧载荷没有第 12/13 位：仍按 mod 函数处理，并用模块路径首段兜底分组
    const legacy = parsePythonProfilerResult({
        ok: true, clock: 'CPU', elapsed: 1, total: 1, truncated: false,
        nodes: [[0, 'Legacy/Mod/main.py', 3, 'boot', 1, 1, 0.2, 0.2, 1, 'MainThread']],
        edges: []
    });
    assert.equal(legacy.functions[0].isProject, true);
    assert.equal(legacy.functions[0].mod, '');
    assert.equal(profilerFunctionMod(legacy.functions[0]), 'Legacy');
    assert.deepEqual((legacy.mods ?? []).map(item => item.name), ['Legacy']);
});

test('Python profiler 读取 yappi 统计属性时一律 getattr 兜底', () => {
    // YChildFuncStat 没有 ctx_id / ctx_name，直接取属性会 AttributeError，
    // 导致整次采集失败（表现为「根本没有办法采集」）。
    for (const target of ['client', 'server', 'all'] as const) {
        const code = buildPythonProfilerCollectCode(target);
        assert.equal(/\.ctx_id\b(?!\s*,)/.test(code.replace(/getattr\([^)]*\)/g, '')), false,
            '不应直接访问 .ctx_id');
        assert.equal(/\.ctx_name\b/.test(code.replace(/getattr\([^)]*\)/g, '')), false,
            '不应直接访问 .ctx_name');
        assert.match(code, /getattr\(_mcdev_pp_stat,'ctx_id',0\)/);
    }
});
