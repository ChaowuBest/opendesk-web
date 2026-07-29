import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { InstanceRoutes } from '../../../main/server/opencode/routes/instance.js';

describe('opencode instance routes', () => {
    beforeAll(() => {
        AgentRegistry.initBuiltinAgents();
    });

    test('GET /command returns mode metadata without constructing task prompts', async () => {
        const response = await InstanceRoutes().request('/command');

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'main:readonly',
                    name: 'readonly',
                    description: expect.any(String)
                })
            ])
        );
    });

    test('GET /agent returns all builtin agents without constructing task prompts', async () => {
        const response = await InstanceRoutes().request('/agent');

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'main',
                    dispatchable: false,
                    modes: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'readonly',
                            description: expect.any(String)
                        })
                    ])
                })
            ])
        );
    });
});
