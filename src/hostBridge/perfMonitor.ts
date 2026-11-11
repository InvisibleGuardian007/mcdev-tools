/**
 * Ring buffer + statistics for the performance monitor tab.
 *
 * The monitor keeps everything the panel needs to draw a short history and to
 * summarise a session, so a run can be inspected after it finished without the
 * game still being alive.
 */

export interface PerfMonitorSample {
    /** Epoch milliseconds. */
    time: number;
    /** Frames per second reported by the game, when the counter is available. */
    fps?: number;
    /** CPU time of the game process relative to a single core (100 = one full core). */
    cpuPercent: number;
    /** Resident memory of the game process, in bytes. */
    workingSetBytes: number;
    /** Commit charge of the game process, in bytes. */
    pagefileBytes: number;
}

export interface PerfMonitorFpsStats {
    current: number;
    average: number;
    min: number;
    max: number;
    /** Average of the slowest 1% of samples. */
    low1: number;
}

export interface PerfMonitorStats {
    sampleCount: number;
    windowSeconds: number;
    fps?: PerfMonitorFpsStats;
    cpu: { current: number; average: number; peak: number };
    memory: { current: number; average: number; peak: number; growth: number };
}

export const DEFAULT_PERF_MONITOR_CAPACITY = 7200;

export function emptyPerfMonitorStats(): PerfMonitorStats {
    return {
        sampleCount: 0,
        windowSeconds: 0,
        cpu: { current: 0, average: 0, peak: 0 },
        memory: { current: 0, average: 0, peak: 0, growth: 0 }
    };
}

function round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
    if (values.length === 0) {
        return 0;
    }
    let total = 0;
    for (const value of values) {
        total += value;
    }
    return total / values.length;
}

export class PerfMonitorSeries {
    private buffer: PerfMonitorSample[] = [];

    constructor(private readonly capacity = DEFAULT_PERF_MONITOR_CAPACITY) {}

    public push(sample: PerfMonitorSample): void {
        this.buffer.push(sample);
        if (this.buffer.length > this.capacity) {
            this.buffer.splice(0, this.buffer.length - this.capacity);
        }
    }

    public samples(): PerfMonitorSample[] {
        return this.buffer;
    }

    public get size(): number {
        return this.buffer.length;
    }

    public reset(): void {
        this.buffer = [];
    }

    public stats(): PerfMonitorStats {
        if (this.buffer.length === 0) {
            return emptyPerfMonitorStats();
        }
        const cpuValues = this.buffer.map(sample => sample.cpuPercent);
        const memoryValues = this.buffer.map(sample => sample.workingSetBytes);
        const fpsValues = this.buffer
            .map(sample => sample.fps)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

        const stats: PerfMonitorStats = {
            sampleCount: this.buffer.length,
            windowSeconds: round(
                Math.max(0, this.buffer[this.buffer.length - 1].time - this.buffer[0].time) / 1000,
                1
            ),
            cpu: {
                current: round(cpuValues[cpuValues.length - 1]),
                average: round(average(cpuValues)),
                peak: round(Math.max(...cpuValues))
            },
            memory: {
                current: memoryValues[memoryValues.length - 1],
                average: Math.round(average(memoryValues)),
                peak: Math.max(...memoryValues),
                growth: memoryValues[memoryValues.length - 1] - memoryValues[0]
            }
        };

        if (fpsValues.length > 0) {
            const sorted = [...fpsValues].sort((left, right) => left - right);
            const lowCount = Math.max(1, Math.ceil(sorted.length * 0.01));
            const lowSlice = sorted.slice(0, lowCount);
            stats.fps = {
                current: round(fpsValues[fpsValues.length - 1], 1),
                average: round(average(fpsValues), 1),
                min: round(sorted[0], 1),
                max: round(sorted[sorted.length - 1], 1),
                low1: round(average(lowSlice), 1)
            };
        }

        return stats;
    }

    public toCsv(): string {
        const lines = ['time,isoTime,fps,cpuPercent,workingSetBytes,pagefileBytes'];
        for (const sample of this.buffer) {
            lines.push([
                sample.time,
                new Date(sample.time).toISOString(),
                typeof sample.fps === 'number' ? round(sample.fps, 1) : '',
                round(sample.cpuPercent),
                sample.workingSetBytes,
                sample.pagefileBytes
            ].join(','));
        }
        return lines.join('\n');
    }
}
