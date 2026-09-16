import { jest } from '@jest/globals';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { z } from 'zod';

class PromptTool extends BaseTool<z.ZodObject<Record<string, never>>> {
    constructor(
        name: string,
        private readonly contribution: { id: string; content: string }
    ) {
        super(name, name, z.object({}));
    }

    getSystemPromptContribution(): { id: string; content: string } {
        return this.contribution;
    }
}

function createToolset(name: string, ...tools: BaseTool<any>[]): BaseToolset {
    const toolset = new BaseToolset(name);
    toolset.addTools(...tools);
    return toolset;
}

describe('tool-derived system prompt contributions', () => {
    test('deduplicates contribution ids from the final toolsets', async () => {
        const task = new TaskState(new TaskManagerState());
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');
        const first = new PromptTool('first', { id: 'terminal.environment', content: '# first terminal' });
        const replacement = new PromptTool('replacement', {
            id: 'terminal.environment',
            content: '# replacement terminal'
        });

        const prompt = await (task.buildSystemPrompt as any)([
            createToolset('first-set', first),
            createToolset('replacement-set', replacement)
        ]);

        expect(prompt).toContain('# replacement terminal');
        expect(prompt).not.toContain('# first terminal');
        expect(prompt.endsWith('custom prompt')).toBe(true);
    });

    test('rebuilding replaces a previous terminal contribution instead of appending another one', async () => {
        const task = new TaskState(new TaskManagerState());
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');
        const powershell = createToolset(
            'terminal',
            new PromptTool('executePwsh', { id: 'terminal.environment', content: '# terminal: powershell' })
        );
        const bash = createToolset(
            'terminal',
            new PromptTool('executeBash', { id: 'terminal.environment', content: '# terminal: bash' })
        );

        await (task.rebuildSystemPrompt as any)([powershell]);
        expect(task.chat_context.system_prompt?.content).toContain('# terminal: powershell');

        await (task.rebuildSystemPrompt as any)([bash]);

        expect(task.chat_context.system_prompt?.content).toContain('# terminal: bash');
        expect(task.chat_context.system_prompt?.content).not.toContain('# terminal: powershell');
        expect(task.chat_context.system_prompt?.content.match(/# terminal:/g)).toHaveLength(1);
    });

    test('a filtered-out tool cannot contribute to the prompt', async () => {
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [
                createToolset(
                    'terminal',
                    new PromptTool('executePwsh', {
                        id: 'terminal.environment',
                        content: '# terminal: powershell'
                    })
                )
            ]
        };
        const task = new TaskState(manager);
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');
        task.disabledTools = ['executePwsh'];

        const finalToolsets = await task.buildToolsets();
        const prompt = await (task.buildSystemPrompt as any)(finalToolsets);

        expect(prompt).toBe('custom prompt');
    });

    test('a failing contribution getter degrades to no contribution instead of breaking the build', async () => {
        const task = new TaskState(new TaskManagerState());
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');
        const broken = new PromptTool('broken', { id: 'broken', content: 'ignored' });
        broken.getSystemPromptContribution = () => {
            throw new Error('contribution boom');
        };
        const healthy = new PromptTool('healthy', { id: 'terminal.environment', content: '# terminal: healthy' });

        const prompt = await (task.buildSystemPrompt as any)([createToolset('mixed-set', broken, healthy)]);

        expect(prompt).toContain('# terminal: healthy');
        expect(prompt).toContain('custom prompt');
        expect(prompt).not.toContain('ignored');
    });

    test('refreshing an existing task toolset also refreshes its effective prompt', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [
                createToolset(
                    'terminal',
                    new PromptTool('executeBash', {
                        id: 'terminal.environment',
                        content: '# terminal: bash'
                    })
                )
            ]
        };
        const task = new TaskState(manager);
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');

        await task.refreshBaseToolsets();

        expect(task.chat_context.system_prompt?.content).toBe('# terminal: bash\n\ncustom prompt');
    });

    test('rebuilding without explicit toolsets collects the current effective tools', async () => {
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [
                createToolset(
                    'terminal',
                    new PromptTool('executePwsh', {
                        id: 'terminal.environment',
                        content: '# terminal: powershell'
                    })
                )
            ]
        };
        const task = new TaskState(manager);
        task.agentId = undefined;
        task.setSystemPrompt('custom prompt');

        await task.rebuildSystemPrompt();

        expect(task.chat_context.system_prompt?.content).toBe('# terminal: powershell\n\ncustom prompt');
    });
});
