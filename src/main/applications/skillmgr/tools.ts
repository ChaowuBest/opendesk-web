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

import { BaseTool } from '../../aikernel/tool';
import { z } from 'zod';
import type { PermissionRequest } from '../../aikernel/security/permission';
import { isBlacklisted } from './blacklist.js';
import { getSkillStatus } from './status.js';

const AddSkillFromDirectoryArgsSchema = z.object({
    sourceDirectory: z.string().describe('本地目录路径，该目录必须包含SKILL.md文件')
});

export class AddSkillFromDirectoryTool extends BaseTool<typeof AddSkillFromDirectoryArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromDirectory',
            '从本地目录添加一个Skill。目录必须包含SKILL.md文件。添加成功后需要刷新才能生效。',
            AddSkillFromDirectoryArgsSchema,
            undefined,
            { 'zh-CN': '从目录添加技能', 'en-US': 'Add Skill From Directory' }
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromDirectoryArgsSchema>): Promise<string> {
        const result = await this.skillApp.addSkillFromDirectory(args.sourceDirectory);
        return JSON.stringify(result);
    }
}

const AddSkillFromUrlArgsSchema = z.object({
    url: z.string().describe('Skill的下载URL，支持.zip等压缩包格式')
});

export class AddSkillFromUrlTool extends BaseTool<typeof AddSkillFromUrlArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromUrl',
            '从URL下载并添加一个Skill。URL指向的文件可以是.zip等压缩包格式。添加成功后需要刷新才能生效。',
            AddSkillFromUrlArgsSchema,
            undefined,
            { 'zh-CN': '从 URL 添加技能', 'en-US': 'Add Skill From URL' }
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromUrlArgsSchema>): Promise<string> {
        const result = await this.skillApp.addSkillFromUrl(args.url);
        return JSON.stringify(result);
    }
}

const SearchSkillFromRegistryArgsSchema = z.object({
    keyword: z.string().describe('技能名称关键字，会在所有已配置的Skill Registry中搜索')
});

export class SearchSkillFromRegistryTool extends BaseTool<typeof SearchSkillFromRegistryArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'searchSkillFromRegistry',
            '按技能名称关键字从所有Skill Registry中搜索可安装技能，返回技能全名、安装量和Registry名称等信息。',
            SearchSkillFromRegistryArgsSchema,
            undefined,
            { 'zh-CN': '搜索技能注册表', 'en-US': 'Search Skill Registry' }
        );
        this.skillApp = skillApp;
        this.executor = this.search.bind(this);
    }

    private async search(args: z.output<typeof SearchSkillFromRegistryArgsSchema>): Promise<string> {
        const result = await this.skillApp.searchSkillFromRegistry(args.keyword);
        return JSON.stringify(result);
    }
}

const AddSkillFromRegistryArgsSchema = z.object({
    skillName: z.string().describe('要安装的技能名称，可使用searchSkillFromRegistry返回的skillName或fullName'),
    registryName: z.string().describe('Registry名称，例如 matrix、clawhub、modelscope、skillhub、skill0、skillsmp'),
    force: z.boolean().optional().describe('是否强制覆盖已存在的同名技能')
});

export class AddSkillFromRegistryTool extends BaseTool<typeof AddSkillFromRegistryArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromRegistry',
            '指定技能名称和Registry名称，从该Registry安装一个Skill。添加成功后需要刷新才能生效。',
            AddSkillFromRegistryArgsSchema,
            undefined,
            { 'zh-CN': '从注册表安装技能', 'en-US': 'Install Skill From Registry' }
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromRegistryArgsSchema>): Promise<string> {
        const result = await this.skillApp.addSkillFromRegistry(args.skillName, args.registryName, args.force ?? false);
        return JSON.stringify(result);
    }
}

const ListSkillsArgsSchema = z.object({});

export class ListSkillsTool extends BaseTool<typeof ListSkillsArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'listSkills',
            '列出所有已安装的Skills及其详细信息（含 enabled 字段标记启用状态；enabled=false 的技能已被禁用，无法被加载或调用）',
            ListSkillsArgsSchema,
            undefined,
            {
                'zh-CN': '技能列表',
                'en-US': 'List Skills'
            }
        );
        this.skillApp = skillApp;
        this.executor = this.list.bind(this);
    }

    private async list(): Promise<string> {
        const skills = this.skillApp.listSkills();
        // 过滤掉已加入黑名单的 skill：agent 不应看到恶意 skill 出现在已安装列表中，
        // 否则会顺藤摸瓜用文件工具读其源文件绕过黑名单（黑名单 filter 只守技能加载通道）。
        // skillmgr 安装的 skill id 即 frontmatter.name，黑名单 key 为 `skillmgr/${name}`。
        // 补充 enabled 字段：已安装不代表可用，禁用的技能 LoadSkill/CallSkill 均会失败，
        // agent 需要依据该状态回答技能可用性，避免把"已安装"误判为"可调用"。
        const visible = skills
            .filter((s: any) => !isBlacklisted('skillmgr', String(s.name ?? s.id)))
            .map((s: any) => ({ ...s, enabled: getSkillStatus(String(s.id ?? s.name)) }));
        return JSON.stringify(visible);
    }
}

const DeleteSkillsArgsSchema = z.object({
    skillIds: z.array(z.string()).describe('要删除的Skill ID列表（即目录名列表），支持批量删除')
});

export class DeleteSkillsTool extends BaseTool<typeof DeleteSkillsArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super('deleteSkills', '批量删除指定的Skill。删除后需要刷新才能生效。', DeleteSkillsArgsSchema, undefined, {
            'zh-CN': '卸载技能',
            'en-US': 'Uninstall Skills'
        });
        this.skillApp = skillApp;
        this.executor = this.delete.bind(this);
    }

    getDeclaredPermissions(args: z.output<typeof DeleteSkillsArgsSchema>): PermissionRequest[] {
        return args.skillIds
            .filter((id) => id && !/[\r\n\x00-\x1f\u2028\u2029]/.test(id))
            .map((id) => ({
                resourceType: 'skill' as const,
                action: 'write' as const,
                resourcePath: id
            }));
    }

    private async delete(args: z.output<typeof DeleteSkillsArgsSchema>): Promise<string> {
        const results = args.skillIds.map((id) => ({
            skillId: id,
            ...this.skillApp.deleteSkill(id)
        }));
        return JSON.stringify(results);
    }
}

const RefreshSkillsArgsSchema = z.object({});

export class RefreshSkillsTool extends BaseTool<typeof RefreshSkillsArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'refreshSkills',
            '刷新所有Skills，重新加载并注册到AI内核。在添加或删除Skill后调用此工具。',
            RefreshSkillsArgsSchema,
            undefined,
            { 'zh-CN': '刷新技能', 'en-US': 'Refresh Skills' }
        );
        this.skillApp = skillApp;
        this.executor = this.refresh.bind(this);
    }

    private async refresh(): Promise<string> {
        const result = this.skillApp.refresh();
        return JSON.stringify(result);
    }
}

const GetSkillsDirectoryArgsSchema = z.object({});

export class GetSkillsDirectoryTool extends BaseTool<typeof GetSkillsDirectoryArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super('getSkillsDirectory', '获取当前Skills的存储目录路径', GetSkillsDirectoryArgsSchema, undefined, {
            'zh-CN': '技能目录',
            'en-US': 'Skills Directory'
        });
        this.skillApp = skillApp;
        this.executor = this.get.bind(this);
    }

    private async get(): Promise<string> {
        const dir = this.skillApp.getSkillsDirectory();
        return JSON.stringify({ directory: dir });
    }
}
