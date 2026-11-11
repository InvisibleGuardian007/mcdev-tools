import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import { HostBridgeServer } from './server';

const HOST_INFO = { name: 'mcdev-tools', version: '0.0.0', instanceId: 'test-instance' };
const STABLE_TOKEN = 'a'.repeat(64);

function occupyPort(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const blocker = net.createServer();
        blocker.once('error', reject);
        blocker.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(blocker));
    });
}

async function freePort(): Promise<number> {
    const server = await occupyPort(0);
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}

test('registerLaunch 复用同一个稳定令牌，不再每次换新', async () => {
    const server = new HostBridgeServer(HOST_INFO);
    try {
        await server.start(0);
        const first = server.registerLaunch('D:/workspace/one', { token: STABLE_TOKEN });
        const second = server.registerLaunch('D:/workspace/one', { token: STABLE_TOKEN });
        assert.equal(first.environment.MCDEV_HOST_TOKEN, STABLE_TOKEN);
        assert.equal(second.environment.MCDEV_HOST_TOKEN, STABLE_TOKEN);
        assert.equal(second.registrationId, first.registrationId, '同一工作区同一令牌复用登记');
        assert.equal(first.environment.MCDEV_HOST_PORT, second.environment.MCDEV_HOST_PORT);

        const other = server.registerLaunch('D:/workspace/two', { token: STABLE_TOKEN });
        assert.notEqual(other.registrationId, first.registrationId, '不同工作区各自一条登记');
    } finally {
        await server.dispose();
    }
});

test('不传令牌时仍然每次生成随机令牌', async () => {
    const server = new HostBridgeServer(HOST_INFO);
    try {
        await server.start(0);
        const first = server.registerLaunch('D:/workspace/one');
        const second = server.registerLaunch('D:/workspace/one');
        assert.notEqual(first.environment.MCDEV_HOST_TOKEN, second.environment.MCDEV_HOST_TOKEN);
    } finally {
        await server.dispose();
    }
});

test('首选端口被占用时自动顺延，而不是直接失败', async () => {
    const busyPort = await freePort();
    const blocker = await occupyPort(busyPort);
    const server = new HostBridgeServer(HOST_INFO);
    try {
        const port = await server.start(busyPort);
        assert.equal(port, busyPort + 1, '占用时顺延到下一个端口');
        assert.equal(server.port, port);
        assert.equal(server.getSnapshot().status, 'listening');
    } finally {
        await server.dispose();
        await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
});

test('重载后的新宿主用同样的端口与令牌重新登记', async () => {
    const port = await freePort();
    const firstServer = new HostBridgeServer(HOST_INFO);
    const first = await (async () => {
        try {
            assert.equal(await firstServer.start(port), port);
            return firstServer.registerLaunch('D:/workspace/one', { token: STABLE_TOKEN });
        } finally {
            await firstServer.dispose();
        }
    })();

    const secondServer = new HostBridgeServer(HOST_INFO);
    try {
        assert.equal(await secondServer.start(port), port, '端口固定，重载后仍是同一个');
        const second = secondServer.registerLaunch('D:/workspace/one', { token: STABLE_TOKEN });
        assert.equal(second.environment.MCDEV_HOST_PORT, first.environment.MCDEV_HOST_PORT);
        assert.equal(second.environment.MCDEV_HOST_TOKEN, first.environment.MCDEV_HOST_TOKEN);
    } finally {
        await secondServer.dispose();
    }
});
