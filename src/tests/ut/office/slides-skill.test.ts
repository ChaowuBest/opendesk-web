import { jest } from '@jest/globals';
import { buildSlidesSkill, type SlidesCapabilityDefinition } from '../../../main/applications/slides/skill.js';

const deckContextCapability: SlidesCapabilityDefinition = {
    name: 'get_deck_context',
    description: '读取演示文稿概览',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

const textCapability: SlidesCapabilityDefinition = {
    name: 'set_element_text',
    description: '修改幻灯片元素段落',
    inputSchema: {
        type: 'object',
        properties: {
            slideIndex: { type: 'integer' },
            sourceId: { type: 'string' },
            paragraphs: { $ref: '#/definitions/paragraphs' }
        },
        required: ['slideIndex', 'sourceId', 'paragraphs'],
        definitions: {
            paragraphs: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' }
                    },
                    required: ['text']
                }
            }
        }
    }
};

const chartCapability: SlidesCapabilityDefinition = {
    name: 'edit_chart',
    description: '修改已有图表的数据和样式',
    inputSchema: {
        type: 'object',
        properties: {
            slideIndex: { type: 'integer' },
            sourceId: { type: 'string' },
            title: { type: 'string' }
        },
        required: ['slideIndex', 'sourceId'],
        additionalProperties: false
    }
};

const capabilities = [deckContextCapability, textCapability, chartCapability];

describe('PPT task skill', () => {
    test('loads and enumerates a deterministic presentation action catalog', async () => {
        const skill = buildSlidesSkill(capabilities, jest.fn() as never);

        expect(skill.frontmatter.name).toBe('edit-current-presentation');
        expect(skill.body).toContain('[read] get_deck_context');
        expect(skill.body).toContain('[text] set_element_text');
        expect(skill.body).toContain('[chart] edit_chart');
        expect([...skill.toolsets![0].tools.keys()]).toEqual([
            'list_actions',
            'get_action_definition',
            'execute_action'
        ]);

        const chartActions = await skill.getTool('list_actions')!.execute({ category: 'chart' });
        expect(JSON.parse(chartActions.result)).toEqual([
            { name: 'edit_chart', category: 'chart', summary: '修改已有图表' }
        ]);
    });

    test('returns the exact Office definition for a named action', async () => {
        const skill = buildSlidesSkill(capabilities, jest.fn() as never);

        const result = await skill.getTool('get_action_definition')!.execute({ name: 'edit_chart' });
        const definition = JSON.parse(result.result);

        expect(result.status).toBe('success');
        expect(definition).toEqual({
            name: 'edit_chart',
            category: 'chart',
            description: chartCapability.description,
            inputSchema: chartCapability.inputSchema
        });
    });

    test('loads the current Office picture editing actions', async () => {
        const pictureCapabilities: SlidesCapabilityDefinition[] = [
            { name: 'crop_image', description: '裁剪图片', inputSchema: { type: 'object', properties: {} } },
            {
                name: 'set_picture_opacity',
                description: '设置图片透明度',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'replace_image',
                description: '替换图片内容',
                inputSchema: { type: 'object', properties: {} }
            }
        ];

        const skill = buildSlidesSkill(pictureCapabilities, jest.fn() as never);
        const result = await skill.getTool('list_actions')!.execute({ category: 'layout' });

        expect(JSON.parse(result.result)).toEqual([
            { name: 'crop_image', category: 'layout', summary: '裁剪图片' },
            { name: 'set_picture_opacity', category: 'layout', summary: '修改图片透明度' },
            { name: 'replace_image', category: 'layout', summary: '原位替换图片内容' }
        ]);
    });

    test('validates and executes a named action for the current task', async () => {
        const execute = jest.fn(async () => ({
            output: 'updated',
            summary: 'set_element_text',
            mutated: true
        }));
        const skill = buildSlidesSkill(capabilities, execute);

        const result = await skill.getTool('execute_action')!.execute(
            {
                name: 'set_element_text',
                input: {
                    slideIndex: 0,
                    sourceId: 'shape-1',
                    paragraphs: [{ text: '新标题' }]
                }
            },
            undefined,
            { task_id: 'task-a' } as never
        );

        expect(result.status).toBe('success');
        expect(result.result).toBe('updated');
        expect(execute).toHaveBeenCalledWith('task-a', 'set_element_text', {
            slideIndex: 0,
            sourceId: 'shape-1',
            paragraphs: [{ text: '新标题' }]
        });
    });
});
