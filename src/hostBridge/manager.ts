import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { McdevConfigStore } from '../config';
import { HostBridgeRpcError, HostBridgeServer } from './server';
import {
    DisposableLike,
    HostBridgeSnapshot,
    PreparedHostBridgeLaunch
} from './types';

const INSTANCE_ID_KEY = 'hostBridge.instanceId';
const PORT_KEY = 'hostBridge.port';
const CREDENTIALS_KEY_PREFIX = 'mcdev-tools.hostBridge.credentials';
const PRUNE_INTERVAL_MS = 10 * 60 * 1_000;
/** 死会话巡检间隔：游戏进程没了就把它从列表里摘掉，别让界面一直显示「存档不可用」。 */
const SESSION_SWEEP_INTERVAL_MS = 4_000;
/** 没有已连接会话时，隔这么久扫一次本机游戏进程，好在界面上提示「游戏在跑但没连上」。 */
const PROCESS_PROBE_INTERVAL_MS = 15_000;
/** 固定端口的起点；被占用时 server 会顺延 10 位，最后才退回随机端口。 */
export const DEFAULT_HOST_BRIDGE_PORT = 19190;

export class HostBridgeManager implements vscode.Disposable {
    private readonly server: HostBridgeServer;
    private readonly terminalRegistrations = new Map<vscode.Terminal, string>();
    private readonly terminalSubscription: vscode.Disposable;
    private readonly pruneTimer: NodeJS.Timeout;
    private readonly sweepTimer: NodeJS.Timeout;
    private disposePromise?: Promise<void>;
    private disposed = false;
    private lastProbeAt = 0;
    private probing?: Promise<void>;

