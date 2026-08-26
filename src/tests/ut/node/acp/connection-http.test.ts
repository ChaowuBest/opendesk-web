import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as acp from '@agentclientprotocol/sdk';
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server';
import { createNodeHttpHandler } from '@agentclientprotocol/sdk/experimental/node';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';
import { createDefaultAcpConnectionFactory } from '../../../../main/applications/acpmgr/runtime/connection.js';
import { setPlatform, type AbstractPlatform } from '../../../../platforms/base.js';

setPlatform({
    getInjectedEnviron: () => new Map(),
    fetch: (input: string | URL, init?: RequestInit) => fetch(input, init)
} as AbstractPlatform);

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

async function close(server: Server, acpServer: AcpServer): Promise<void> {
    await acpServer.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('Streamable HTTP cookies are isolated by Agent profile and origin', async () => {
    const agent = (name: string) =>
        acp.agent({ name }).onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
            agentInfo: { name, version: '1.0.0' }
        }));
    const acpA = new AcpServer({ agent: agent('agent-a') });
    const acpB = new AcpServer({ agent: agent('agent-b') });
    const handleA = createNodeHttpHandler(acpA);
    const handleB = createNodeHttpHandler(acpB);
    const cookiesAtB: string[] = [];
    const serverA = createServer((request, response) => {
        response.setHeader('Set-Cookie', 'agent_a_secret=do-not-forward; Path=/');
        handleA(request, response);
    });
    const serverB = createServer((request, response) => {
        if (request.headers.cookie) cookiesAtB.push(request.headers.cookie);
        handleB(request, response);
    });
    const [portA, portB] = await Promise.all([listen(serverA), listen(serverB)]);
    const factory = createDefaultAcpConnectionFactory();
    const handlers = {
        sessionUpdate: async () => undefined,
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } })
    };
    const profile = (id: string, name: string, port: number) =>
        AcpAgentProfileSchema.parse({
            id,
            name,
            transport: { type: 'streamableHttp', url: `http://127.0.0.1:${port}/acp`, cookies: 'include' },
            execution: { location: 'agent', workspace: { strategy: 'fixed', path: '/', platform: 'posix' } }
        });

    try {
        const connectionA = await factory(
            profile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Agent A', portA),
            handlers,
            process.cwd()
        );
        await connectionA.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
        await connectionA.close();

        const connectionB = await factory(
            profile('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Agent B', portB),
            handlers,
            process.cwd()
        );
        await connectionB.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
        await connectionB.close();

        assert.deepEqual(cookiesAtB, []);
    } finally {
        await Promise.all([close(serverA, acpA), close(serverB, acpB)]);
    }
});
