import { promises as fs } from 'fs';
import * as path from 'path';

export type BuildKind =
    | 'modpc'
    | 'player-client'
    | 'editor'
    | 'vanilla'
    | 'unknown';

export interface BuildIdentity {
    kind: BuildKind;
    hasDevBuildMarker?: boolean;
}

const ENGINE_MARKERS = [
    'crashhunter_pc3.dll',
    'libenvsdk.dll',
    'physx_64.dll',
    'physxfoundation_64.dll'
];

const CLIENT_MARKERS = [
    'ntunisdkbase.dll',
    'ntunisdkroostx.dll'
];

const DEV_MARKER = 'dbghelp.dll';

export function classifyBuild(exeFileName: string, importedModules?: Set<string>): BuildIdentity {
    if (/\.editor\.exe$/i.test(exeFileName)) {
        return { kind: 'editor', hasDevBuildMarker: importedModules?.has(DEV_MARKER) };
    }
    if (!importedModules) {
        return { kind: 'unknown' };
    }
    const hasDevBuildMarker = importedModules.has(DEV_MARKER);
    if (!ENGINE_MARKERS.some(marker => importedModules.has(marker))) {
        return { kind: 'vanilla', hasDevBuildMarker };
    }
    if (CLIENT_MARKERS.some(marker => importedModules.has(marker))) {
        return { kind: 'player-client', hasDevBuildMarker };
    }
    return { kind: 'modpc', hasDevBuildMarker };
}

interface CacheEntry {
    stamp: string;
    identity: BuildIdentity;
}

const MAX_CACHED_PATHS = 64;
const cache = new Map<string, CacheEntry>();

function rememberIdentity(key: string, entry: CacheEntry): void {
    if (!cache.has(key) && cache.size >= MAX_CACHED_PATHS) {
        const oldest = cache.keys().next();
        if (!oldest.done) {
            cache.delete(oldest.value);
        }
    }
    cache.set(key, entry);
}

export function clearBuildIdentityCache(): void {
    cache.clear();
}

export async function identifyBuild(exePath: string): Promise<BuildIdentity> {
    const key = process.platform === 'win32' ? exePath.toLowerCase() : exePath;
    let stamp = '';
    try {
        const stat = await fs.stat(exePath);
        stamp = `${stat.mtimeMs}:${stat.size}`;
        const cached = cache.get(key);
        if (cached && cached.stamp === stamp) {
            return cached.identity;
        }
    } catch {
        return { kind: 'unknown' };
    }

    const identity = classifyBuild(path.basename(exePath), await readImportedModules(exePath));
    if (identity.kind !== 'unknown') {
        rememberIdentity(key, { stamp, identity });
    }
    return identity;
}

export const CHUNK_SIZE = 64 * 1024;
const MAX_CACHED_CHUNKS = 64;

export class ChunkedFileReader {
    private readonly chunks = new Map<number, Buffer>();

    constructor(private readonly handle: fs.FileHandle) {}

    get chunksRead(): number {
        return this.chunks.size;
    }

    async read(offset: number, length: number): Promise<Buffer> {
        if (offset < 0 || length <= 0) {
            return Buffer.alloc(0);
        }
        const firstChunk = Math.floor(offset / CHUNK_SIZE);
        const lastChunk = Math.floor((offset + length - 1) / CHUNK_SIZE);

        const pieces: Buffer[] = [];
        for (let index = firstChunk; index <= lastChunk; index += 1) {
            const chunk = await this.chunk(index);
            const chunkStart = index * CHUNK_SIZE;
            const from = Math.max(0, offset - chunkStart);
            const to = Math.min(chunk.length, offset + length - chunkStart);
            if (to > from) {
                pieces.push(chunk.subarray(from, to));
            }
            if (chunk.length < CHUNK_SIZE) {
                break;
            }
        }
        return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    }

