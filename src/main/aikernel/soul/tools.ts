/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BaseTool } from '../tool.js';
import { z } from 'zod';
import { SoulRegistry } from './registry.js';

function getRegistry(): SoulRegistry {
    const registry = SoulRegistry.getInstance();
    if (!registry) {
        throw new Error('SoulRegistry not initialized');
    }
    return registry;
}

const ListSoulsArgsSchema = z.object({});

export class ListSoulsTool extends BaseTool<typeof ListSoulsArgsSchema> {
    constructor() {
        super(
            'listSouls',
            '列出所有可用的人设及当前激活的人设。返回每个人设的 uid、昵称、描述和激活状态。',
            ListSoulsArgsSchema,
            undefined,
            { 'zh-CN': '列出人设', 'en-US': 'List Souls' }
        );
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(): Promise<string> {
        const registry = getRegistry();
        const souls = registry.listSouls();
        const activeUid = SoulRegistry.getActiveSoulUid();
        const result = souls.map((s) => ({
            ...s,
            active: s.uid === activeUid
        }));
        return JSON.stringify(result, null, 2);
    }
}

const GetSoulArgsSchema = z.object({
    uid: z.string().describe('人设的唯一标识符(uid)')
});

export class GetSoulTool extends BaseTool<typeof GetSoulArgsSchema> {
    constructor() {
        super('getSoul', '获取指定人设的完整内容（通过 uid 查找）', GetSoulArgsSchema, undefined, {
            'zh-CN': '获取人设',
            'en-US': 'Get Soul'
        });
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(args: z.output<typeof GetSoulArgsSchema>): Promise<string> {
        const registry = getRegistry();
        const soul = registry.getSoul(args.uid);
        if (!soul) return JSON.stringify({ error: `人设 (uid=${args.uid}) 不存在` });
        return JSON.stringify(
            {
                uid: soul.frontmatter.uid,
                name: soul.frontmatter.name,
                description: soul.frontmatter.description,
                author: soul.frontmatter.author,
                body: soul.body
            },
            null,
            2
        );
    }
}

const CreateSoulArgsSchema = z.object({
    name: z.string().describe('人设的昵称/名字（用户可见的显示名，如"小明"、"代码大师"）'),
    description: z.string().describe('人设的简短描述'),
    body: z.string().describe('人设的完整内容（Markdown格式），描述该人设的性格、语气、专长、行为准则等'),
    author: z.string().optional().describe('人设作者')
});

export class CreateSoulTool extends BaseTool<typeof CreateSoulArgsSchema> {
    constructor() {
        super(
            'createSoul',
            '创建一个全新的人设。注意：如果用户只是想修改现有人设，应该使用 updateSoul 而非本工具。',
            CreateSoulArgsSchema,
            undefined,
            { 'zh-CN': '创建人设', 'en-US': 'Create Soul' }
        );
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(args: z.output<typeof CreateSoulArgsSchema>): Promise<string> {
        const registry = getRegistry();
        const result = registry.createSoul(args.name, args.description, args.body, args.author);
        return JSON.stringify(result);
    }
}

const UpdateSoulArgsSchema = z.object({
    uid: z.string().describe('要更新的人设的 uid'),
    name: z.string().optional().describe('更新后的昵称/名字'),
    description: z.string().optional().describe('更新后的描述'),
    body: z.string().optional().describe('更新后的人设完整内容（Markdown格式）')
});

export class UpdateSoulTool extends BaseTool<typeof UpdateSoulArgsSchema> {
    constructor() {
        super(
            'updateSoul',
            '修改一个已有的人设。可以更新昵称、描述或内容。这是修改人设的首选方式。',
            UpdateSoulArgsSchema,
            undefined,
            { 'zh-CN': '修改人设', 'en-US': 'Update Soul' }
        );
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(args: z.output<typeof UpdateSoulArgsSchema>): Promise<string> {
        const registry = getRegistry();
        const result = registry.updateSoul(args.uid, {
            name: args.name,
            description: args.description,
            body: args.body
        });
        return JSON.stringify(result);
    }
}

const DeleteSoulArgsSchema = z.object({
    uid: z.string().describe('要删除的人设 uid（不能删除默认人设 uid="default"）')
});

export class DeleteSoulTool extends BaseTool<typeof DeleteSoulArgsSchema> {
    constructor() {
        super('deleteSoul', '删除一个人设（不能删除默认人设）', DeleteSoulArgsSchema, undefined, {
            'zh-CN': '删除人设',
            'en-US': 'Delete Soul'
        });
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(args: z.output<typeof DeleteSoulArgsSchema>): Promise<string> {
        const registry = getRegistry();
        const result = registry.deleteSoul(args.uid);
        return JSON.stringify(result);
    }
}

const SwitchSoulArgsSchema = z.object({
    uid: z.string().describe('要切换到的人设 uid')
});

export class SwitchSoulTool extends BaseTool<typeof SwitchSoulArgsSchema> {
    constructor() {
        super('switchSoul', '切换当前激活的人设。切换后在新会话中生效。', SwitchSoulArgsSchema, undefined, {
            'zh-CN': '切换人设',
            'en-US': 'Switch Soul'
        });
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(args: z.output<typeof SwitchSoulArgsSchema>): Promise<string> {
        const registry = getRegistry();
        const result = registry.switchSoul(args.uid);
        return JSON.stringify(result);
    }
}

const ResetDefaultSoulArgsSchema = z.object({});

export class ResetDefaultSoulTool extends BaseTool<typeof ResetDefaultSoulArgsSchema> {
    constructor() {
        super(
            'resetDefaultSoul',
            '重置系统默认人设（uid=default）到初始状态。会覆盖用户对默认人设的任何修改。',
            ResetDefaultSoulArgsSchema,
            undefined,
            { 'zh-CN': '重置默认人设', 'en-US': 'Reset Default Soul' }
        );
        this.setExecutor(this.execute_impl.bind(this));
    }

    private async execute_impl(): Promise<string> {
        const registry = getRegistry();
        const result = registry.resetDefaultSoul();
        return JSON.stringify(result);
    }
}
