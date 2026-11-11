/**
 * 性能监测记录的持久化。
 *
 * 采样数据以前只活在 PerfMonitorController 的 runtime 里，切换页签 / 关闭面板 / 会话重建后
 * 就再也拿不到。这里做两件事：
 *  1. 进程内记住每个会话最近一次的 PerfMonitorSeries，面板重开还能接着看、接着记。
 *  2. 落盘到工作区的 .mcdev/perf 下：latest-<session>.json 由自动保存覆盖写入，
 *     手动保存/交给 Agent 分析时再写一份带时间戳的快照和一份 Markdown 报告。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureMcdevDirectory } from '../utils/mcdevDirectory';
import { PerfMonitorSample, PerfMonitorSeries, PerfMonitorStats } from './perfMonitor';

export interface PerfRecordPayload {
    sessionId: string;
    connectionGeneration: number;
    pid?: number;
    intervalMs: number;
    startedAt?: number;
    samples: PerfMonitorSample[];
    stats: PerfMonitorStats;
}

export interface PerfReportResult {
    reportPath: string;
    recordPath: string;
    /** 完整报告正文，复制给外部 Agent 时直接带上，不再依赖文件路径 */
    prompt: string;
}

/** key 与 controller 的 runtimeKey 保持一致：sessionId:connectionGeneration */
const rememberedSeries = new Map<string, PerfMonitorSeries>();
const MAX_RECORD_FILES = 40;

export function rememberPerfSeries(key: string, series: PerfMonitorSeries): void {
    rememberedSeries.set(key, series);
}

export function getRememberedPerfSeries(key: string): PerfMonitorSeries | undefined {
    return rememberedSeries.get(key);
}

export function forgetRememberedPerfSeries(key: string): void {
    rememberedSeries.delete(key);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function perfDirectory(): string | undefined {
    const root = workspaceRoot();
    return root ? path.join(root, '.mcdev', 'perf') : undefined;
}

function safeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'session';
}

