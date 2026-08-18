import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    runPluginChatHeaders,
    runPluginChatParams,
    runPluginAfterSkillLoad,
    runPluginBeforeSkillLoad,
    runPluginAfterSkillInstall,
    runPluginBeforeSkillInstall
} from '../../../main/applications/pluginmgr/runtime/hooks.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

describe('OpenDesk plugin request hooks', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('保留调用方 header，并按顺序应用插件修改', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'request-header',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (input, output) => {
                        output.headers['x-task'] = input.taskId ?? '';
                        output.headers.authorization = 'plugin';
                    });
                }
            }),
            { origin: 'test:request-header' }
        );

        const headers = await runPluginChatHeaders(
            { taskId: 'task-1', modelAlias: 'model-1' },
            { authorization: 'caller', 'x-existing': 'yes' }
        );

        expect(headers).toEqual({
            authorization: 'plugin',
            'x-existing': 'yes',
            'x-task': 'task-1'
        });
    });

    test('普通 header hook 失败时回滚其修改并继续请求', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'broken-header',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', (_input, output) => {
                        output.headers.authorization = 'partial';
                        throw new Error('header failed');
                    });
                }
            }),
            { origin: 'test:broken-header' }
        );

        await expect(runPluginChatHeaders({}, { authorization: 'caller' })).resolves.toEqual({
            authorization: 'caller'
        });
    });

    test('closed header hook 失败时中止当前请求准备', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'required-header',
                failureMode: 'closed',
                setup(ctx) {
                    ctx.hooks.on('chat.headers', () => {
                        throw new Error('required header unavailable');
                    });
                }
            }),
            { origin: 'test:required-header' }
        );

        await expect(runPluginChatHeaders({}, {})).rejects.toThrow('required header unavailable');
    });

    test('chat.params 可以修改模型请求参数', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'request-params',
                setup(ctx) {
                    ctx.hooks.on('chat.params', (input, output) => {
                        if (input.modelAlias === 'reasoning-model') {
                            output.reasoningEffort = 'high';
                            output.maxCompletionTokens = 4096;
                        }
                    });
                }
            }),
            { origin: 'test:request-params' }
        );

        await expect(
            runPluginChatParams(
                { taskId: 'task-1', modelAlias: 'reasoning-model' },
                { reasoningEffort: 'low', maxCompletionTokens: 1024 }
            )
        ).resolves.toEqual({
            reasoningEffort: 'high',
            maxCompletionTokens: 4096
        });
    });

    test('普通 chat.params 失败时回滚该插件的参数修改', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'broken-params',
                setup(ctx) {
                    ctx.hooks.on('chat.params', (_input, output) => {
                        output.maxCompletionTokens = 1;
                        throw new Error('params failed');
                    });
                }
            }),
            { origin: 'test:broken-params' }
        );

        await expect(runPluginChatParams({}, { maxCompletionTokens: 2048 })).resolves.toEqual({
            maxCompletionTokens: 2048
        });
    });

    test('skill load hooks forward before decisions and after notifications', async () => {
        const calls: unknown[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-load-hooks',
                setup(ctx) {
                    ctx.hooks.on('skill.load.before', (input, output) => {
                        if (input.skillName === 'restricted') {
                            output.operation = 'deny';
                            output.message = 'restricted skill';
                        } else {
                            output.message = 'allowed skill';
                        }
                    });
                    ctx.hooks.on('skill.load.after', (input) => {
                        calls.push(input);
                    });
                }
            }),
            { origin: 'test:skill-load-hooks' }
        );

        await expect(
            runPluginBeforeSkillLoad({
                bundleName: 'bundle',
                skillName: 'restricted',
                frontmatter: { name: 'restricted', description: 'Restricted' }
            })
        ).resolves.toEqual({ operation: 'deny', message: 'restricted skill' });

        await expect(
            runPluginBeforeSkillLoad({
                bundleName: 'bundle',
                skillName: 'review',
                frontmatter: { name: 'review', description: 'Review' }
            })
        ).resolves.toEqual({ operation: 'allow', message: 'allowed skill' });

        await runPluginAfterSkillLoad({
            bundleName: 'bundle',
            skillName: 'review',
            frontmatter: { name: 'review', description: 'Review' }
        });
        expect(calls).toEqual([expect.objectContaining({ bundleName: 'bundle', skillName: 'review' })]);
    });

    test('skill install hooks forward decisions and successful installation notifications', async () => {
        const calls: unknown[] = [];
        await getPluginHost().activate(
            definePlugin({
                id: 'skill-install-hooks',
                setup(ctx) {
                    ctx.hooks.on('skill.install.before', (input, output) => {
                        if (input.url === 'https://example.com/blocked.zip') {
                            output.operation = 'deny';
                            output.message = 'blocked skill package';
                        }
                    });
                    ctx.hooks.on('skill.install.after', (input) => {
                        calls.push(input);
                    });
                }
            }),
            { origin: 'test:skill-install-hooks' }
        );

        await expect(
            runPluginBeforeSkillInstall({ source: 'url', url: 'https://example.com/blocked.zip' })
        ).resolves.toEqual({ operation: 'deny', message: 'blocked skill package' });

        await runPluginAfterSkillInstall({
            source: 'url',
            url: 'https://example.com/allowed.zip',
            skillName: 'allowed'
        });
        expect(calls).toEqual([
            expect.objectContaining({ source: 'url', url: 'https://example.com/allowed.zip', skillName: 'allowed' })
        ]);
    });
});
