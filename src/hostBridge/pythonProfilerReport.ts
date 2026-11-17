import { promises as fs } from 'fs';
import * as path from 'path';
import { ensureMcdevDirectory } from '../utils/mcdevDirectory';
import {
    filterPythonProfilerResultByMod,
    PythonProfilerResult,
    PythonProfilerSide,
    PythonProfilerTarget,
    summarizePythonProfilerMods
} from './pythonProfiler';

/**
 * 「复制给 Agent」正文里「Hot Classes / Modules」的形态：
 * - 'none'：不生成汇总，只留函数表，排序/归并交给 Agent；
 * - 'both'：汇总 + 三段函数表（默认）；
 * - 'only'：只留汇总（按类/模块聚合后已排好序，行名带 client. / server. 前缀），
 *   不再列 Client / Server / Other 三段函数表——正文最短。
 */
export type PythonProfilerClassesMode = 'none' | 'both' | 'only';

export interface PythonProfilerReportFiles {
    markdownPath: string;
    /** 按 mod 导出的报告只有 markdown，没有 svg */
    svgPath?: string;
}

export interface PythonProfilerReportContext {
    projectRoot: string;
    target: PythonProfilerTarget;
    worldName?: string;
    capturedAt: Date;
}

/**
 * 不落盘地渲染报告正文。「复制给 Agent」用它按用户设定的条数出一份收窄的正文，
 * 磁盘上的 .md 仍然是全量，两者互不影响。
 */
export function buildPythonProfilerReportMarkdown(
    context: PythonProfilerReportContext,
    result: PythonProfilerResult,
    options: PythonProfilerReportOptions = {}
): string {
    return renderMarkdown(context, result, {
        mod: options.mod,
        limit: options.limit,
        includeCalls: false,
        // 这份正文只发给 Agent：模块路径去掉段落标题已经写明的 MOD / 端前缀
        compact: true,
        classes: options.classes ?? 'both'
    });
}

/**
 * 落报告。带 mod 时只导出该 mod 的子集（md），文件名带 -mod-<名字>，
 * 「单独给 Agent 看某个 mod」与整体报告互不覆盖。
 */
export interface PythonProfilerReportOptions {
    /** 只导出某个 mod 的子集 */
    mod?: string;
    /**
     * 「复制给 Agent」时每段最多保留多少个函数（默认全部）；落盘报告始终是全量。
     * 大于 0 时调用关系表也一起收窄到 MAX_COPY_CALL_ROWS 条。
     */
    limit?: number;
    /** 「Hot Classes / Modules」汇总的形态（只影响复制正文，默认 both） */
    classes?: PythonProfilerClassesMode;
}

export async function writePythonProfilerReport(
    context: PythonProfilerReportContext,
    result: PythonProfilerResult,
    options: PythonProfilerReportOptions = {}
): Promise<PythonProfilerReportFiles> {
    const mcdevDirectory = await ensureMcdevDirectory(context.projectRoot);
    const reportDirectory = path.join(mcdevDirectory, 'profiles', 'python');
    const stamp = formatFileTimestamp(context.capturedAt);
    const mod = (options.mod || '').trim();
    const baseName = `${stamp}-${context.target}-${result.clock.toLowerCase()}`;
    const markdownPath = path.join(reportDirectory, `${baseName}.md`);
    const svgPath = path.join(reportDirectory, `${baseName}.svg`);
    const scopedMarkdownPath = mod
        ? path.join(reportDirectory, baseName + '-mod-' + slugifyMod(mod) + '.md')
        : markdownPath;
    await fs.mkdir(reportDirectory, { recursive: true });
    if (mod) {
        await fs.writeFile(scopedMarkdownPath, renderMarkdown(context, result, { mod }), 'utf8');
        return { markdownPath: scopedMarkdownPath };
    }
    await Promise.all([
        fs.writeFile(markdownPath, renderMarkdown(context, result, {}), 'utf8'),
        fs.writeFile(svgPath, renderSvg(context, result), 'utf8')
    ]);
    return { markdownPath, svgPath };
}

