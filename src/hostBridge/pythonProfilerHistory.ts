import { promises as fs } from 'fs';
import * as path from 'path';
import { ensureMcdevDirectory } from '../utils/mcdevDirectory';
import {
    PythonProfilerCall,
    PythonProfilerClock,
    PythonProfilerFunction,
    PythonProfilerResult,
    PythonProfilerSide,
    PythonProfilerTarget,
    profilerFunctionMod
} from './pythonProfiler';

/** 采集历史里保存的最小函数记录：只留对比需要的字段 */
export interface PythonProfilerHistoryFunction {
    name: string;
    module: string;
    line: number;
    calls: number;
    selfTime: number;
    totalTime: number;
    /** 是否属于项目的 MOD 脚本；旧文件没有这个字段，按 MOD 函数处理 */
    isProject?: boolean;
    /** 该函数采自哪一端；「全部」采集时同一份历史里会有两端，旧文件没有这个字段 */
    target?: PythonProfilerSide;
}

/** 采集历史里的一条调用边：两端都是 functions 里的下标，避免重复存名字把文件撑大 */
export interface PythonProfilerHistoryCall {
    caller: number;
    callee: number;
    calls: number;
    selfTime: number;
    totalTime: number;
}

export interface PythonProfilerHistoryEntry {
    /** 文件主名，同时用作 A/B 选择时的 id */
    id: string;
    capturedAt: string;
    target: PythonProfilerTarget;
    clock: PythonProfilerClock;
    elapsedSeconds: number;
    totalCalls: number;
    functionCount: number;
    worldName?: string;
    functions: PythonProfilerHistoryFunction[];
    /** 调用关系（下标指向上面的 functions）；旧文件没有这个字段 */
    calls?: PythonProfilerHistoryCall[];
}

/** 列表用的精简视图：不带 functions 明细，避免每次刷新传几百 KB */
export interface PythonProfilerHistorySummary {
    id: string;
    capturedAt: string;
    target: PythonProfilerTarget;
    clock: PythonProfilerClock;
    elapsedSeconds: number;
    totalCalls: number;
    functionCount: number;
    worldName?: string;
    top?: PythonProfilerHistoryFunction;
}

export function toHistorySummary(entry: PythonProfilerHistoryEntry): PythonProfilerHistorySummary {
    return {
        id: entry.id,
        capturedAt: entry.capturedAt,
        target: entry.target,
        clock: entry.clock,
        elapsedSeconds: entry.elapsedSeconds,
        totalCalls: entry.totalCalls,
        functionCount: entry.functionCount,
        worldName: entry.worldName,
        top: entry.functions[0]
    };
}

export interface PythonProfilerHistoryContext {
    projectRoot: string;
    target: PythonProfilerTarget;
    clock: PythonProfilerClock;
    worldName?: string;
    capturedAt: Date;
}

/** 保留的采集份数（按时间，超出后删最旧） */
const MAX_HISTORY_ENTRIES = 20;
/**
 * 每份采集保存的函数条数上限：要够「只看某个 mod」回看时拿到这个 mod 的全部函数，
 * 所以上限按项目函数总量给足；再靠 MAX_HISTORY_ENTRIES 控制目录体积。
 */
const MAX_HISTORY_FUNCTIONS = 20000;
/** 每个 (端, mod) 组合的保底条数：和历史上限一样，按占比分配，避免慢的 mod 把别的挤掉 */
const MIN_HISTORY_FUNCTIONS_PER_GROUP = 16;
/** 为了让调用关系回看时对端不缺，额外带上与已保留函数直接相连的引擎函数 */
const MAX_HISTORY_NEIGHBOURS = 20000;
/** 每份采集最多保存的调用边数 */
const MAX_HISTORY_CALLS = 200000;

export async function pythonProfilerHistoryDirectory(projectRoot: string): Promise<string> {
    const mcdevDirectory = await ensureMcdevDirectory(projectRoot);
    const directory = path.join(mcdevDirectory, 'profiles', 'python', 'history');
    await fs.mkdir(directory, { recursive: true });
    return directory;
}

export function buildPythonProfilerHistoryEntry(
    context: PythonProfilerHistoryContext,
    result: PythonProfilerResult
): PythonProfilerHistoryEntry {
    const functions = selectHistoryFunctions(result);
    const indexById = new Map<number, number>();
    functions.forEach((item, index) => indexById.set(item.id, index));
    return {
        id: historyId(context.capturedAt, context.target, context.clock),
        capturedAt: context.capturedAt.toISOString(),
        target: context.target,
        clock: context.clock,
        elapsedSeconds: round(result.elapsedSeconds),
        totalCalls: result.functions.reduce((sum, item) => sum + item.calls, 0),
        functionCount: result.totalFunctions,
        worldName: context.worldName,
        functions: functions.map(item => ({
            name: item.name,
            module: item.module,
            line: item.line,
            calls: item.calls,
            selfTime: round(item.selfTime),
            totalTime: round(item.totalTime),
            isProject: item.isProject !== false,
            target: item.target
        })),
        calls: selectHistoryCalls(result.calls, indexById)
    };
}

