import * as cp from 'child_process';
import { BuildKind, identifyBuild } from './buildIdentity';

export interface MinecraftProcess {
    pid: number;
    name: string;
    path?: string;
    startedAt?: string;
}

export interface ClassifiedMinecraftProcess extends MinecraftProcess {
    kind: BuildKind;
}

const PROCESS_IMAGE_NAME = 'Minecraft.Windows.exe';

function queryProcessesViaCim(): Promise<MinecraftProcess[] | undefined> {
    const script =
        `Get-CimInstance Win32_Process -Filter "Name='${PROCESS_IMAGE_NAME}'" -ErrorAction Stop | ` +
        'Select-Object ProcessId, Name, ExecutablePath, ' +
        "@{n='StartedAt';e={[string]$_.CreationDate.Ticks}} | ConvertTo-Json -Compress";
    return runPowerShell(script).then(rows => rows && toProcesses(rows, {
        pid: 'ProcessId',
        name: 'Name',
        path: 'ExecutablePath',
        startedAt: 'StartedAt'
    }));
}

function queryProcessesViaGetProcess(): Promise<MinecraftProcess[] | undefined> {
    const name = PROCESS_IMAGE_NAME.replace(/\.exe$/i, '');
    const script =
        `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | ` +
        'Select-Object Id, ProcessName | ConvertTo-Json -Compress';
    return runPowerShell(script).then(rows => rows && toProcesses(rows, {
        pid: 'Id',
        name: 'ProcessName'
    }));
}

function toProcesses(
    rows: Array<Record<string, unknown>>,
    fields: { pid: string; name: string; path?: string; startedAt?: string }
): MinecraftProcess[] {
    const text = (field: string | undefined, row: Record<string, unknown>): string | undefined => {
        if (field === undefined) {
            return undefined;
        }
        const value = row[field];
        return typeof value === 'string' && value ? value : undefined;
    };

    const processes: MinecraftProcess[] = [];
    for (const row of rows) {
        const pid = row[fields.pid];
        const name = row[fields.name];
        if (typeof pid !== 'number' || !Number.isInteger(pid) || typeof name !== 'string') {
            continue;
        }
        processes.push({
            pid,
            name,
            path: text(fields.path, row),
            startedAt: text(fields.startedAt, row)
        });
    }
    return processes;
}

function runPowerShell(script: string): Promise<Array<Record<string, unknown>> | undefined> {
    return new Promise((resolve) => {
        cp.execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true },
            (error, stdout) => {
                if (error) {
                    resolve(undefined);
                    return;
                }
                const output = stdout.trim();
                if (!output) {
                    resolve([]);
                    return;
                }
                try {
                    const parsed = JSON.parse(output);
                    resolve(Array.isArray(parsed) ? parsed : [parsed]);
                } catch {
                    resolve(undefined);
                }
            }
        );
    });
}

const PROCESS_LIST_TTL_MS = 1000;

let lastQuery: { at: number; processes: MinecraftProcess[] } | undefined;

export async function findMinecraftProcesses(): Promise<MinecraftProcess[]> {
    if (lastQuery && Date.now() - lastQuery.at < PROCESS_LIST_TTL_MS) {
        return lastQuery.processes;
    }
    const processes = (await queryProcessesViaCim())
        ?? (await queryProcessesViaGetProcess())
        ?? [];
    lastQuery = { at: Date.now(), processes };
    return processes;
}

export async function isMinecraftRunning(): Promise<boolean> {
    const processes = await findMinecraftProcesses();
    return processes.length > 0;
}

const MAX_TRACKED_PROCESSES = 32;

export class ProcessKindCache {
    private readonly entries = new Map<number, { startedAt: string; kind: BuildKind }>();

    get(process: MinecraftProcess): BuildKind | undefined {
        if (!process.startedAt) {
            return undefined;
        }
        const entry = this.entries.get(process.pid);
        return entry?.startedAt === process.startedAt ? entry.kind : undefined;
    }

    set(process: MinecraftProcess, kind: BuildKind): void {
        if (!process.startedAt) {
            return;
        }
        if (!this.entries.has(process.pid) && this.entries.size >= MAX_TRACKED_PROCESSES) {
            const oldest = this.entries.keys().next();
            if (!oldest.done) {
                this.entries.delete(oldest.value);
            }
        }
        this.entries.set(process.pid, { startedAt: process.startedAt, kind });
    }

    retainOnly(processes: readonly MinecraftProcess[]): void {
        const alive = new Set(processes.map(process => process.pid));
        for (const pid of [...this.entries.keys()]) {
            if (!alive.has(pid)) {
                this.entries.delete(pid);
            }
        }
    }

    get size(): number {
        return this.entries.size;
    }

    clear(): void {
        this.entries.clear();
    }
}

const processKindCache = new ProcessKindCache();

export function clearProcessDetectionCache(): void {
    lastQuery = undefined;
    processKindCache.clear();
}

export async function findClassifiedMinecraftProcesses(): Promise<ClassifiedMinecraftProcess[]> {
    const processes = await findMinecraftProcesses();
    processKindCache.retainOnly(processes);

    return Promise.all(processes.map(async (process): Promise<ClassifiedMinecraftProcess> => {
        const cached = processKindCache.get(process);
        if (cached) {
            return { ...process, kind: cached };
        }
        if (!process.path) {
            return { ...process, kind: 'unknown' };
        }
        const identity = await identifyBuild(process.path);
        if (identity.kind !== 'unknown') {
            processKindCache.set(process, identity.kind);
        }
        return { ...process, kind: identity.kind };
    }));
}

export async function isModpcRunning(): Promise<boolean> {
    const processes = await findClassifiedMinecraftProcesses();
    return processes.some(process => process.kind === 'modpc' || process.kind === 'unknown');
}