function timeStamp(date = new Date()): string {
    const pad = (value: number, size = 2) => String(value).padStart(size, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

async function ensureDirectory(directory: string): Promise<void> {
    await fs.promises.mkdir(directory, { recursive: true });
}

/**
 * 落盘一份采样记录。overwrite=true 时写 latest-<session>.json（自动保存用）。
 * 没有工作区、没有采样点或写失败时返回 undefined，调用方按「没保存成功」处理。
 */
export async function savePerfRecord(
    payload: PerfRecordPayload,
    options: { overwrite?: boolean } = {}
): Promise<string | undefined> {
    const directory = perfDirectory();
    const root = workspaceRoot();
    if (!directory || !root || payload.samples.length === 0) {
        return undefined;
    }
    const session = safeSegment(payload.sessionId);
    const fileName = options.overwrite
        ? `latest-${session}.json`
        : `${timeStamp()}-${session}.json`;
    const target = path.join(directory, fileName);
    const document = {
        version: 1,
        savedAt: new Date().toISOString(),
        sessionId: payload.sessionId,
        connectionGeneration: payload.connectionGeneration,
        pid: payload.pid,
        intervalMs: payload.intervalMs,
        startedAt: payload.startedAt ? new Date(payload.startedAt).toISOString() : undefined,
        sampleCount: payload.samples.length,
        stats: payload.stats,
        samples: payload.samples
    };
    try {
        await ensureMcdevDirectory(root);
        await ensureDirectory(directory);
        await fs.promises.writeFile(target, JSON.stringify(document, undefined, 2), 'utf8');
    } catch (error) {
        console.error('Failed to persist the performance record', error);
        return undefined;
    }
    if (!options.overwrite) {
        await pruneRecords(directory).catch(() => undefined);
    }
    return target;
}

async function pruneRecords(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('latest-'))
        .map(entry => entry.name);
    if (files.length <= MAX_RECORD_FILES) {
        return;
    }
    const withTime = await Promise.all(
        files.map(async name => {
            const full = path.join(directory, name);
            const stat = await fs.promises.stat(full).catch(() => undefined);
            return { full, at: stat?.mtimeMs ?? 0 };
        })
    );
    withTime.sort((left, right) => left.at - right.at);
    const excess = withTime.slice(0, Math.max(0, withTime.length - MAX_RECORD_FILES));
    await Promise.all(excess.map(item => fs.promises.unlink(item.full).catch(() => undefined)));
}

function formatMegabytes(bytes: number): string {
    return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatSeconds(seconds: number): string {
    if (seconds < 60) {
        return seconds.toFixed(1) + 's';
    }
    return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
}

function formatClock(time: number): string {
    return new Date(time).toLocaleTimeString();
}

function describeSample(sample: PerfMonitorSample): string {
    const parts = [formatClock(sample.time)];
    if (typeof sample.fps === 'number') {
        parts.push('FPS ' + sample.fps.toFixed(1));
    }
    parts.push('CPU ' + sample.cpuPercent.toFixed(1) + '%');
    parts.push('内存 ' + formatMegabytes(sample.workingSetBytes));
    return parts.join(' | ');
}

/** 生成给 Agent 看的 Markdown 报告：概览 + 关键区间。 */
export function buildPerfReportMarkdown(payload: PerfRecordPayload, recordPath: string | undefined): string {
    const stats = payload.stats;
    const samples = payload.samples;
    const lines: string[] = [];
    lines.push('# 游戏性能采样报告');
    lines.push('');
    lines.push('- 会话：' + payload.sessionId + '（generation ' + payload.connectionGeneration + '）');
    if (payload.pid) {
        lines.push('- 游戏进程 PID：' + payload.pid);
    }
    lines.push('- 采样间隔：' + payload.intervalMs + ' ms');
    lines.push('- 采样点：' + samples.length + ' 个，时间窗口 ' + formatSeconds(stats.windowSeconds));
    if (payload.startedAt) {
        lines.push('- 开始时间：' + new Date(payload.startedAt).toLocaleString());
    }
    if (samples.length > 0) {
        lines.push('- 数据区间：' + new Date(samples[0].time).toLocaleString() + ' → '
            + new Date(samples[samples.length - 1].time).toLocaleString());
    }
    if (recordPath) {
        lines.push('- 原始数据：' + recordPath);
    }
    lines.push('');
    lines.push('## 概览');
    lines.push('');
    if (stats.fps) {
        lines.push('| 指标 | 数值 |');
        lines.push('| --- | --- |');
        lines.push('| 帧率 当前/平均 | ' + stats.fps.current.toFixed(1) + ' / ' + stats.fps.average.toFixed(1) + ' FPS |');
        lines.push('| 帧率 最低/最高 | ' + stats.fps.min.toFixed(1) + ' / ' + stats.fps.max.toFixed(1) + ' FPS |');
        lines.push('| 1% 最低帧 | ' + stats.fps.low1.toFixed(1) + ' FPS |');
    } else {
        lines.push('游戏没有暴露帧率计数，只有 CPU 与内存。');
        lines.push('');
        lines.push('| 指标 | 数值 |');
        lines.push('| --- | --- |');
    }
    lines.push('| CPU 当前/平均/峰值 | ' + stats.cpu.current.toFixed(1) + '% / '
        + stats.cpu.average.toFixed(1) + '% / ' + stats.cpu.peak.toFixed(1) + '% |');
    lines.push('| 内存 当前/平均/峰值 | ' + formatMegabytes(stats.memory.current) + ' / '
        + formatMegabytes(stats.memory.average) + ' / ' + formatMegabytes(stats.memory.peak) + ' |');
    lines.push('| 内存净增 | ' + formatMegabytes(stats.memory.growth) + ' |');
    lines.push('');

    if (samples.length > 1) {
        const cpuPeaks = samples.slice().sort((left, right) => right.cpuPercent - left.cpuPercent).slice(0, 5);
        lines.push('## CPU 占用最高的采样点');
        lines.push('');
        cpuPeaks.forEach(sample => lines.push('- ' + describeSample(sample)));
        lines.push('');

        const memoryPeaks = samples.slice()
            .sort((left, right) => right.workingSetBytes - left.workingSetBytes)
            .slice(0, 5);
        lines.push('## 内存占用最高的采样点');
        lines.push('');
        memoryPeaks.forEach(sample => lines.push('- ' + describeSample(sample)));
        lines.push('');

        const withFps = samples.filter(sample => typeof sample.fps === 'number');
        if (withFps.length > 1) {
            const fpsLows = withFps.slice()
                .sort((left, right) => (left.fps ?? 0) - (right.fps ?? 0))
                .slice(0, 5);
            lines.push('## 掉帧最严重的采样点');
            lines.push('');
            fpsLows.forEach(sample => lines.push('- ' + describeSample(sample)));
            lines.push('');
        }

        // 每 1/12 段取一个代表点，给出整体走势，避免报告过长
        const buckets = 12;
        const step = Math.max(1, Math.floor(samples.length / buckets));
        lines.push('## 走势抽样');
        lines.push('');
        for (let index = 0; index < samples.length; index += step) {
            lines.push('- ' + describeSample(samples[index]));
        }
        lines.push('');
    }
    return lines.join('\n');
}

export function buildPerfAnalysisPrompt(
    reportPath: string,
    recordPath: string | undefined,
    markdown: string
): string {
    const parts = [
        '请分析下面这份《我的世界》中国版游戏进程性能采样报告。',
        '',
        '报告文件：' + reportPath
    ];
    if (recordPath) {
        parts.push('原始采样数据：' + recordPath);
    }
    parts.push(
        '',
        '--- 报告正文开始 ---',
        '',
        markdown.trim(),
        '',
        '--- 报告正文结束 ---',
        '',
        '重点回答：1) 帧率是否稳定，掉帧集中在哪些时间点；'
        + '2) CPU 占用是否过高、有没有持续 100% 以上的单核打满；'
        + '3) 内存是否有持续增长趋势，是否存在泄漏迹象；'
        + '4) 结合数据给出按优先级排序的优化建议。'
    );
    return parts.join('\n');
}

/**
 * 写一份带时间戳的记录快照 + Markdown 报告，返回报告路径和给 Agent 的提问文本。
 */
export async function savePerfReport(payload: PerfRecordPayload): Promise<PerfReportResult | undefined> {
    const directory = perfDirectory();
    const root = workspaceRoot();
    if (!directory || !root || payload.samples.length === 0) {
        return undefined;
    }
    const recordPath = await savePerfRecord(payload);
    const reportDirectory = path.join(directory, 'reports');
    const stamp = timeStamp();
    const reportPath = path.join(reportDirectory, stamp + '-perf-report.md');
    const markdown = buildPerfReportMarkdown(payload, recordPath);
    try {
        await ensureMcdevDirectory(root);
        await ensureDirectory(reportDirectory);
        await fs.promises.writeFile(reportPath, markdown, 'utf8');
    } catch (error) {
        console.error('Failed to write the performance report', error);
        return undefined;
    }
    return {
        reportPath,
        recordPath: recordPath ?? '',
        prompt: buildPerfAnalysisPrompt(reportPath, recordPath, markdown)
    };
}