/**
 * 历史里只存对比要用的 MOD 函数（按 (端, mod) 占比分配预算），再补上与它们直接相连的引擎函数；
 * 否则回看历史时「调用来源 / 下级调用」又是空的。
 */
function selectHistoryFunctions(result: PythonProfilerResult): PythonProfilerFunction[] {
    const project = result.functions.filter(item => item.isProject !== false);
    if (project.length === 0) {
        return selectByGroupShare(result.functions, MAX_HISTORY_FUNCTIONS);
    }
    const retained = selectByGroupShare(project, MAX_HISTORY_FUNCTIONS);
    if (result.calls.length === 0) {
        return retained;
    }
    const retainedIds = new Set(retained.map(item => item.id));
    const byId = new Map(result.functions.map(item => [item.id, item]));
    const neighbours = new Map<number, PythonProfilerFunction>();
    for (const call of result.calls) {
        const caller = byId.get(call.callerId);
        const callee = byId.get(call.calleeId);
        if (!caller || !callee) {
            continue;
        }
        if (retainedIds.has(caller.id) && !retainedIds.has(callee.id) && callee.isProject === false) {
            neighbours.set(callee.id, callee);
        } else if (retainedIds.has(callee.id) && !retainedIds.has(caller.id) && caller.isProject === false) {
            neighbours.set(caller.id, caller);
        }
    }
    if (neighbours.size === 0) {
        return retained;
    }
    const extra = Array.from(neighbours.values())
        .sort((left, right) => right.totalTime - left.totalTime)
        .slice(0, MAX_HISTORY_NEIGHBOURS);
    return retained.concat(extra);
}

/**
 * 按 (端, mod) 分组的条数占比分配预算：和采集侧同一规则。
 * 只按耗时截断时，服务端热函数会把客户端整段挤掉，回看单个 mod 也拿不到这个 mod 的全部函数。
 */
function selectByGroupShare(
    items: PythonProfilerFunction[],
    budget: number
): PythonProfilerFunction[] {
    if (items.length <= budget) {
        return items.slice().sort((left, right) => right.totalTime - left.totalTime);
    }
    const groups = new Map<string, PythonProfilerFunction[]>();
    for (const item of items) {
        const key = `${item.target}|${profilerFunctionMod(item)}`;
        const bucket = groups.get(key);
        if (bucket) {
            bucket.push(item);
        } else {
            groups.set(key, [item]);
        }
    }
    const total = items.length || 1;
    const kept: PythonProfilerFunction[] = [];
    for (const bucket of groups.values()) {
        bucket.sort((left, right) => right.totalTime - left.totalTime);
        const quota = Math.max(
            MIN_HISTORY_FUNCTIONS_PER_GROUP,
            Math.floor(budget * bucket.length / total)
        );
        kept.push(...bucket.slice(0, quota));
    }
    kept.sort((left, right) => right.totalTime - left.totalTime);
    return kept.slice(0, budget);
}

/** 只保留两端都在历史函数表里的调用边，并按耗时取前 N 条 */
function selectHistoryCalls(
    calls: PythonProfilerCall[],
    indexById: Map<number, number>
): PythonProfilerHistoryCall[] {
    const kept: PythonProfilerHistoryCall[] = [];
    for (const call of calls) {
        const caller = indexById.get(call.callerId);
        const callee = indexById.get(call.calleeId);
        if (caller === undefined || callee === undefined) {
            continue;
        }
        kept.push({
            caller,
            callee,
            calls: call.calls,
            selfTime: round(call.selfTime),
            totalTime: round(call.totalTime)
        });
    }
    kept.sort((left, right) => right.totalTime - left.totalTime);
    return kept.slice(0, MAX_HISTORY_CALLS);
}

/** 落盘一份采集摘要，返回写入的 id；同名（同一秒内两次采集）自动加后缀 */
export async function writePythonProfilerHistory(
    projectRoot: string,
    entry: PythonProfilerHistoryEntry
): Promise<string> {
    const directory = await pythonProfilerHistoryDirectory(projectRoot);
    let id = entry.id;
    let attempt = 1;
    let filePath = path.join(directory, `${id}.json`);
    while (attempt < 50) {
        try {
            // id 必须与文件名一致，否则同一秒内重复采集会读到两个相同 id
            await fs.writeFile(filePath, JSON.stringify({ ...entry, id }), { encoding: 'utf8', flag: 'wx' });
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
                throw error;
            }
            attempt += 1;
            id = `${entry.id}-${attempt}`;
            filePath = path.join(directory, `${id}.json`);
        }
    }
    await pruneHistory(directory).catch(() => undefined);
    return id;
}

