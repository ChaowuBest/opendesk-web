import { jest } from '@jest/globals';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { SkillMgrApplication } from '../../../main/applications/skillmgr/app.js';
import { definePlugin } from '../../../../packages/plugin/src/index.js';

describe('SkillMgrApplication install proxy hooks', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('denied GUI installation never reaches the SkillMgr worker', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'deny-skill-install',
                setup(ctx) {
                    ctx.hooks.on('skill.install.before', (_input, output) => {
                        output.operation = 'deny';
                        output.message = 'blocked by policy';
                    });
                }
            }),
            { origin: 'test:deny-skill-install' }
        );
        const callWorker = jest.fn();
        const app = { callWorker };

        await expect(
            SkillMgrApplication.prototype.addFromUrl.call(app, 'https://example.com/blocked.zip')
        ).rejects.toThrow('blocked by policy');
        expect(callWorker).not.toHaveBeenCalled();
    });

    test('allowed GUI installation proxies to the worker and then notifies after hooks', async () => {
        const events: string[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'observe-skill-install',
                setup(ctx) {
                    ctx.hooks.on('skill.install.before', () => {
                        events.push('before');
                    });
                    ctx.hooks.on('skill.install.after', (input) => {
                        events.push(`after:${input.skillName}`);
                    });
                }
            }),
            { origin: 'test:observe-skill-install' }
        );
        const callWorker = jest.fn().mockResolvedValue({ status: 'ok', data: { name: 'installed-skill' } });
        const app = { callWorker };

        await expect(
            SkillMgrApplication.prototype.addFromUrl.call(app, 'https://example.com/allowed.zip')
        ).resolves.toEqual({ name: 'installed-skill' });
        expect(callWorker).toHaveBeenCalledWith('addFromUrl', 'https://example.com/allowed.zip');
        expect(events).toEqual(['before', 'after:installed-skill']);
    });
});
