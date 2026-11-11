import * as fs from 'fs';
import * as path from 'path';

/** 存档引用的一组 pack id（已去掉横线并转小写，便于比较） */
export interface WorldPackIds {
    behavior: string[];
    resource: string[];
}

/** 按存档装配 MOD 的结果 */
export interface WorldModResolution {
    /** 需要装配的 mod 目录；工作区根目录统一写成 './' */
    dirs: string[];
    /** 在本地找到对应目录的 pack 数量 */
    matchedPacks: number;
    /** 本地找不到对应目录的 pack id（常见的是 mcdk 注入的调试包） */
    unknownPacks: string[];
}

export function normalizePackId(value: unknown): string {
    return String(value ?? '').replace(/-/g, '').trim().toLowerCase();
}

/** 比较路径用：统一分隔符与大小写 */
export function normalizeDirKey(value: string): string {
    return path.normalize(value).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
}

function readJsonFile(filePath: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
        return undefined;
    }
}

/** 读取存档引用的行为包 / 资源包 id */
export function readWorldPackIds(worldDir: string): WorldPackIds {
    const collect = (fileName: string): string[] => {
        const parsed = readJsonFile(path.join(worldDir, fileName));
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map(entry => normalizePackId((entry as { pack_id?: unknown })?.pack_id))
            .filter(id => id.length > 0);
    };
    return {
        behavior: collect('world_behavior_packs.json'),
        resource: collect('world_resource_packs.json'),
    };
}

/**
 * 扫描候选目录，建立 pack uuid -> 包目录 的索引。
 * 每个候选目录下的一级子目录只要带 manifest.json 就视为一个 pack 目录。
 */
export function indexModPacks(candidateDirs: Iterable<string>): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const seenCandidates = new Set<string>();
    for (const candidate of candidateDirs) {
        const key = normalizeDirKey(candidate);
        if (seenCandidates.has(key)) {
            continue;
        }
        seenCandidates.add(key);
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(candidate, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const packDir = path.join(candidate, entry.name);
            const manifestPath = path.join(packDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                continue;
            }
            const manifest = readJsonFile(manifestPath) as { header?: { uuid?: unknown }; uuid?: unknown } | undefined;
            const uuid = normalizePackId(manifest?.header?.uuid ?? manifest?.uuid);
            if (!uuid) {
                continue;
            }
            const bucket = index.get(uuid) ?? [];
            bucket.push(packDir);
            index.set(uuid, bucket);
        }
    }
    return index;
}

/**
 * 组装候选 mod 目录：工作区根目录 + .mcdev.json 里列出的目录 + 工作区根下的一级子目录。
 */
export function collectModCandidates(workspaceRoot: string, listedDirs: Iterable<string>): string[] {
    const candidates: string[] = [workspaceRoot];
    for (const dir of listedDirs) {
        const resolved = path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);
        candidates.push(resolved);
    }
    try {
        for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                candidates.push(path.join(workspaceRoot, entry.name));
            }
        }
    } catch {
        // 工作区不可读时只用已有候选
    }
    return candidates;
}

/**
 * 由存档引用的 pack 反推需要装配的 mod 目录。
 * 工作区根目录的包映射成 './'，其余用绝对路径，与原 included_mod_dirs 的写法一致。
 */
export function resolveWorldModDirs(
    workspaceRoot: string,
    worldDir: string,
    listedDirs: Iterable<string>,
): WorldModResolution {
    const listed = Array.from(listedDirs);
    const index = indexModPacks(collectModCandidates(workspaceRoot, listed));
    const packIds = readWorldPackIds(worldDir);
    const allIds = [...packIds.behavior, ...packIds.resource];
    const rootKey = normalizeDirKey(workspaceRoot);
    const dirs: string[] = [];
    const picked = new Set<string>();
    const unknownPacks: string[] = [];
    let matchedPacks = 0;

    for (const packId of allIds) {
        const packDirs = index.get(packId);
        if (!packDirs || packDirs.length === 0) {
            unknownPacks.push(packId);
            continue;
        }
        matchedPacks += 1;
        for (const packDir of packDirs) {
            const owner = path.dirname(packDir);
            const ownerKey = normalizeDirKey(owner);
            const value = ownerKey === rootKey ? './' : owner;
            const valueKey = normalizeDirKey(value);
            if (picked.has(valueKey)) {
                continue;
            }
            picked.add(valueKey);
            dirs.push(value);
        }
    }

    // 工作区根目录（当前 mod 本体）永远排在最前
    dirs.sort((a, b) => {
        const aRoot = normalizeDirKey(a) === rootKey || a === './' ? 0 : 1;
        const bRoot = normalizeDirKey(b) === rootKey || b === './' ? 0 : 1;
        return aRoot - bRoot;
    });

    return { dirs, matchedPacks, unknownPacks };
}