/** 给外部 Agent 的提问：带上完整报告正文，粘到任意对话窗口就能用；带 mod 时口径收窄到该 mod。 */
export function buildPythonProfilerAnalysisPrompt(
    markdownPath: string,
    markdown: string,
    mod?: string,
    limit?: number,
    classes: PythonProfilerClassesMode = 'both'
): string {
    const scopedMod = (mod || '').trim();
    const headline = scopedMod
        ? '请分析下面这份《我的世界》中国版 Python 性能采样报告里属于 MOD「' + scopedMod
            + '」的部分；其他 MOD 与引擎函数已排除，不要跨 MOD 归因。'
        : '请分析下面这份《我的世界》中国版服务端/客户端的 Python 性能采样报告。';
    const questions = scopedMod
        ? '重点回答：1) 这个 MOD 里总耗时最高的几个函数分别是谁，各占该 MOD 自身耗时的多少；'
            + '2) 哪些函数自身耗时高（占比大），说明是真正的热点逻辑；'
            + '3) 这个 MOD 内部的调用链里有哪条被反复走到，能否合并、缓存或改成事件驱动；'
            + '4) 是否存在每帧 / 每次事件都在重复做的字符串拼接、属性查找、对象创建与遍历，'
            + '按收益从大到小给出优化建议，并指明对应的文件与行号。'
        : '重点回答：1) 总耗时最高的几个函数分别是谁，占了多少；'
            + '2) 哪些函数自身耗时高（自身耗时占比大），说明是真正的热点逻辑；'
            + '3) 调用关系里有没有被反复调用的热点链路，能否合并或缓存；'
            + '4) 按收益从大到小给出优化建议，并指明对应的文件与行号。';
    return [
        headline,
        '',
        '报告文件：' + markdownPath,
        '',
        '--- 报告正文开始 ---',
        '',
        markdown.trim(),
        '',
        '--- 报告正文结束 ---',
        '',
        // 报告结构说明：不然 Agent 容易把三段当成三次采集
        (classes === 'only'
            ? '这段正文只给了按「类 / 模块」聚合后的汇总表（已按总耗时降序排好，每行自带 client. / server. 前缀，'
                + '不需要你再排序或归并），没有逐函数明细；'
                + (limit && limit > 0 ? '汇总只保留了总耗时最高的前 ' + limit + ' 类 / 模块（完整数据在报告文件里）；' : '')
                + '要函数级细节请看报告文件；'
                + '位置列的 MOD 前缀已省略。'
            : (limit && limit > 0
                ? '报告里的函数表按「客户端 / 服务端 / 其他」三段分列，每段只保留了总耗时最高的前 '
                    + limit + ' 个函数（完整数据在报告文件里）；'
                : '报告里的函数表按「客户端 / 服务端 / 其他」三段分列，每段都是这次采集的全部函数（按总耗时降序）；')
                + '位置列省略了段落标题已经写明的 MOD 名与端前缀；'
                + '三段来自同一次采集、窗口相同，可以横向比较；')
            + (classes === 'none'
                ? '这段正文没有「Hot Classes / Modules」汇总，需要按类归并时请自己从函数表聚合。'
                : classes === 'both'
                    ? '「Hot Classes / Modules」一节已经按类 / 模块聚合、按总耗时排好序，直接用它，不要自己重排。'
                    : '')
            + '这段正文没有带「调用关系」表（调用链可以从函数名与 Total / Self 的差值推断，'
            + '需要逐条边时再看报告文件）。',
        '',
        questions
    ].join('\n');
}

interface RenderMarkdownOptions {
    mod?: string;
    limit?: number;
    /**
     * 是否写「调用关系」一节。落盘报告要（默认 true）；「复制给 Agent」的正文不要——
     * 一次采集动辄上千条边、单条约 170 字符，光是这一节就能把对话上下文占满。
     */
    includeCalls?: boolean;
    /**
     * 精简模式（只给「复制给 Agent」的正文用）：模块路径去掉段落标题已经写明的
     * MOD / 端前缀，同一段里上下文完全一致时连 Context 列一起省掉——省字符就是省 token。
     */
    compact?: boolean;
    /** 「Hot Classes / Modules」汇总的形态（默认 both） */
    classes?: PythonProfilerClassesMode;
}

