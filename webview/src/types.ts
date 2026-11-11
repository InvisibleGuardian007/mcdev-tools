export interface ModDir {
  path: string;
  hot_reload: boolean;
  enabled: boolean;
}

/** minecraftWorlds 目录下的一个存档 */
export interface WorldInfo {
  /** 存档文件夹名，对应 .mcdev.json 的 world_folder_name */
  folder: string;
  /** levelname.txt 里的世界名 */
  name: string;
  /** 存档引用的行为包数量 */
  packs: number;
  /** 这个存档引用的 MOD 中，本地能找到对应目录的数量 */
  matchedMods: number;
}

export interface McdevData {
  game_executable_path?: string;
  log_protocol?: 0 | 1;
  world_name?: string;
  world_folder_name?: string;
  /** 启动时按选中存档自动装配 MOD 目录（默认开启） */
  world_auto_mods?: boolean;
  world_seed?: number | null;
  world_type?: number;
  game_mode?: number;
  reset_world?: boolean;
  auto_join_game?: boolean;
  include_debug_mod?: boolean;
  enable_cheats?: boolean;
  keep_inventory?: boolean;
  auto_hot_reload_mods?: boolean;
  auto_hot_reload_ui?: boolean;
  auto_hot_reload_shaders?: boolean;
  auto_hot_reload_materials?: boolean;
  auto_hot_reload_particles?: boolean;
  do_daylight_cycle?: boolean;
  do_weather_cycle?: boolean;
  user_name?: string;
  skin_info?: {
    slim: boolean;
    skin: string;
  };
  included_mod_dirs?: (string | ModDir)[];
  window_style?: {
    always_on_top?: boolean;
    hide_title_bar?: boolean;
    hide_taskbar_icon?: boolean;
    title_bar_color?: number[] | null;
    fixed_size?: number[] | null;
    fixed_position?: number[] | null;
    lock_corner?: number | null;
    opacity?: number | null;
  };
  debug_options?: {
    reload_key?: string;
    reload_world_key?: string;
    reload_addon_key?: string;
    reload_shaders_key?: string;
    reload_key_global?: boolean;
  };
  mcp_server_config?: {
    enabled?: boolean;
    server_ip?: string;
    server_port?: number;
  };
  mcdev_tools?: {
    game_debugger?: {
      enabled?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  experiment_options?: {
    data_driven_biomes?: boolean;
    upcoming_creator_features?: boolean;
    experimental_creator_cameras?: boolean;
    gametest?: boolean;
    deferred_technical_preview?: boolean;
  };
}

export interface HostBridgeMethodDescriptor {
  name: string;
  modes: string[];
  gameAvailability: string;
}

export interface HostBridgeSessionSummary {
  id: string;
  registrationId: string;
  connected: boolean;
  state: 'starting' | 'process_started' | 'game_ready' | 'game_unavailable' | 'exiting' | 'exited';
  stateSequence: number;
  connectionGeneration: number;
  startedAt?: string;
  mcdkPid?: number;
  minecraftPid?: number;
  projectRoot: string;
  worldName?: string;
  worldFolderName?: string;
  gameIpcConnected: boolean;
  debugCapabilityEnabled: boolean;
  methods?: HostBridgeMethodDescriptor[];
}

export interface HostBridgeSnapshot {
  status: 'idle' | 'listening' | 'error';
  port?: number;
  error?: string;
  sessions: HostBridgeSessionSummary[];
}

export type PythonProfilerTarget = 'client' | 'server' | 'all';
export type PythonProfilerClock = 'CPU' | 'WALL';

export interface PythonProfilerFunction {
  id: number;
  target: Exclude<PythonProfilerTarget, 'all'>;
  module: string;
  line: number;
  name: string;
  calls: number;
  actualCalls: number;
  selfTime: number;
  totalTime: number;
  contextId: number;
  contextName: string;
  /** true = 当前 mod 的脚本；false = 引擎 / 原版函数（默认折叠） */
  isProject?: boolean;
}

export interface PythonProfilerCall {
  callerId: number;
  calleeId: number;
  calls: number;
  selfTime: number;
  totalTime: number;
}

export interface PythonProfilerResult {
  clock: PythonProfilerClock;
  elapsedSeconds: number;
  totalFunctions: number;
  /** 采集到的引擎（原版）函数数量 */
  engineFunctions?: number;
  truncated: boolean;
  functions: PythonProfilerFunction[];
  calls: PythonProfilerCall[];
}

/** 采集历史里保存的最小函数记录 */
export interface PythonProfilerHistoryFunction {
  name: string;
  module: string;
  line: number;
  calls: number;
  selfTime: number;
  totalTime: number;
}

export interface PythonProfilerHistoryEntry {
  id: string;
  capturedAt: string;
  target: PythonProfilerTarget;
  clock: PythonProfilerClock;
  elapsedSeconds: number;
  totalCalls: number;
  functionCount: number;
  worldName?: string;
  /** 该次采集最热的 mod 函数，列表里用来一眼分辨 */
  top?: PythonProfilerHistoryFunction;
}

export interface PythonProfilerCompletedState {
  target: PythonProfilerTarget;
  clock: PythonProfilerClock;
  capturedAt: string;
  result: PythonProfilerResult;
  report?: {
    markdownPath: string;
    svgPath: string;
  };
  reportError?: string;
  /** 采集历史 id（A/B 对比用） */
  historyId?: string;
  /** 历史落盘失败的原因 */
  historyError?: string;
}

export interface PythonProfilerTargetState {
  target: PythonProfilerTarget;
  status: 'idle' | 'running' | 'collecting';
  clock: PythonProfilerClock;
  durationSeconds?: number;
  startedAt?: string;
  completed?: PythonProfilerCompletedState;
}

export interface PythonMemoryFrame {
  file: string;
  line: number;
}

export interface PythonMemoryAllocation {
  id: number;
  sizeDiff: number;
  countDiff: number;
  currentSize: number;
  currentCount: number;
  traceback: PythonMemoryFrame[];
}

export interface PythonMemoryResult {
  elapsedSeconds: number;
  tracebackDepth: number;
  netSizeDiff: number;
  netCountDiff: number;
  currentSize: number;
  currentCount: number;
  totalAllocations: number;
  truncated: boolean;
  allocations: PythonMemoryAllocation[];
}

export interface PythonMemoryCompletedState {
  capturedAt: string;
  result: PythonMemoryResult;
  report?: {
    markdownPath: string;
    svgPath: string;
  };
  reportError?: string;
}

export interface PythonMemoryState {
  status: 'idle' | 'running' | 'collecting';
  tracebackDepth: number;
  startedAt?: string;
  completed?: PythonMemoryCompletedState;
}

export interface NativeProfilerEndpoint {
  pid: number;
  port: number;
}

export interface NativeProfilerZoneMetrics {
  id: number;
  name: string;
  sourceFile: string;
  sourceLine: number;
  calls: number;
  totalNanoseconds: number;
  selfNanoseconds: number;
  meanNanoseconds: number;
  maximumNanoseconds: number;
}

export interface NativeProfilerZone extends NativeProfilerZoneMetrics {
  threadId: string;
  threadName: string;
}

export interface NativeProfilerCallNode extends NativeProfilerZoneMetrics {
  children: NativeProfilerCallNode[];
}

export interface NativeProfilerThread {
  id: string;
  name: string;
  calls: number;
  totalNanoseconds: number;
  roots: NativeProfilerCallNode[];
}

export interface NativeProfilerResult {
  capturedSeconds: number;
  totalZones: number;
  truncated: boolean;
  callTreeTruncated: boolean;
  zones: NativeProfilerZone[];
  threads: NativeProfilerThread[];
}

export interface NativeProfilerCompletedState {
  pid: number;
  port: number;
  capturedAt: string;
  result: NativeProfilerResult;
  report?: {
    tracePath: string;
    markdownPath: string;
    svgPath: string;
  };
  reportError?: string;
}

export interface NativeProfilerState {
  endpoint?: NativeProfilerEndpoint;
  status: 'idle' | 'capturing' | 'analyzing';
  maximumSeconds?: number;
  startedAt?: string;
  completed?: NativeProfilerCompletedState;
}

export type DebugFunctionTarget = 'client' | 'server';
export type DebugFunctionParameterKind = 'value' | 'varargs' | 'kwargs';
export type DebugFunctionArgumentMode = 'fixed' | 'optional' | 'required';

export interface DebugFunctionParameter {
  name: string;
  kind: DebugFunctionParameterKind;
  required: boolean;
  defaultValue?: string;
}

export interface DebugFunctionArgumentConfig {
  mode: DebugFunctionArgumentMode;
  value: string;
}

export interface DiscoveredDebugFunction {
  key: string;
  modulePath: string;
  functionName: string;
  relativeFilePath: string;
  line: number;
  parameters: DebugFunctionParameter[];
}

export interface SavedDebugFunction extends DiscoveredDebugFunction {
  id: string;
  label: string;
  target: DebugFunctionTarget;
  argumentConfigs: Record<string, DebugFunctionArgumentConfig>;
}

export interface PerfMonitorSample {
  time: number;
  fps?: number;
  cpuPercent: number;
  workingSetBytes: number;
  pagefileBytes: number;
}

export interface PerfMonitorFpsStats {
  current: number;
  average: number;
  min: number;
  max: number;
  low1: number;
}

export interface PerfMonitorStats {
  sampleCount: number;
  windowSeconds: number;
  fps?: PerfMonitorFpsStats;
  cpu: { current: number; average: number; peak: number };
  memory: { current: number; average: number; peak: number; growth: number };
}

export interface PerfMonitorState {
  status: 'idle' | 'running';
  intervalMs: number;
  startedAt?: string;
  pid?: number;
  pidSource?: 'session' | 'discovered';
  fpsAvailable: boolean;
  fpsSource?: string;
  fpsError?: string;
  lastError?: string;
  sampleCount: number;
  stats: PerfMonitorStats;
  samples: PerfMonitorSample[];
  lastUpdated?: string;
}
