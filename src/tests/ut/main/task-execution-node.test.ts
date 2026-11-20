import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const node = {
    nodeId: 'remote',
    displayName: '远程节点',
    workspace: '/remote',
    platform: 'linux',
    commands: ['system.run', 'fs.readText'],
    shells: ['bash'],
    defaultShell: 'bash'
};
jest.unstable_mockModule('../../../main/applications/devicemgr/execution.js', () => ({
    getExecutionNode: (id: string) => (id === 'remote' ? node : null)
}));

describe('shared task execution node selection', () => {
    let apply: any;
    beforeAll(async () => {
        ({ applyTaskExecutionNode: apply } = await import('../../../main/applications/devicemgr/task-execution.js'));
    });
    test('applies real remote capabilities and never silently changes a disconnected node to local', async () => {
        const setExecutionHost = jest.fn<any>().mockResolvedValue(undefined);
        const task = { setExecutionHost };
        const result = await apply(task, ' remote ');
        expect(result.data).toEqual({ type: 'node', nodeId: 'remote', nodeLabel: '远程节点', workspace: '/remote' });
        expect(setExecutionHost).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: 'node',
                capabilities: expect.objectContaining({ commands: ['system.run', 'fs.readText'], shells: ['bash'] })
            })
        );
        expect((await apply(task, 'offline')).status).toBe('error');
        expect(setExecutionHost).toHaveBeenCalledTimes(1);
        await apply(task, null);
        expect(setExecutionHost).toHaveBeenLastCalledWith({ type: 'local' });
    });
});