function renderMarkdown(
    context: PythonProfilerReportContext,
    result: PythonProfilerResult,
    options: RenderMarkdownOptions = {}
): string {
    const mod = options.mod;
    const limit = options.limit;
    const includeCalls = options.includeCalls !== false;
    const compact = options.compact === true;
    const classesMode: PythonProfilerClassesMode = options.classes ?? 'both';
    const includeClasses = classesMode !== 'none';
    // 'only'：汇总顶替三段函数表，行名必须自带 client. / server. 前缀（标题里没有端名可依据了）
    const standaloneClasses = classesMode === 'only';
    const scopedMod = (mod || '').trim();
    // 按 mod 导出时先收窄到该 mod 的函数，保证「面板里筛的」和「报告里写的」是同一批
    const scoped = scopedMod ? filterPythonProfilerResultByMod(result, scopedMod) : result;
    // 默认只看 mod 自己的函数；引擎 / 原版函数归到「其他」段（见 formatFunctionSections）
    const projectFunctions = scoped.functions.filter(item => item.isProject !== false);
    const engineFunctions = scoped.functions
        .filter(item => item.isProject === false)
        .sort((left, right) => right.totalTime - left.totalTime);
    const byId = new Map(projectFunctions.map(item => [item.id, item]));
    const calls = scoped.calls
        .filter(item => byId.has(item.callerId) && byId.has(item.calleeId))
        .slice()
        .sort((left, right) => right.totalTime - left.totalTime);
    const title = scopedMod
        ? '# Python Performance Profile - MOD ' + scopedMod
        : '# Python Performance Profile';
    const lines = [
        title,
        '',
        ...(scopedMod ? ['- MOD scope: ' + scopedMod] : []),
        '',
        `- Captured: ${context.capturedAt.toISOString()}`,
        `- Target: ${context.target}`,
        ...formatSides(result),
        `- Clock: ${result.clock}`,
        `- Duration: ${formatSeconds(result.elapsedSeconds)}`,
        `- World: ${context.worldName || 'unknown'}`,
        `- Project functions: ${scoped.totalFunctions}`,
        `- Engine functions (collapsed in panel): ${result.engineFunctions}`,
        `- Payload truncated: ${result.truncated ? 'yes' : 'no'}`,
        ...(limit && limit > 0 ? [`- Functions per section: top ${limit} by total time (copy limit)`] : []),
        // 复制正文不带调用关系表：这一节一次采集就有上千条边、十几万字符，
        // 粘进 Agent 对话会直接把上下文占满，而函数表本身已经够定位热点。
        ...(includeCalls ? [] : ['- Call relationships: not included in this copy (the report file lists them)']),
        ...(standaloneClasses ? ['- Function tables: omitted; only the class / module rollup is listed'] : []),
        ...(standaloneClasses && limit && limit > 0 ? [`- Classes / modules: top ${limit} by total time (copy limit)`] : []),
        '',
        '## MOD Breakdown',
        '',
        ...formatModBreakdown(scoped),
        // 'only' 模式下函数表明细整段省掉，只留下面按类/模块聚合的汇总
        ...(standaloneClasses
            ? ['']
            : formatFunctionSections(projectFunctions, engineFunctions, result.clock, limit, compact, scopedMod))
    ];
    // 按「类 / 模块」聚合，回答「到底是哪个类慢」——cProfile 的方法名形如 ClassName.method
    if (includeClasses) {
        const owners = new Map<string, { functions: Set<number>; calls: number; selfTime: number; totalTime: number }>();
        for (const item of projectFunctions) {
            // 精简模式下同一个类/模块不再重复带 MOD 前缀（模块级函数才会走到这条）；
            // 'only' 模式下没有分端标题，所以行名得自己带上 client. / server.
            const owner = formatOwner(item);
            const key = standaloneClasses
                ? withSidePrefix(item.target, stripModulePrefix(owner, item.mod || scopedMod, true))
                : (compact ? stripModulePrefix(owner, item.mod || scopedMod) : owner);
            let acc = owners.get(key);
            if (!acc) {
                acc = { functions: new Set<number>(), calls: 0, selfTime: 0, totalTime: 0 };
                owners.set(key, acc);
            }
            acc.functions.add(item.id);
            acc.calls += item.calls;
            acc.selfTime += item.selfTime;
            acc.totalTime += item.totalTime;
        }
        // 已按总耗时降序排好，Agent 直接用这张表就行，不需要自己再聚合一遍；
        // 'only' 模式下它是正文里唯一的明细，行数跟着「每段前 N / 全部」走（和函数表同一个口径）；
        // 'both' 模式下函数表已经全在，汇总只是索引，固定留前 20 条
        const ranked = Array.from(owners.entries())
            .sort((left, right) => right[1].totalTime - left[1].totalTime);
        const rollupLimit = standaloneClasses ? (limit && limit > 0 ? limit : 0) : 20;
        const hotOwners = rollupLimit > 0 ? ranked.slice(0, rollupLimit) : ranked;
        lines.push('## Hot Classes / Modules', '');
        if (hotOwners.length === 0) {
            lines.push('No project Python functions were captured.');
        } else {
            lines.push(
                ...(compact
                    ? ['Functions rolled up by class / module, already sorted by total time; use this table as is.', '']
                    : []),
                ...(standaloneClasses
                    ? ['Function-level tables are omitted in this copy; every row already carries its client. / server. prefix.', '']
                    : []),
                ...(hotOwners.length < ranked.length
                    ? [standaloneClasses
                        ? `Showing the top ${hotOwners.length} of ${ranked.length} class / module rows (copy limit; the saved report lists all of them).`
                        : `Showing the top ${hotOwners.length} of ${ranked.length} class / module rows; the function tables above already list every function.`, '']
                    : []),
                '| # | Class / Module | Functions | Calls | Self | Total |',
                '| -: | --- | ---: | ---: | ---: | ---: |'
            );
            hotOwners.forEach(([name, acc], index) => {
                lines.push(`| ${index + 1} | ${md(name)} | ${acc.functions.size} | ${acc.calls} | ${formatSeconds(acc.selfTime, acc.calls, result.clock)} | ${formatSeconds(acc.totalTime, acc.calls, result.clock)} |`);
            });
        }
    }
    // 复制正文不带调用关系表（见 includeCalls 说明）；落盘报告照旧全量
    if (includeCalls) {
        lines.push('', '## Call Relationships', '');
        if (calls.length === 0) {
            lines.push('No retained project-to-project call edges were captured.');
        } else {
            lines.push('| Caller | Callee | Calls | Self | Total |', '| --- | --- | ---: | ---: | ---: |');
            for (const call of calls) {
                const caller = byId.get(call.callerId);
                const callee = byId.get(call.calleeId);
                if (!caller || !callee) {
                    continue;
                }
                lines.push(`| ${md(`${caller.name} [${formatContext(caller)}]`)} | ${md(`${callee.name} [${formatContext(callee)}]`)} | ${call.calls} | ${formatSeconds(call.selfTime, call.calls, result.clock)} | ${formatSeconds(call.totalTime, call.calls, result.clock)} |`);
            }
        }
    }
    lines.push(
        '',
        '## Interpretation Notes',
        '',
        '- Self time excludes time spent in child Python functions.',
        '- Total time includes retained child calls and is best for locating expensive call paths.',
        '- CPU clock highlights computation; WALL clock also includes waiting and scheduling delays.',
        '- Profiler instrumentation adds overhead, so compare relative hotspots rather than treating values as production benchmarks.',
        ''
    );
    return lines.join('\n');
}