    private async chunk(index: number): Promise<Buffer> {
        const cached = this.chunks.get(index);
        if (cached) {
            return cached;
        }
        const buffer = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await this.handle.read(buffer, 0, CHUNK_SIZE, index * CHUNK_SIZE);
        const chunk = bytesRead === CHUNK_SIZE ? buffer : buffer.subarray(0, bytesRead);
        if (this.chunks.size >= MAX_CACHED_CHUNKS) {
            const oldest = this.chunks.keys().next();
            if (!oldest.done) {
                this.chunks.delete(oldest.value);
            }
        }
        this.chunks.set(index, chunk);
        return chunk;
    }
}

export async function readImportedModules(exePath: string): Promise<Set<string> | undefined> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(exePath, 'r');
        const reader = new ChunkedFileReader(handle);
        const readAt = (offset: number, length: number): Promise<Buffer> => reader.read(offset, length);

        const dos = await readAt(0, 0x40);
        if (dos.length < 0x40 || dos.readUInt16LE(0) !== 0x5a4d) {
            return undefined;
        }
        const peOffset = dos.readUInt32LE(0x3c);

        const nt = await readAt(peOffset, 0x108);
        if (nt.length < 0x18 || nt.readUInt32LE(0) !== 0x00004550) {
            return undefined;
        }
        const sectionCount = nt.readUInt16LE(6);
        const optionalHeaderSize = nt.readUInt16LE(20);
        const isPe32Plus = nt.readUInt16LE(24) === 0x20b;
        const dirCountOffset = 24 + (isPe32Plus ? 108 : 92);
        const dirTableOffset = 24 + (isPe32Plus ? 112 : 96);
        if (nt.length < dirTableOffset + 8) {
            return undefined;
        }
        const dirCount = nt.readUInt32LE(dirCountOffset);

        const directoryRva = (index: number): number => {
            if (index >= dirCount || nt.length < dirTableOffset + 8 * index + 4) {
                return 0;
            }
            return nt.readUInt32LE(dirTableOffset + 8 * index);
        };

        const sectionTable = await readAt(peOffset + 24 + optionalHeaderSize, sectionCount * 40);
        const sections: Array<{ virtualAddress: number; span: number; rawOffset: number }> = [];
        for (let i = 0; i + 40 <= sectionTable.length; i += 40) {
            const virtualSize = sectionTable.readUInt32LE(i + 8);
            const virtualAddress = sectionTable.readUInt32LE(i + 12);
            const rawSize = sectionTable.readUInt32LE(i + 16);
            const rawOffset = sectionTable.readUInt32LE(i + 20);
            sections.push({ virtualAddress, span: Math.max(virtualSize, rawSize), rawOffset });
        }

        const toFileOffset = (rva: number): number | undefined => {
            for (const section of sections) {
                if (rva >= section.virtualAddress && rva < section.virtualAddress + section.span) {
                    return section.rawOffset + (rva - section.virtualAddress);
                }
            }
            return undefined;
        };

        const readModuleName = async (rva: number): Promise<string> => {
            const offset = toFileOffset(rva);
            if (offset === undefined) {
                return '';
            }
            const raw = await readAt(offset, 256);
            const end = raw.indexOf(0);
            return raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
        };

        const modules = new Set<string>();
        for (const [dirIndex, stride, nameFieldOffset] of [[1, 20, 12], [13, 32, 4]] as const) {
            const base = directoryRva(dirIndex);
            if (!base) {
                continue;
            }
            for (let cursor = 0; cursor < stride * 4096; cursor += stride) {
                const start = toFileOffset(base + cursor);
                if (start === undefined) {
                    break;
                }
                const descriptor = await readAt(start, stride);
                if (descriptor.length < stride || descriptor.every(byte => byte === 0)) {
                    break;
                }
                const nameRva = descriptor.readUInt32LE(nameFieldOffset);
                if (!nameRva) {
                    break;
                }
                const name = await readModuleName(nameRva);
                if (name) {
                    modules.add(name.toLowerCase());
                }
            }
        }
        return modules.size > 0 ? modules : undefined;
    } catch {
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}
