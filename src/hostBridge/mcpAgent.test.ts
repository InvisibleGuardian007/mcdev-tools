import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
    buildAgentBrief,
    describeError,
    buildClaudeCodeCommand,
    buildDshProfileSnippet,
    buildMcpUrl,
    buildSseUrl,
    buildVsCodeMcpConfig,
    parseMcpBody,
    probeMcpServer,
} from './mcpAgent';

test('buildMcpUrl / buildSseUrl defaults and normalization', () => {
    assert.equal(buildMcpUrl(), 'http://localhost:19133/mcp');
    assert.equal(buildSseUrl({ host: '127.0.0.1', port: 20000 }), 'http://127.0.0.1:20000/sse');
    assert.equal(buildMcpUrl({ host: '   ', port: 0 }), 'http://localhost:19133/mcp');
    assert.equal(buildMcpUrl({ host: 'localhost', port: 99999 }), 'http://localhost:19133/mcp');
    assert.equal(buildMcpUrl({ host: 'localhost', port: 8080.9 }), 'http://localhost:8080/mcp');
});

test('parseMcpBody handles json, sse and empty payloads', () => {
    assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 'application/json'), {
        jsonrpc: '2.0',
        id: 1,
        result: { ok: true },
    });
    const sse = [
        'event: message',
        'data: {"jsonrpc":"2.0","id":1,"result":{"sniff":1}}',
        '',
        'event: message',
        'data: {"jsonrpc":"2.0","id":1,"result":{"sniff":2}}',
        '',
    ].join('\n');
    assert.deepEqual(parseMcpBody(sse, 'text/event-stream'), { jsonrpc: '2.0', id: 1, result: { sniff: 2 } });
    // 没有 content-type 也能认出 SSE
    assert.deepEqual(parseMcpBody('data: {"a":1}', undefined), { a: 1 });
    assert.equal(parseMcpBody('', 'application/json'), undefined);
    assert.equal(parseMcpBody('   ', 'text/event-stream'), undefined);
    assert.equal(parseMcpBody('event: ping', 'text/event-stream'), undefined);
});

test('probeMcpServer performs initialize / tools/list against a fake MCP server', async () => {
    const seen: { method: string; session?: string }[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            seen.push({ method: payload.method, session: req.headers['mcp-session-id'] as string | undefined });
            if (payload.method === 'initialize') {
                res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: payload.id,
                        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mcdk', version: '1.2.3' }, capabilities: {} },
                    })
                );
                return;
            }
            if (payload.method === 'notifications/initialized') {
                res.writeHead(202).end();
                return;
            }
            if (payload.method === 'tools/list') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: payload.id,
                        result: { tools: [{ name: 'capture_game_window' }, { name: 'execute', description: 'run code' }] },
                    })
                );
                return;
            }
            res.writeHead(404).end();
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
        const result = await probeMcpServer(`http://127.0.0.1:${port}/mcp`, 2000);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.protocolVersion, '2025-06-18');
        assert.equal(result.serverInfo?.name, 'mcdk');
        assert.deepEqual(
            result.tools.map(tool => tool.name),
            ['capture_game_window', 'execute']
        );
        assert.equal(result.tools[1].description, 'run code');
        assert.deepEqual(
            seen.map(item => item.method),
            ['initialize', 'notifications/initialized', 'tools/list']
        );
        assert.equal(seen[2].session, 'session-1');
    } finally {
        server.close();
    }
});

test('probeMcpServer reports a connection failure instead of throwing', async () => {
    const server = http.createServer((_req, res) => res.writeHead(500).end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
        const result = await probeMcpServer(`http://127.0.0.1:${port}/mcp`, 2000);
        assert.equal(result.ok, false);
        assert.match(String(result.error), /initialize failed: HTTP 500/);
        assert.deepEqual(result.tools, []);
    } finally {
        server.close();
    }
});

test('describeError falls back to the errno code when message is empty', () => {
    // Node 在 localhost 同时解析 ::1 / 127.0.0.1 时会抛 AggregateError，message 是空串
    const aggregate = Object.assign(new Error(''), { code: 'ECONNREFUSED', errors: [] });
    assert.equal(describeError(aggregate), 'ECONNREFUSED');
    const withNested = Object.assign(new Error(''), {
        code: 'ECONNREFUSED',
        errors: [new Error('connect ECONNREFUSED 127.0.0.1:19133')],
    });
    assert.equal(describeError(withNested), 'connect ECONNREFUSED 127.0.0.1:19133');
    assert.equal(describeError(new Error('Timed out after 4000 ms')), 'Timed out after 4000 ms');
    assert.equal(describeError(undefined), 'unknown error');
});

test('probeMcpServer reports the errno code for a closed port', async () => {
    const server = http.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const result = await probeMcpServer(`http://127.0.0.1:${port}/mcp`, 1500);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ECONNREFUSED');
    assert.ok((result.error || '').length > 0, 'error text must not be empty');
});

test('config snippets point at the same endpoint', () => {
    const url = buildMcpUrl({ host: '127.0.0.1', port: 19133 });
    assert.equal(buildClaudeCodeCommand(url), 'claude mcp add --transport http minecraft http://127.0.0.1:19133/mcp');
    const parsed = JSON.parse(buildVsCodeMcpConfig(url));
    assert.deepEqual(parsed, { servers: { minecraft: { type: 'http', url } } });
    const snippet = buildDshProfileSnippet(url, 'mcdk');
    assert.match(snippet, /- id: magpie-mcp-mcdk/);
    assert.match(snippet, /transport: "streamable-http"/);
    assert.ok(snippet.includes(`url: "${url}"`));
});

test('buildAgentBrief mentions the endpoint and the tool names', () => {
    const url = 'http://localhost:19133/mcp';
    const tools = [{ name: 'execute' }, { name: 'capture_game_window' }];
    const zh = buildAgentBrief(url, tools, 'zh');
    assert.ok(zh.includes(url));
    assert.ok(zh.includes('execute, capture_game_window'));
    assert.ok(zh.includes('reload_game'));
    const en = buildAgentBrief(url, [], 'en');
    assert.ok(en.includes('tools/list'));
});
