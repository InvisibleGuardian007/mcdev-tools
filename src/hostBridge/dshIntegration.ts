import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 把 mcdk 的 MCP 端点写进 DeepSeek Harness（DSH）的 profile 补丁层。
 *
 * DSH 的 profiles/<name>/cordis.patch.yml 是一个顶层 YAML 数组，每个元素是一条
 * loader 补丁；MCP 服务器靠 `- insert:` 里挂一个 @deepseek-ai/dsh-mcp-client 条目。
 * 这里只负责「幂等地加一条自己的条目」，不碰别人的内容。
 */

const MARKER = 'mcdev-tools mcdk';

export interface DshEntryOptions {
    name?: string;
}

/** 生成一条带标记的 insert 条目（同一条目再次写入会被原地替换） */
export function buildDshPatchEntry(url: string, options: DshEntryOptions = {}): string {
    const name = options.name || 'minecraft';
    return [
        `- insert: # ${MARKER}`,
        `    - id: mcdev-mcp-${name}`,
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        `        serverName: "${name}"`,
        '        transport: "streamable-http"',
        `        url: "${url}"`,
        '',
    ].join('\n');
}

/** 找到某个顶层数组元素（从行首 `- ` 开始，到下一个行首 `- ` 之前） */
function findTopLevelEntry(lines: string[], needle: string): { start: number; end: number } | null {
    const hit = lines.findIndex(line => line.includes(needle));
    if (hit < 0) {
        return null;
    }
    let start = hit;
    while (start > 0 && !/^- /.test(lines[start])) {
        start -= 1;
    }
    if (!/^- /.test(lines[start])) {
        return null;
    }
    let end = start + 1;
    while (end < lines.length && !/^- /.test(lines[end])) {
        end += 1;
    }
    return { start, end };
}

/** 幂等写入：已有同 id 条目就原地替换，没有就追加到文件末尾 */
export function upsertDshPatchEntry(content: string, entry: string, options: DshEntryOptions = {}): string {
    const name = options.name || 'minecraft';
    const entryLines = entry.replace(/\n+$/, '').split(/\r?\n/);
    const text = content || '';
    const lines = text.split(/\r?\n/);
    const range = findTopLevelEntry(lines, `id: mcdev-mcp-${name}`);
    if (!range) {
        const base = text.replace(/\s+$/, '');
        return base ? `${base}\n${entryLines.join('\n')}\n` : `${entryLines.join('\n')}\n`;
    }
    // 只替换这一段，不碰文件里其他内容（连空行也不归一化）
    const next = [...lines.slice(0, range.start), ...entryLines, ...lines.slice(range.end)];
    const result = next.join('\n');
    // 条目在文件末尾时，切片会带走结尾换行；保持原来的收尾风格，二次写入才会是空改动
    return /\r?\n$/.test(text) && !result.endsWith('\n') ? `${result}\n` : result;
}

export function resolveDshRoot(root?: string): string {
    if (root && root.trim()) {
        return root.trim();
    }
    const fromEnv = process.env.DSH_HOME;
    if (fromEnv && fromEnv.trim()) {
        return fromEnv.trim();
    }
    return path.join(os.homedir(), '.dsh');
}

/** 所有存在 cordis.patch.yml 的 profile 文件 */
export function listDshPatchFiles(root?: string): string[] {
    const profilesDir = path.join(resolveDshRoot(root), 'profiles');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(profilesDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = path.join(profilesDir, entry.name, 'cordis.patch.yml');
        if (fs.existsSync(candidate)) {
            files.push(candidate);
        }
    }
    return files.sort();
}

export interface DshInstallResult {
    ok: boolean;
    /** 已包含该条目的配置文件 */
    files: string[];
    /** 本次真正改写的配置文件 */
    changed: string[];
    error?: string;
}

export interface DshInstallOptions extends DshEntryOptions {
    url: string;
    root?: string;
}

/** 把端点写进每个 profile；已有则更新，内容一致则不动 */
export function installDshMcpEntry(options: DshInstallOptions): DshInstallResult {
    const url = (options.url || '').trim();
    if (!url) {
        return { ok: false, files: [], changed: [], error: 'missing url' };
    }
    const files = listDshPatchFiles(options.root);
    if (!files.length) {
        return { ok: false, files: [], changed: [], error: 'no dsh profiles' };
    }
    const entry = buildDshPatchEntry(url, options);
    const touched: string[] = [];
    const changed: string[] = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const next = upsertDshPatchEntry(content, entry, options);
            if (next === content) {
                touched.push(file);
                continue;
            }
            fs.writeFileSync(`${file}.mcdev.bak`, content, 'utf8');
            fs.writeFileSync(file, next, 'utf8');
            touched.push(file);
            changed.push(file);
        } catch (error) {
            return { ok: false, files: touched, changed, error: error instanceof Error ? error.message : String(error) };
        }
    }
    return { ok: true, files: touched, changed };
}
