import { describe, expect, jest, test } from '@jest/globals';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import { registerMcpServerProvider } from '../../../main/applications/mcpmgr/provider.js';

describe('MCP server providers', () => {
    test('MCP manager combines configured and provider-owned servers for the UI', async () => {
        const unregister = registerMcpServerProvider({
            id: 'test-provider',
            async getServers() {
                return [
                    {
                        id: 'provided',
                        name: 'Provided MCP',
                        transport: 'stdio',
                        enabled: true,
                        source: 'plugin:test',
                        providerId: 'test-provider',
                        readOnly: true,
                        status: 'connected',
                        tools: []
                    }
                ];
            }
        });
        const application = new McpMgrApplication();
        (application as any).callWorker = jest.fn(async () => ({
            status: 'ok',
            data: [
                {
                    id: 'configured',
                    name: 'Configured MCP',
                    transport: 'stdio',
                    enabled: true,
                    status: 'connected',
                    tools: []
                }
            ]
        }));

        try {
            await expect(application.getServersForUI()).resolves.toEqual([
                expect.objectContaining({ id: 'configured' }),
                expect.objectContaining({
                    id: 'provided',
                    providerId: 'test-provider',
                    readOnly: true
                })
            ]);
        } finally {
            unregister();
            await application.beforeExit();
        }
    });
});
