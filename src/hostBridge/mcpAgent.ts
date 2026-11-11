import * as http from 'http';
import * as https from 'https';

/**
 * mcdk（MC Dev Tools 的游戏宿主进程）本身就是一个 MCP 服务器：
 * 开启 .mcdev.json 里的 mcp_server_config 后，它会在 http://<ip>:<port>/mcp
 * 提供 Streamable HTTP 传输，在 /sse 提供 SSE 传输。
 *
 * 这里只做「让外部 Agent 接得上」这件小事：拼地址、探活、列工具、生成配置片段。
 * 不依赖 vscode，方便单测。
 */

export interface McpEndpointOptions {
    host?: string;
    port?: number;
}

export interface McpToolInfo {
    name: string;
    description?: string;
}

export interface McpProbeResult {
    ok: boolean;
    url: string;
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
    tools: McpToolInfo[];
    error?: string;
}

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 19133;
const PROTOCOL_VERSION = '2025-06-18';

function normalizeHost(host: string | undefined): string {
    const value = (host || '').trim();
    return value || DEFAULT_HOST;
}

function normalizePort(port: number | undefined): number {
    const value = Number(port);
    if (!Number.isFinite(value) || value < 1 || value > 65535) {
        return DEFAULT_PORT;
    }
    return Math.trunc(value);
}

/** Streamable HTTP 端点：http://host:port/mcp */
export function buildMcpUrl(options: McpEndpointOptions = {}): string {
    return `http://${normalizeHost(options.host)}:${normalizePort(options.port)}/mcp`;
}

/** SSE 端点：http://host:port/sse */
export function buildSseUrl(options: McpEndpointOptions = {}): string {
    return `http://${normalizeHost(options.host)}:${normalizePort(options.port)}/sse`;
}

/**
 * MCP 的响应可能是纯 JSON，也可能是 SSE（text/event-stream，data: 行里放 JSON）。
 * 取最后一个能解析出来的 JSON-RPC 消息。
 */
export function parseMcpBody(body: string, contentType?: string): any {
    const text = (body || '').trim();
    if (!text) {
        return undefined;
    }
    const isSse = /text\/event-stream/i.test(contentType || '') || /^\s*(event|data|id|retry):/m.test(text);
    if (!isSse) {
        return JSON.parse(text);
    }
    let last: any;
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*data:\s?(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        const payload = match[1].trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }
        try {
            last = JSON.parse(payload);
        } catch {
            // 忽略解析不了的行
        }
    }
    return last;
}

interface RpcPostResult {
    status: number;
    sessionId?: string;
    json: any;
}

function postJsonRpc(url: string, payload: unknown, sessionId: string | undefined, timeoutMs: number): Promise<RpcPostResult> {
    return new Promise<RpcPostResult>((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        const body = JSON.stringify(payload);
        const transport = target.protocol === 'https:' ? https : http;
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(Buffer.byteLength(body)),
        };
        if (sessionId) {
            headers['mcp-session-id'] = sessionId;
        }
        const request = transport.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: 'POST',
                headers,
            },
            response => {
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                response.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const sessionHeader = response.headers['mcp-session-id'];
                    const result: RpcPostResult = {
                        status: response.statusCode || 0,
                        sessionId: Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader,
                        json: undefined,
                    };
                    try {
                        result.json = parseMcpBody(raw, String(response.headers['content-type'] || ''));
                    } catch {
                        result.json = undefined;
                    }
                    resolve(result);
                });
                response.on('error', reject);
            }
        );
        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`Timed out after ${timeoutMs} ms`));
        });
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

function readResult(json: any): any {
    if (!json || typeof json !== 'object') {
        return undefined;
    }
    const error = (json as { error?: { message?: string; code?: number } }).error;
    if (error) {
        const message = typeof error.message === 'string' && error.message ? error.message : `JSON-RPC error ${error.code ?? ''}`.trim();
        throw new Error(message);
    }
    return (json as { result?: any }).result;
}

/**
 * 探活：initialize → notifications/initialized → tools/list。
 * 任何一步失败都返回 ok:false 而不是抛错，界面直接把 error 显示出来。
 */