/** 读取采集历史，新的在前 */
export async function readPythonProfilerHistory(
    projectRoot: string,
    limit = MAX_HISTORY_ENTRIES
): Promise<PythonProfilerHistoryEntry[]> {
    const directory = await pythonProfilerHistoryDirectory(projectRoot);
    const names = (await fs.readdir(directory).catch(() => [] as string[]))
        .filter(name => name.endsWith('.json'));
    const entries: PythonProfilerHistoryEntry[] = [];
    for (const name of names) {
        try {
            const raw = await fs.readFile(path.join(directory, name), 'utf8');
            const parsed = JSON.parse(raw) as PythonProfilerHistoryEntry;
            if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.functions)) {
                continue;
            }
            entries.push(parsed);
        } catch {
            // 单个历史文件损坏不影响整体列表
        }
    }
    entries.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
    return entries.slice(0, limit);
}

/**
 * 生成给 Agent 的极简对比摘要：用最少的字数承载最大的信息量。
 * 只列有变化的函数，数值用紧凑单位，路径保持可 grep。
 */
export function formatPythonProfilerComparison(
    base: PythonProfilerHistoryEntry,
    head: PythonProfilerHistoryEntry
): string {
    const baseMap = new Map(base.functions.map(item => [functionKey(item), item]));
    const headMap = new Map(head.functions.map(item => [functionKey(item), item]));
    const threshold = Math.max(0.005, Math.max(base.elapsedSeconds, head.elapsedSeconds) * 0.002);

    interface Delta {
        key: string;
        item: PythonProfilerHistoryFunction;
        base?: PythonProfilerHistoryFunction;
        selfDelta: number;
        totalDelta: number;
        callsDelta: number;
    }

    const deltas: Delta[] = [];
    for (const [key, item] of headMap) {
        const previous = baseMap.get(key);
        deltas.push({
            key,
            item,
            base: previous,
            selfDelta: item.selfTime - (previous?.selfTime ?? 0),
            totalDelta: item.totalTime - (previous?.totalTime ?? 0),
            callsDelta: item.calls - (previous?.calls ?? 0)
        });
    }
    const removed: Delta[] = [];
    for (const [key, item] of baseMap) {
        if (!headMap.has(key)) {
            removed.push({
                key,
                item,
                base: item,
                selfDelta: -item.selfTime,
                totalDelta: -item.totalTime,
                callsDelta: -item.calls
            });
        }
    }

    // 只在两次都出现的函数里算「变慢 / 变快」，新出现的单独列在「新增热点」
    const regressions = deltas
        .filter(item => item.base && item.selfDelta > threshold)
        .sort((left, right) => right.selfDelta - left.selfDelta)
        .slice(0, 8);
    const improvements = deltas
        .filter(item => item.base && item.selfDelta < -threshold)
        .sort((left, right) => left.selfDelta - right.selfDelta)
        .slice(0, 8);
    const added = deltas
        .filter(item => !item.base && item.item.totalTime > threshold)
        .sort((left, right) => right.item.totalTime - left.item.totalTime)
        .slice(0, 5);
    const gone = removed
        .filter(item => item.item.totalTime > threshold)
        .sort((left, right) => right.item.totalTime - left.item.totalTime)
        .slice(0, 5);
    const touched = new Set([
        ...regressions.map(item => item.key),
        ...improvements.map(item => item.key),
        ...added.map(item => item.key),
        ...gone.map(item => item.key)
    ]);
    const steady = deltas
        .filter(item => !touched.has(item.key) && item.item.totalTime > 0)
        .sort((left, right) => right.item.totalTime - left.item.totalTime)
        .slice(0, 5);

    const lines: string[] = [
        '# Python 性能对比（A 基线 → B 对比）',
        `A ${label(base)} | B ${label(head)}`,
        `总耗时 ${formatSeconds(base.elapsedSeconds)}→${formatSeconds(head.elapsedSeconds)}`
        + ` (${formatSignedSeconds(head.elapsedSeconds - base.elapsedSeconds)})`
        + ` 调用 ${formatCount(base.totalCalls)}→${formatCount(head.totalCalls)}`
        + ` 函数数 ${base.functionCount}→${head.functionCount}`
        + ` 变化阈值 ${formatSeconds(threshold)}`
    ];

    const section = (title: string, rows: Delta[], describe: (row: Delta) => string) => {
        if (rows.length === 0) {
            return;
        }
        lines.push('', `## ${title}`);
        for (const row of rows) {
            lines.push(describe(row));
        }
    };

    section('变慢（selfTime 增加）', regressions, row => [
        formatSignedSeconds(row.selfDelta),
        `self ${formatSeconds(row.base?.selfTime ?? 0)}→${formatSeconds(row.item.selfTime)}`,
        `total ${formatSeconds(row.base?.totalTime ?? 0)}→${formatSeconds(row.item.totalTime)}`,
        `calls ${formatCount(row.base?.calls ?? 0)}→${formatCount(row.item.calls)}`,
        location(row.item)
    ].join('  '));
    section('变快（selfTime 减少）', improvements, row => [
        formatSignedSeconds(row.selfDelta),
        `self ${formatSeconds(row.base?.selfTime ?? 0)}→${formatSeconds(row.item.selfTime)}`,
        `total ${formatSeconds(row.base?.totalTime ?? 0)}→${formatSeconds(row.item.totalTime)}`,
        `calls ${formatCount(row.base?.calls ?? 0)}→${formatCount(row.item.calls)}`,
        location(row.item)
    ].join('  '));
    section('新增热点（只在 B 出现）', added, row => [
        `total ${formatSeconds(row.item.totalTime)}`,
        `self ${formatSeconds(row.item.selfTime)}`,
        `calls ${formatCount(row.item.calls)}`,
        location(row.item)
    ].join('  '));
    section('消失热点（只在 A 出现）', gone, row => [
        `total ${formatSeconds(row.item.totalTime)}`,
        `self ${formatSeconds(row.item.selfTime)}`,
        `calls ${formatCount(row.item.calls)}`,
        location(row.item)
    ].join('  '));
    section('仍然很热（无变化）', steady, row => [
        `total ${formatSeconds(row.item.totalTime)}`,
        `self ${formatSeconds(row.item.selfTime)}`,
        `calls ${formatCount(row.item.calls)}`,
        location(row.item)
    ].join('  '));

    if (regressions.length + improvements.length + added.length + gone.length === 0) {
        lines.push('', `没有超过 ${formatSeconds(threshold)} 的变化：两次采样负载或热路径差异不明显。`);
    }
    lines.push(
        '',
        `B 的 ${head.clock} 时钟；A 的 ${base.clock} 时钟。`,
        '任务：按收益排序给最多 3 条优化动作（文件:行 + 具体改法），不要复述数据，不要泛泛而谈。'
    );
    return lines.join('\n');
}