    private tokenPromise?: Promise<string>;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly configStore: McdevConfigStore,
        private readonly instanceId: string
    ) {
        const packageJson = context.extension.packageJSON as { name?: string; version?: string };
        this.server = new HostBridgeServer({
            name: packageJson.name ?? 'mcdev-tools',
            version: packageJson.version ?? '0.0.0',
            instanceId
        });
        this.terminalSubscription = vscode.window.onDidCloseTerminal(terminal => {
            const registrationId = this.terminalRegistrations.get(terminal);
            if (!registrationId) {
                return;
            }
            this.terminalRegistrations.delete(terminal);
            this.server.releaseRegistration(registrationId);
        });

        this.pruneTimer = setInterval(() => this.server.pruneRegistrations(), PRUNE_INTERVAL_MS);
        this.pruneTimer.unref?.();
        this.sweepTimer = setInterval(() => this.sweepTick(), SESSION_SWEEP_INTERVAL_MS);
        this.sweepTimer.unref?.();
    }

    public static async create(
        context: vscode.ExtensionContext,
        configStore: McdevConfigStore
    ): Promise<HostBridgeManager> {
        let instanceId = context.workspaceState.get<string>(INSTANCE_ID_KEY);
        if (!instanceId) {
            instanceId = crypto.randomUUID();
            await context.workspaceState.update(INSTANCE_ID_KEY, instanceId);
        }
        // 端口与令牌都要跨窗口重载保留：否则重载扩展后旧游戏（还拿着老端口/老令牌）永远连不回来。
        return new HostBridgeManager(context, configStore, instanceId);
    }

    public onDidChange(listener: (snapshot: HostBridgeSnapshot) => void): DisposableLike {
        return this.server.onDidChange(listener);
    }

    public getSnapshot(): HostBridgeSnapshot {
        return this.server.getSnapshot();
    }

    public async prepareLaunch(workspacePath: string): Promise<PreparedHostBridgeLaunch | undefined> {
        this.assertNotDisposed();
        if (!await this.configStore.isGameDebuggerEnabled(workspacePath)) {
            return undefined;
        }
        if (!this.server.isListening) {
            await this.server.start(this.readPreferredPort());
        }
        const token = await this.resolveToken();
        const launch = this.server.registerLaunch(workspacePath, { token });
        await this.context.workspaceState.update(PORT_KEY, this.server.port);
        void this.probeGameProcesses();
        return launch;
    }

    /**
     * 只在宿主启动时把令牌登记好，不启动游戏。
     * 这样扩展窗口重载后，已经在跑的游戏还能凭同样的端口 + 令牌连回来。
     */
    public async warmRegistration(workspacePath: string): Promise<void> {
        this.assertNotDisposed();
        if (!await this.configStore.isGameDebuggerEnabled(workspacePath)) {
            return;
        }
        if (!this.server.isListening) {
            await this.server.start(this.readPreferredPort());
        }
        this.server.registerLaunch(workspacePath, { token: await this.resolveToken() });
        void this.probeGameProcesses();
    }

    /** 读配置里的固定端口；非法值退回默认值。 */
    private readPreferredPort(): number {
        const configured = vscode.workspace
            .getConfiguration('mcdev-tools')
            .get<number>('hostBridge.port', DEFAULT_HOST_BRIDGE_PORT);
        const port = Math.floor(Number(configured));
        if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            return DEFAULT_HOST_BRIDGE_PORT;
        }
        return port;
    }

    /** 令牌存进 secrets（按工作区实例 id 区分），重载窗口后复用同一个。 */
    private resolveToken(): Promise<string> {
        if (!this.tokenPromise) {
            this.tokenPromise = (async () => {
                const key = `${CREDENTIALS_KEY_PREFIX}.${this.instanceId}`;
                const existing = await this.context.secrets.get(key);
                if (existing && existing.length >= 32) {
                    return existing;
                }
                const created = crypto.randomBytes(32).toString('hex');
                await this.context.secrets.store(key, created);
                return created;
            })();
        }
        return this.tokenPromise;
    }

    public trackTerminal(registrationId: string, terminal: vscode.Terminal): void {
        this.assertNotDisposed();
        this.terminalRegistrations.set(terminal, registrationId);
    }

    public releaseLaunch(registrationId: string): void {
        this.server.releaseRegistration(registrationId);
    }

    public async executeCode(sessionId: string, code: string, isClient: boolean): Promise<unknown> {
        if (!code.trim()) {
            throw new HostBridgeRpcError(-32602, 'Code cannot be empty', { code: 'INVALID_PARAMS' });
        }
        if (Buffer.byteLength(code, 'utf8') > 1024 * 1024) {
            throw new HostBridgeRpcError(-32602, 'Code exceeds the 1 MiB editor limit', { code: 'INVALID_PARAMS' });
        }
        return this.server.request(sessionId, 'game/code/execute', { code, isClient }, 15_000);
    }

    /**
     * 让游戏在进程内重载当前存档（game/reload）。
     * addons=true 时走 mcdk 的「addon 数据 + 游戏」完整重载路径，用于资源包（JSON/PNG/音效）等自动热更覆盖不到的改动。
     * 返回体形如 { accepted: true }，游戏随后会自行退出存档并重新载入。
     */
    public async reloadGame(sessionId: string, options: { addons?: boolean } = {}): Promise<unknown> {
        this.assertNotDisposed();
        return this.server.request(sessionId, 'game/reload', { addons: options.addons === true }, 60_000);
    }

    /**
     * 界面上的「刷新」：先纠正死会话、再扫本机进程、最后向已连接的会话要一次最新快照。
     * 这样点了刷新就能得到明确结论（已连接 / 游戏在跑但没连上 / 没有游戏）。
     */
    public async refreshSessions(): Promise<void> {
        this.server.sweepDeadSessions();
        await this.probeGameProcesses();
        await this.server.refreshSessions();
        await this.probeGameProcesses();
    }

    /** 每 4 秒巡检一次：清死会话；顺带在没有会话时探测游戏进程。 */
    private sweepTick(): void {
        if (this.disposed) {
            return;
        }
        try {
            this.server.sweepDeadSessions();
        } catch (error) {
            console.error('Failed to sweep host bridge sessions', error);
        }
        const hasConnected = this.server.getSnapshot().sessions.some(session => session.connected);
        if (!hasConnected && Date.now() - this.lastProbeAt > PROCESS_PROBE_INTERVAL_MS) {
            void this.probeGameProcesses();
        }
    }

    /** 扫一次本机游戏 / mcdk 进程；并发调用合并成一次。 */
    private probeGameProcesses(): Promise<void> {
        if (this.probing) {
            return this.probing;
        }
        if (this.disposed) {
            return Promise.resolve();
        }
        this.lastProbeAt = Date.now();
        this.probing = this.server.refreshProcessProbe().then(
            () => undefined,
            error => console.error('Failed to probe game processes', error)
        ).finally(() => {
            this.probing = undefined;
        });
        return this.probing;
    }

    public dispose(): void {
        void this.disposeAsync();
    }

    public disposeAsync(): Promise<void> {
        if (!this.disposePromise) {
            this.disposePromise = this.performDispose();
        }
        return this.disposePromise;
    }

    private async performDispose(): Promise<void> {
        this.disposed = true;
        clearInterval(this.pruneTimer);
        clearInterval(this.sweepTimer);
        this.terminalSubscription.dispose();
        this.terminalRegistrations.clear();
        await this.server.dispose();
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new Error('Host Bridge manager has been disposed');
        }
    }
}