export async function probeMcpServer(url: string, timeoutMs = 5000): Promise<McpProbeResult> {
    const result: McpProbeResult = { ok: false, url, tools: [] };
    try {
        const init = await postJsonRpc(
            url,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'mcdev-tools', version: '1.0.0' },
                },
            },
            undefined,
            timeoutMs
        );
        let initResult: any;
        try {
            initResult = readResult(init.json);
        } catch (error) {
            throw new Error(`initialize failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!initResult) {
            throw new Error(`initialize failed: HTTP ${init.status || 'no response'}`);
        }
        result.protocolVersion = typeof initResult.protocolVersion === 'string' ? initResult.protocolVersion : undefined;
        if (initResult.serverInfo && typeof initResult.serverInfo === 'object') {
            result.serverInfo = {
                name: typeof initResult.serverInfo.name === 'string' ? initResult.serverInfo.name : undefined,
                version: typeof initResult.serverInfo.version === 'string' ? initResult.serverInfo.version : undefined,
            };
        }
        const sessionId = init.sessionId;
        try {
            await postJsonRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId, timeoutMs);
        } catch {
            // 通知失败不影响后续 tools/list
        }
        const list = await postJsonRpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId, timeoutMs);
        let listResult: any;
        try {
            listResult = readResult(list.json);
        } catch (error) {
            throw new Error(`tools/list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
        result.tools = tools
            .filter((tool: any) => tool && typeof tool.name === 'string')
            .map((tool: any) => ({
                name: tool.name as string,
                description: typeof tool.description === 'string' ? tool.description : undefined,
            }));
        result.ok = true;
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
}

/** Claude Code：claude mcp add --transport http <name> <url> */
export function buildClaudeCodeCommand(url: string, name = 'minecraft'): string {
    return `claude mcp add --transport http ${name} ${url}`;
}

/** VS Code / 通用 MCP 客户端的 mcp.json（写在工作区 .vscode/mcp.json） */
export function buildVsCodeMcpConfig(url: string, name = 'minecraft'): string {
    return `${JSON.stringify({ servers: { [name]: { type: 'http', url } } }, null, 2)}\n`;
}

/** DeepSeek Harness 的 cordis.patch.yml 片段 */
export function buildDshProfileSnippet(url: string, name = 'minecraft'): string {
    return [
        '- insert:',
        `    - id: magpie-mcp-${name}`,
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        `        serverName: "${name}"`,
        '        transport: "streamable-http"',
        `        url: "${url}"`,
        '',
    ].join('\n');
}

/**
 * 给 Agent 的自我说明：把端点 + 工具清单 + 用法要点压成一小段，
 * 粘贴到任意 Agent 会话里就能直接开工。
 */
export function buildAgentBrief(url: string, tools: McpToolInfo[], language: 'en' | 'zh' = 'zh'): string {
    const names = tools.map(tool => tool.name).filter(Boolean);
    const toolLine = names.length ? names.join(', ') : language === 'en' ? 'call tools/list to discover them' : '请先调用 tools/list 获取';
    if (language === 'en') {
        return [
            `You are connected to a running Minecraft Bedrock (NetEase) debug instance over MCP: ${url}`,
            `Available tools: ${toolLine}`,
            'How to work:',
            '1. Look before you act: capture_game_window for the screen, get_latest_error_logs / get_latest_logs for what the game just said.',
            '2. Drive input with the input tool (clicks, drags, wheel, text); coordinates are 0.0-1.0 percentages of the window.',
            '3. Run Python 2.7 code in the live instance with execute (pick client or server side via is_client).',
            '4. After changing JSON, textures or other resources, run reload_game with reload_addons=true, then verify again.',
            'Rules: one uncertain change at a time, verify each with a screenshot or log line, and never guess tool arguments without calling the tool schema.',
            '',
        ].join('\n');
    }
    return [
        `你已经通过 MCP 接入一个正在运行的《我的世界》网易版调试实例：${url}`,
        `可用工具：${toolLine}`,
        '用法要点：',
        '1. 先看再动：capture_game_window 看画面，get_latest_error_logs / get_latest_logs 看游戏刚说了什么。',
        '2. 用输入工具操作游戏（点击 / 长按 / 拖拽 / 滚轮 / 文本），坐标是窗口的 0.0-1.0 百分比。',
        '3. 用 execute 在这个实例里直接跑 Python 2.7 代码（is_client 选端），返回值即结果。',
        '4. 改完 JSON / 贴图等资源后调 reload_game（reload_addons=true），再截一张复验。',
        '规则：一次只改一件不确定的事，每步都用截图或日志复验；工具参数不确定时先读工具 schema，不要猜。',
        '',
    ].join('\n');
}