function historyId(capturedAt: Date, target: PythonProfilerTarget, clock: PythonProfilerClock): string {
    const iso = capturedAt.toISOString();
    const stamp = iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '');
    return `${stamp}-${target}-${clock.toLowerCase()}`;
}

async function pruneHistory(directory: string): Promise<void> {
    const names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
    if (names.length <= MAX_HISTORY_ENTRIES) {
        return;
    }
    const stale = names.slice(0, names.length - MAX_HISTORY_ENTRIES);
    await Promise.all(stale.map(name => fs.unlink(path.join(directory, name)).catch(() => undefined)));
}

function functionKey(item: PythonProfilerHistoryFunction): string {
    return `${item.module}|${item.name}`;
}

function location(item: PythonProfilerHistoryFunction): string {
    return item.line > 0 ? `${item.module}:${item.line} ${item.name}` : `${item.module} ${item.name}`;
}

function label(entry: PythonProfilerHistoryEntry): string {
    const time = entry.capturedAt.replace('T', ' ').slice(0, 19);
    return `${time}Z ${entry.target}/${entry.clock} ${formatSeconds(entry.elapsedSeconds)}`
        + (entry.worldName ? ` world=${entry.worldName}` : '');
}

function round(value: number): number {
    return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}

function formatSeconds(value: number): string {
    const magnitude = Math.abs(value);
    if (magnitude >= 1) {
        return `${value.toFixed(2)}s`;
    }
    if (magnitude >= 0.001) {
        return `${Math.round(value * 1000)}ms`;
    }
    if (magnitude === 0) {
        return '0';
    }
    return `${(value * 1000).toFixed(1)}ms`;
}

function formatSignedSeconds(value: number): string {
    if (Math.abs(value) < 0.0005) {
        return '±0';
    }
    return value > 0 ? `+${formatSeconds(value)}` : `-${formatSeconds(-value)}`;
}

function formatCount(value: number): string {
    const magnitude = Math.abs(value);
    if (magnitude >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (magnitude >= 10_000) {
        return `${Math.round(value / 1000)}k`;
    }
    if (magnitude >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }
    return String(Math.round(value));
}
