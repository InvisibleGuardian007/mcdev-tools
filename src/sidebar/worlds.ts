import * as fs from 'fs';
import * as path from 'path';
import { normalizePackId, readWorldPackIds, resolveWorldsRoot } from '../hostBridge/worldMods';

/** minecraftWorlds 下的一个存档概要，用于「选择存档」下拉 */
export interface WorldSummary {
    /** 存档文件夹名，对应 .mcdev.json 的 world_folder_name */
    folder: string;
    /** levelname.txt 里的世界名 */
    name: string;
    /** 存档引用的行为包数量 */
    packs: number;
    /** level.dat 的最后修改时间（毫秒），用于排序 */
    modifiedAt: number;
    /** 这个存档引用的 MOD 中，本地能找到对应目录的数量 */
    matchedMods: number;
}

function readWorldName(folderPath: string, fallback: string): string {
    try {
        const raw = fs.readFileSync(path.join(folderPath, 'levelname.txt'), 'utf8');
        const name = raw.replace(/^\uFEFF/, '').split(/\r?\n/)[0].trim();
        return name || fallback;
    } catch {
        return fallback;
    }
}

function countWorldPacks(folderPath: string): number {
    try {
        const raw = fs.readFileSync(path.join(folderPath, 'world_behavior_packs.json'), 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
        return 0;
    }
}

function readWorldModifiedAt(folderPath: string): number {
    try {
        return fs.statSync(path.join(folderPath, 'level.dat')).mtimeMs;
    } catch {
        return 0;
    }
}

export interface ListWorldsOptions {
    /** 某个 pack id 在本地是否有对应目录，用于算出「可装配的 MOD 数」 */
    hasLocalPack?: (packId: string) => boolean;
}

/**
 * 列出本机 minecraftWorlds 下的存档，按最近修改时间倒序。
 * rootOverride 仅用于测试。
 */
export function listMinecraftWorlds(rootOverride?: string, options: ListWorldsOptions = {}): WorldSummary[] {
    const root = rootOverride ?? resolveWorldsRoot();
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        console.warn(`读取存档目录失败: ${root}`, error);
        return [];
    }
    const countMatched = (folderPath: string): number => {
        if (!options.hasLocalPack) {
            return 0;
        }
        const ids = readWorldPackIds(folderPath);
        const unique = new Set([...ids.behavior, ...ids.resource].map(id => normalizePackId(id)));
        let matched = 0;
        for (const id of unique) {
            if (options.hasLocalPack(id)) {
                matched += 1;
            }
        }
        return matched;
    };
    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const folderPath = path.join(root, entry.name);
            return {
                folder: entry.name,
                name: readWorldName(folderPath, entry.name),
                packs: countWorldPacks(folderPath),
                modifiedAt: readWorldModifiedAt(folderPath),
                matchedMods: countMatched(folderPath),
            };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
}