/**
 * 客户端 / 服务端 / 其他 三段分别列函数，每段都完整列出（不截断），按总耗时降序。
 * 拆段的原因：两端热点的量级差一个数量级，混在一张表里按 totalTime 排，
 * 服务端前几名会把客户端的函数整体挤出可见范围（之前的报告里客户端只剩个位数行）。
 */
function formatFunctionSections(
    projectFunctions: PythonProfilerResult['functions'],
    engineFunctions: PythonProfilerResult['functions'],
    clock: PythonProfilerResult['clock'],
    limit?: number,
    compact = false,
    /** 报告收窄到的 MOD：逐函数条目没带 mod 时用它去掉重复前缀 */
    mod?: string
): string[] {
    const client: PythonProfilerResult['functions'] = [];
    const server: PythonProfilerResult['functions'] = [];
    const other: PythonProfilerResult['functions'] = [];
    for (const item of projectFunctions) {
        if (item.target === 'server') {
            server.push(item);
        } else if (item.target === 'client') {
            client.push(item);
        } else {
            other.push(item);
        }
    }
    return [
        ...formatFunctionSection(
            'Client Functions (客户端)',
            client,
            clock,
            'Project functions that ran on the client thread.',
            limit,
            compact,
            'client',
            mod
        ),
        ...formatFunctionSection(
            'Server Functions (服务端)',
            server,
            clock,
            'Project functions that ran on the server thread.',
            limit,
            compact,
            'server',
            mod
        ),
        // 引擎 / 原版函数也带 target，若塞进上面两段会占掉该段的名额，所以统一归到「其他」
        ...formatFunctionSection(
            'Other Functions (其他)',
            other.concat(engineFunctions),
            clock,
            'Functions that are not attributed to a single side, plus engine / vanilla functions.',
            limit,
            compact,
            undefined,
            mod
        )
    ];
}

