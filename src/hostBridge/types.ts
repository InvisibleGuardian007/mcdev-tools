export type HostBridgeLifecycleState =
    | 'process_started'
    | 'game_ready'
    | 'game_unavailable'
    | 'exiting'
    | 'exited';

export type HostBridgeVisibleState = HostBridgeLifecycleState | 'starting';

export interface HostBridgeRegistration {
    id: string;
    token: string;
    workspacePath: string;
    createdAt: number;
    lastSeenAt: number;
    sessionId?: string;
    mcdkPid?: number;
    minecraftPid?: number;
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
    state: HostBridgeVisibleState;
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

/** 本机正在跑的游戏 / mcdk 进程扫描结果，用来判断「有游戏但没连上宿主」。 */
export interface HostBridgeProcessProbe {
    minecraftPids: number[];
    mcdkPids: number[];
    /** 在跑但没有任何会话绑定的游戏 pid */
    unboundMinecraftPids: number[];
    checkedAt: number;
}

export interface HostBridgeSnapshot {
    status: 'idle' | 'listening' | 'error';
    port?: number;
    error?: string;
    sessions: HostBridgeSessionSummary[];
    /** 最近一次进程探测结果；还没探测过时缺省。 */
    gameProcesses?: HostBridgeProcessProbe;
}

export interface PreparedHostBridgeLaunch {
    registrationId: string;
    environment: {
        MCDEV_HOST_PORT: string;
        MCDEV_HOST_TOKEN: string;
    };
}

export interface HostBridgeHostInfo {
    name: string;
    version: string;
    instanceId: string;
}

export interface DisposableLike {
    dispose(): void;
}