/** 在 minecraftWorlds 根目录下按文件夹名找存档目录 */
export function findWorldDir(worldsRoot: string, folderName: string): string | undefined {
    const target = folderName.trim();
    if (!target) {
        return undefined;
    }
    try {
        if (!fs.existsSync(worldsRoot)) {
            return undefined;
        }
        const entries = fs.readdirSync(worldsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
        const exact = entries.find(entry => entry.name === target);
        if (exact) {
            return path.join(worldsRoot, exact.name);
        }
        const lower = target.toLowerCase();
        const loose = entries.find(entry => entry.name.toLowerCase() === lower);
        return loose ? path.join(worldsRoot, loose.name) : undefined;
    } catch {
        return undefined;
    }
}

/** 网易启动器的存档根目录（%APPDATA%\MinecraftPE_Netease\minecraftWorlds） */
export function resolveWorldsRoot(): string | undefined {
    const roamingRoots = [
        process.env.APPDATA,
        process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : undefined,
    ].filter((value): value is string => Boolean(value && value.trim()));
    for (const root of roamingRoots) {
        const candidate = path.join(root as string, 'MinecraftPE_Netease', 'minecraftWorlds');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return roamingRoots.length > 0
        ? path.join(roamingRoots[0] as string, 'MinecraftPE_Netease', 'minecraftWorlds')
        : undefined;
}

/** 读取 .mcdev.json 里列出的 mod 目录（兼容字符串与 { path } 两种写法） */
export function readIncludedModDirs(workspaceRoot: string): string[] {
    const config = readJsonFile(path.join(workspaceRoot, '.mcdev.json')) as
        | { included_mod_dirs?: unknown }
        | undefined;
    const list = Array.isArray(config?.included_mod_dirs) ? config?.included_mod_dirs : [];
    return (list as unknown[])
        .map(entry => (typeof entry === 'string' ? entry : String((entry as { path?: unknown })?.path ?? '')))
        .filter(value => value.length > 0);
}

export interface WorldAutoModsResult {
    status: 'applied' | 'unchanged' | 'skipped' | 'failed';
    /** 装配后的 mod 目录（工作区根为 './'） */
    dirs: string[];
    worldDir?: string;
    matchedPacks: number;
    unknownPacks: string[];
    reason?: string;
}

function mergeModDirEntries(previous: unknown[], nextDirs: string[]): unknown[] {
    const byKey = new Map<string, unknown>();
    for (const entry of previous) {
        const value = typeof entry === 'string' ? entry : String((entry as { path?: unknown })?.path ?? '');
        if (!value) {
            continue;
        }
        byKey.set(normalizeDirKey(value), entry);
    }
    return nextDirs.map(dir => byKey.get(normalizeDirKey(dir)) ?? dir);
}

/**
 * 按 .mcdev.json 里选中的存档，把 included_mod_dirs 重写成该存档实际引用的 mod 目录。
 * force=true 时忽略 world_auto_mods 开关（用户手动点“立即同步”）。
 */
export function applyWorldAutoMods(
    workspaceRoot: string,
    options: { force?: boolean; worldFolder?: string; worldsRoot?: string } = {},
): WorldAutoModsResult {
    const configPath = path.join(workspaceRoot, '.mcdev.json');
    const config = readJsonFile(configPath) as Record<string, unknown> | undefined;
    if (!config) {
        return { status: 'failed', dirs: [], matchedPacks: 0, unknownPacks: [], reason: '读取 .mcdev.json 失败' };
    }
    if (config.world_auto_mods === false && !options.force) {
        return { status: 'skipped', dirs: [], matchedPacks: 0, unknownPacks: [], reason: '已关闭按存档装配' };
    }
    const folder = String(options.worldFolder ?? config.world_folder_name ?? '').trim();
    const worldsRoot = options.worldsRoot ?? resolveWorldsRoot();
    if (!worldsRoot) {
        return { status: 'failed', dirs: [], matchedPacks: 0, unknownPacks: [], reason: '找不到存档目录' };
    }
    if (!folder) {
        return { status: 'skipped', dirs: [], matchedPacks: 0, unknownPacks: [], reason: '未选择存档' };
    }
    const worldDir = findWorldDir(worldsRoot, folder);
    if (!worldDir) {
        // 新存档还没生成，沿用原有 MOD 列表
        return { status: 'skipped', dirs: [], matchedPacks: 0, unknownPacks: [], reason: `存档 ${folder} 尚未生成` };
    }
    const previous = Array.isArray(config.included_mod_dirs) ? (config.included_mod_dirs as unknown[]) : [];
    const listedDirs = readIncludedModDirs(workspaceRoot);
    const resolution = resolveWorldModDirs(workspaceRoot, worldDir, listedDirs);
    if (resolution.dirs.length === 0) {
        return {
            status: 'skipped',
            dirs: [],
            worldDir,
            matchedPacks: resolution.matchedPacks,
            unknownPacks: resolution.unknownPacks,
            reason: '该存档引用的 MOD 在本地都找不到',
        };
    }
    const nextEntries = mergeModDirEntries(previous, resolution.dirs);
    if (JSON.stringify(nextEntries) === JSON.stringify(previous)) {
        return {
            status: 'unchanged',
            dirs: resolution.dirs,
            worldDir,
            matchedPacks: resolution.matchedPacks,
            unknownPacks: resolution.unknownPacks,
        };
    }
    config.included_mod_dirs = nextEntries;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf8');
    return {
        status: 'applied',
        dirs: resolution.dirs,
        worldDir,
        matchedPacks: resolution.matchedPacks,
        unknownPacks: resolution.unknownPacks,
    };
}