function formatFunctionSection(
    title: string,
    items: PythonProfilerResult['functions'],
    clock: PythonProfilerResult['clock'],
    note: string,
    limit?: number,
    compact = false,
    /** 本段固定的端；undefined = 「其他」段（端可能混杂，必须逐行保留） */
    side?: PythonProfilerSide,
    /** 报告收窄到的 MOD，用于去掉 Location 里重复的 MOD 名 */
    mod?: string
): string[] {
    // 落盘报告不截断（limit 不传就是全量）；limit 只来自「复制给 Agent」的条数设置
    const sorted = items.slice().sort((left, right) => right.totalTime - left.totalTime);
    const shown = limit && limit > 0 && sorted.length > limit ? sorted.slice(0, limit) : sorted;
    const lines = ['## ' + title, '', note];
    if (sorted.length === 0) {
        lines.push('', 'No functions were captured.', '');
        return lines;
    }
    // 整段只有一种「端 / 线程」时，逐行重复的 Context 列纯属浪费 —— 在段说明里讲一次就够
    const contexts = new Set(shown.map(item => formatContext(item)));
    const singleContext = compact && contexts.size === 1 ? formatContext(shown[0]) : undefined;
    // Location 列不再重复段落标题已经写明的 MOD 名与端名；没有可省的前缀时就不要空口声明
    const locationModule = (item: PythonProfilerResult['functions'][number]) =>
        stripModulePrefix(item.module, item.mod || mod || '');
    const stripped = compact && side
        ? shown.some(item => locationModule(item) !== (item.module || ''))
        : false;
    if (stripped) {
        lines.push('', 'Locations omit the MOD name and the ' + side + ' prefix, as noted in the section title.');
    }
    if (singleContext) {
        lines.push('', 'All rows ran on ' + singleContext + '.');
    }
    lines.push(
        '',
        shown.length === sorted.length
            ? (sorted.length === 1
                ? 'Showing the only captured function.'
                : `Showing all ${sorted.length} functions, ordered by total time.`)
            : `Showing the top ${shown.length} of ${sorted.length} functions by total time (copy limit; the saved report lists all of them).`,
        '',
        singleContext
            ? '| # | Function | Location | Calls | Self | Total | Avg |'
            : '| # | Function | Location | Calls | Self | Total | Avg | Runtime / Context |',
        singleContext
            ? '| -: | --- | --- | ---: | ---: | ---: | ---: |'
            : '| -: | --- | --- | ---: | ---: | ---: | ---: | --- |'
    );
    shown.forEach((item, index) => {
        const average = item.calls > 0 ? item.totalTime / item.calls : 0;
        const location = compact
            ? formatLocation(locationModule(item), item.line)
            : formatLocation(item.module, item.line);
        const row = `| ${index + 1} | ${md(item.name)} | ${md(location)} | ${item.calls} | ${formatSeconds(item.selfTime, item.calls, clock)} | ${formatSeconds(item.totalTime, item.calls, clock)} | ${formatSeconds(average, item.calls, clock)}`;
        lines.push(singleContext ? row + ' |' : row + ' | ' + md(formatContext(item)) + ' |');
    });
    lines.push('');
    return lines;
}

