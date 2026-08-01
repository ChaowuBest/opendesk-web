import { jest } from '@jest/globals';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { InstanceRoutes } from '../../../main/server/opencode/routes/instance.js';

describe('opencode instance routes', () => {
    beforeAll(() => {
        AgentRegistry.initBuiltinAgents();
    });

    afterEach(() => {
        jest.restoreAllMocks();
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

    test('GET /experimental/session uses stable task lifecycle timestamps', async () => {
        const workspace = '/tmp/opendesk-instance-session-test';
        const task = {
            task_id: 'task_historical',
            parent_id: null,
            task_name: 'Historical task',
            task_status: 'waiting',
            created_at: new Date('2026-01-01T08:00:00.000Z'),
            started_at: new Date('2026-02-02T09:30:00.000Z'),
            updated_at: undefined,
            workspace,
            getWorkspace: jest.fn(() => workspace)
        };
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({
            taskManagerState: { tasks: [task] }
        } as any);

        const response = await InstanceRoutes().request(
            `/experimental/session?directory=${encodeURIComponent(workspace)}`
        );

        expect(response.status).toBe(200);
        const [session] = (await response.json()) as Array<{ time: { created: number; updated: number } }>;
        expect(session.time).toEqual({
            created: task.created_at.getTime(),
            updated: task.started_at.getTime()
        });
    });
});
