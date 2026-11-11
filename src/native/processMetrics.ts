import * as path from 'path';
import { dynamicLibraryManager } from './dynamicLibraryManager';

/**
 * Thin wrapper around the Win32 process counters we need for the performance monitor.
 *
 * Everything here is read-only observation of an already running process:
 *   OpenProcess -> GetProcessTimes / GetProcessMemoryInfo -> CloseHandle
 * The CPU numbers are 100ns tick counts, so a sample costs two syscalls and no
 * additional threads inside the game process.
 */

export interface ProcessMetricsReading {
    /** Kernel + user time consumed by the process so far, in seconds. */
    cpuSeconds: number;
    /** Current working set (resident memory), in bytes. */
    workingSetBytes: number;
    /** Commit charge tracked by the paging file, in bytes. */
    pagefileBytes: number;
}

interface KoffiFunctionLike {
    (...args: unknown[]): unknown;
}

interface KoffiLibraryLike {
    func(definition: string): KoffiFunctionLike;
    unload(): void;
}

interface KoffiModuleLike {
    load(libraryPath: string): KoffiLibraryLike;
    struct(name: string, fields: Record<string, string>): unknown;
    sizeof(type: unknown): number;
    alloc(type: unknown, length: number): unknown;
    decode(pointer: unknown, type: unknown, index?: number): unknown;
    free(pointer: unknown): void;
}

interface FiletimeValue {
    low: number;
    high: number;
}

interface MemoryCountersValue {
    cb: number;
    WorkingSetSize: number;
    PagefileUsage: number;
}

interface NativeBindings {
    koffi: KoffiModuleLike;
    kernel32: KoffiLibraryLike;
    psapi: KoffiLibraryLike;
    openProcess: KoffiFunctionLike;
    closeHandle: KoffiFunctionLike;
    getProcessTimes: KoffiFunctionLike;
    getProcessMemoryInfo: KoffiFunctionLike;
    filetime: unknown;
    memoryCounters: unknown;
    memoryCountersSize: number;
}

/** PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ */
const PROCESS_ACCESS = 0x0400 | 0x1000 | 0x0010;
const FILETIME_PER_SECOND = 10_000_000;

function createBindings(koffi: KoffiModuleLike): NativeBindings {
    const kernel32 = koffi.load('kernel32.dll');
    const psapi = koffi.load('psapi.dll');
    const filetime = koffi.struct('McdevFiletime', { low: 'uint32', high: 'uint32' });
    const memoryCounters = koffi.struct('McdevProcessMemoryCounters', {
        cb: 'uint32',
        PageFaultCount: 'uint32',
        PeakWorkingSetSize: 'uint64',
        WorkingSetSize: 'uint64',
        QuotaPeakPagedPoolUsage: 'uint64',
        QuotaPagedPoolUsage: 'uint64',
        QuotaPeakNonPagedPoolUsage: 'uint64',
        QuotaNonPagedPoolUsage: 'uint64',
        PagefileUsage: 'uint64',
        PeakPagefileUsage: 'uint64'
    });

    return {
        koffi,
        kernel32,
        psapi,
        openProcess: kernel32.func('void *OpenProcess(uint32, bool, uint32)'),
        closeHandle: kernel32.func('bool CloseHandle(void *)'),
        // The out parameters must be declared as such, otherwise koffi marshals a
        // copy and the tick counts silently come back as zero.
        getProcessTimes: kernel32.func(
            'bool GetProcessTimes(void *, _Out_ McdevFiletime *, _Out_ McdevFiletime *, _Out_ McdevFiletime *, _Out_ McdevFiletime *)'
        ),
        getProcessMemoryInfo: psapi.func(
            'bool GetProcessMemoryInfo(void *, _Inout_ McdevProcessMemoryCounters *, uint32)'
        ),
        filetime,
        memoryCounters,
        memoryCountersSize: koffi.sizeof(memoryCounters)
    };
}

function filetimeToTicks(value: FiletimeValue | undefined): number {
    if (!value) {
        return 0;
    }
    return Number(value.high) * 4294967296 + Number(value.low);
}

export function resolveNativeBinDirectory(extensionRoot: string): string {
    return path.join(extensionRoot, 'bin', 'native', 'windows', 'x64');
}

export class ProcessMetricsSampler {
    private constructor(private readonly bindings: NativeBindings) {}

    public static async create(koffiDirectory: string): Promise<ProcessMetricsSampler> {
        const bindings = await dynamicLibraryManager.withKoffi(koffiDirectory, koffi =>
            createBindings(koffi as unknown as KoffiModuleLike)
        );
        return new ProcessMetricsSampler(bindings);
    }

    /**
     * Reads the counters of one process. Returns undefined when the process is
     * gone or is not readable (for example a protected process).
     */
    public read(pid: number): ProcessMetricsReading | undefined {
        if (!Number.isInteger(pid) || pid <= 0) {
            return undefined;
        }
        const bindings = this.bindings;
        const handle = bindings.openProcess(PROCESS_ACCESS, false, pid);
        if (!handle) {
            return undefined;
        }
        try {
            const created = bindings.koffi.alloc(bindings.filetime, 1);
            const exited = bindings.koffi.alloc(bindings.filetime, 1);
            const kernel = bindings.koffi.alloc(bindings.filetime, 1);
            const user = bindings.koffi.alloc(bindings.filetime, 1);
            try {
                const timesOk = bindings.getProcessTimes(handle, created, exited, kernel, user);
                if (!timesOk) {
                    return undefined;
                }
                const ticks =
                    filetimeToTicks(bindings.koffi.decode(kernel, bindings.filetime) as FiletimeValue) +
                    filetimeToTicks(bindings.koffi.decode(user, bindings.filetime) as FiletimeValue);

                const counters: MemoryCountersValue = {
                    cb: bindings.memoryCountersSize,
                    WorkingSetSize: 0,
                    PagefileUsage: 0
                };
                const memoryOk = bindings.getProcessMemoryInfo(
                    handle,
                    counters,
                    bindings.memoryCountersSize
                );

                return {
                    cpuSeconds: ticks / FILETIME_PER_SECOND,
                    workingSetBytes: memoryOk ? Number(counters.WorkingSetSize) || 0 : 0,
                    pagefileBytes: memoryOk ? Number(counters.PagefileUsage) || 0 : 0
                };
            } finally {
                for (const pointer of [created, exited, kernel, user]) {
                    try {
                        bindings.koffi.free(pointer);
                    } catch {
                        // Releasing a buffer twice is not worth failing a sample over.
                    }
                }
            }
        } finally {
            bindings.closeHandle(handle);
        }
    }

    public dispose(): void {
        for (const library of [this.bindings.psapi, this.bindings.kernel32]) {
            try {
                library.unload();
            } catch {
                // The extension host keeps running whether or not the refcount drops here.
            }
        }
    }
}