/**
 * 'only' 模式下汇总行没有分端标题，得自带 client. / server. 前缀；
 * 而模块名本身可能已经以端名开头（demo_mod.client.manager），别叠成 client.client.manager。
 */
function withSidePrefix(target: string, name: string): string {
    if (target !== 'client' && target !== 'server') {
        return name;
    }
    const side = target + '.';
    return name.startsWith(side) ? name : side + name;
}

/**
 * 去掉模块路径里重复的 MOD 名与端前缀：
 * 段落标题已经写了「Client Functions (客户端)」，再铺一遍 monster_girl_mod_Scripts.client.
 * 只是白占字符（这段正文是发给 Agent 的，省字符就是省 token）。
 */
function stripModulePrefix(module: string, mod?: string, keepSide = false): string {
    let value = module || '';
    const prefix = (mod || '').trim();
    if (prefix && value.startsWith(prefix + '.')) {
        value = value.slice(prefix.length + 1);
    }
    if (keepSide) {
        return value;
    }
    for (const side of ['client.', 'server.']) {
        if (value.startsWith(side)) {
            value = value.slice(side.length);
            break;
        }
    }
    return value;
}

function renderSvg(
    context: PythonProfilerReportContext,
    result: PythonProfilerResult
): string {
    const functions = result.functions
        .filter(item => item.isProject !== false)
        .sort((left, right) => right.totalTime - left.totalTime)
        .slice(0, 60);
    const width = 1400;
    const left = 420;
    const right = 92;
    const top = 112;
    const rowHeight = 26;
    const chartWidth = width - left - right;
    const height = Math.max(220, top + functions.length * rowHeight + 54);
    const maximum = Math.max(0.000001, ...functions.map(item => item.totalTime));
    const rows = functions.map((item, index) => {
        const y = top + index * rowHeight;
        const totalWidth = Math.max(1, item.totalTime / maximum * chartWidth);
        const selfWidth = Math.max(0, item.selfTime / maximum * chartWidth);
        const label = `[${formatContext(item)}] ${item.name} (${formatLocation(item.module, item.line)})`;
        const title = `${label}\nCalls: ${item.calls}\nSelf: ${formatSeconds(item.selfTime, item.calls, result.clock)}\nTotal: ${formatSeconds(item.totalTime, item.calls, result.clock)}`;
        return [
            `<g><title>${xml(title)}</title>`,
            `<text x="20" y="${y + 17}" class="fn">${xml(shorten(label, 58))}</text>`,
            `<rect x="${left}" y="${y + 4}" width="${totalWidth.toFixed(2)}" height="18" rx="3" fill="#4c8bd9"/>`,
            selfWidth > 0 ? `<rect x="${left}" y="${y + 4}" width="${selfWidth.toFixed(2)}" height="18" rx="3" fill="#b27adf"/>` : '',
            `<text x="${width - 18}" y="${y + 17}" text-anchor="end" class="time">${xml(formatSeconds(item.totalTime, item.calls, result.clock))}</text>`,
            '</g>'
        ].join('');
    }).join('\n');
    const empty = functions.length === 0
        ? '<text x="20" y="150" class="empty">No project Python functions were captured.</text>'
        : '';
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        '<style>',
        'text{font-family:Segoe UI,Arial,sans-serif;letter-spacing:0}.title{font-size:20px;font-weight:600;fill:#f2f2f2}.meta,.legend,.time{font-size:12px;fill:#b9bec8}.fn{font-size:12px;fill:#e5e7eb}.empty{font-size:14px;fill:#b9bec8}g:hover rect{stroke:#fff;stroke-width:1}',
        '</style>',
        `<rect width="${width}" height="${height}" fill="#1e1f23"/>`,
        '<text x="20" y="34" class="title">Python Performance Profile</text>',
        `<text x="20" y="58" class="meta">${xml(`${context.target.toUpperCase()} | ${result.clock} | ${formatSeconds(result.elapsedSeconds)} | ${context.capturedAt.toISOString()}`)}</text>`,
        `<text x="20" y="78" class="meta">${xml(context.worldName || path.basename(context.projectRoot))}</text>`,
        `<rect x="${left}" y="80" width="12" height="12" rx="2" fill="#4c8bd9"/><text x="${left + 18}" y="90" class="legend">Total</text>`,
        `<rect x="${left + 72}" y="80" width="12" height="12" rx="2" fill="#b27adf"/><text x="${left + 90}" y="90" class="legend">Self</text>`,
        rows,
        empty,
        '</svg>',
        ''
    ].join('\n');
}

