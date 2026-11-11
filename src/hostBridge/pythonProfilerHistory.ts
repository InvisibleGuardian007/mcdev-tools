import { promises as fs } from 'fs';
import * as path from 'path';
import { ensureMcdevDirectory } from '../utils/mcdevDirectory';
import {
    PythonProfilerClock,
    PythonProfilerResult,
    PythonProfilerTarget
} from './pythonProfiler';

/** 采集历史里保存的最小函数记录：只留对比需要的字段 */
export interface PythonProfilerHistoryFunction {
    name: string;
    module: string;
    line: number;
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
const MAX_HISTORY_ENTRIES = 40;
/** 每份采集最多保存的函数条数，够对比即可，避免历史文件膨胀 */
const MAX_HISTORY_FUNCTIONS = 120;

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
    const projectFunctions = result.functions.filter(item => item.isProject !== false);
    const source = projectFunctions.length > 0 ? projectFunctions : result.functions;
    const functions = source
        .slice()
        .sort((left, right) => right.totalTime - left.totalTime)
        .slice(0, MAX_HISTORY_FUNCTIONS)
        .map(item => ({
            name: item.name,
            module: item.module,
            line: item.line,
            calls: item.calls,
            selfTime: round(item.selfTime),
            totalTime: round(item.totalTime)
        }));
    return {
        id: historyId(context.capturedAt, context.target, context.clock),
        capturedAt: context.capturedAt.toISOString(),
        target: context.target,
        clock: context.clock,
        elapsedSeconds: round(result.elapsedSeconds),
        totalCalls: result.functions.reduce((sum, item) => sum + item.calls, 0),
        functionCount: result.totalFunctions,
        worldName: context.worldName,
        functions
    };
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