/** 文件名里的 mod 名字：只留安全字符，避免 Windows 路径踩坑 */
function slugifyMod(mod: string): string {
    const slug = mod.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    return slug || 'mod';
}

/** 全量报告里加一节「哪个 mod 吃掉了时间」，方便直接按 mod 追问 Agent */
function formatModBreakdown(result: PythonProfilerResult): string[] {
    const mods = summarizePythonProfilerMods(result);
    if (mods.length === 0) {
        return ['No project mod functions were captured.', ''];
    }
    const totalSelf = mods.reduce((sum, item) => sum + item.selfTime, 0);
    const lines = [
        '| # | MOD | Functions | Calls | Self | Self share | Total (with nesting) |',
        '| -: | --- | ---: | ---: | ---: | ---: | ---: |'
    ];
    mods.forEach((item, index) => {
        const share = totalSelf > 0 ? (item.selfTime / totalSelf * 100).toFixed(1) + '%' : '-';
        lines.push('| ' + (index + 1) + ' | ' + md(item.name) + ' | ' + item.functions + ' | ' + item.calls
            + ' | ' + formatSeconds(item.selfTime, item.calls, result.clock)
            + ' | ' + share
            + ' | ' + formatSeconds(item.totalTime, item.calls, result.clock) + ' |');
    });
    lines.push('');
    return lines;
}

/**
 * 采到的端：'all' 是两端在同一次采样里，某一个没挂上时如实写出来，
 * 免得对着一份只有客户端的报告比较服务端耗时。
 */
function formatSides(result: PythonProfilerResult): string[] {
    const captured = (result.targets ?? []) as PythonProfilerSide[];
    if (captured.length === 0) {
        return [];
    }
    const missing = (result.missingSides ?? []).filter(side => !captured.includes(side));
    const suffix = missing.length > 0 ? ` (not captured: ${missing.join(', ')})` : '';
    return [`- Sides: ${captured.join(' + ')}${suffix}`];
}

function formatFileTimestamp(value: Date): string {
    const iso = value.toISOString();
    return iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 23).replace(/[:.]/g, '');
}

function formatSeconds(value: number, calls = 0, clock?: PythonProfilerResult['clock']): string {
    if (clock === 'CPU' && calls > 0 && value <= 0) {
        return '< clock resolution';
    }
    if (value >= 1) {
        return `${value.toFixed(3)} s`;
    }
    if (value >= 0.001) {
        return `${(value * 1000).toFixed(3)} ms`;
    }
    if (value > 0 && value < 0.000001) {
        return '< 1 us';
    }
    return `${(value * 1_000_000).toFixed(2)} us`;
}

function formatLocation(module: string, line: number): string {
    return line > 0 ? `${module}:${line}` : module;
}

function formatContext(item: PythonProfilerResult['functions'][number]): string {
    return `${item.target} / ${item.contextName || 'Thread'} #${item.contextId}`;
}

function shorten(value: string, maximum: number): string {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

/** 把 ClassName.method / module.function 收敛成「类名/模块名」，用于按类聚合 */
function formatOwner(item: PythonProfilerResult['functions'][number]): string {
    const dot = item.name.lastIndexOf('.');
    if (dot > 0) {
        return item.name.slice(0, dot);
    }
    return item.module || '(unknown)';
}

function md(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function xml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
