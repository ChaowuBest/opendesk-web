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

const AddSkillFromPathArgsSchema = z.object({
    sourcePath: z.string().describe('本地目录路径，该目录必须包含SKILL.md文件')
});

export class AddSkillFromPathTool extends BaseTool<typeof AddSkillFromPathArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromPath',
            '从本地目录添加一个Skill。目录必须包含SKILL.md文件。添加成功后需要刷新才能生效。',
            AddSkillFromPathArgsSchema
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromPathArgsSchema>): Promise<string> {
        const result = this.skillApp.addSkillFromPath(args.sourcePath);
        return JSON.stringify(result);
    }
}

const AddSkillFromUrlArgsSchema = z.object({
    url: z.string().describe('Skill的下载URL，支持.zip、.tar.gz等压缩包格式')
});

export class AddSkillFromUrlTool extends BaseTool<typeof AddSkillFromUrlArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromUrl',
            '从URL下载并添加一个Skill。URL指向的文件可以是.zip或.tar.gz等压缩包格式。添加成功后需要刷新才能生效。',
            AddSkillFromUrlArgsSchema
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromUrlArgsSchema>): Promise<string> {
        const result = this.skillApp.addSkillFromUrl(args.url);
        return JSON.stringify(result);
    }
}

const AddSkillFromGitHubUrlArgsSchema = z.object({
    githubUrl: z.string().describe('GitHub仓库URL，例如 https://github.com/username/repo/tree/main/skill-name')
});

export class AddSkillFromGitHubUrlTool extends BaseTool<typeof AddSkillFromGitHubUrlArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super(
            'addSkillFromGitHubUrl',
            '从GitHub仓库URL添加一个Skill。URL应该指向包含Skill的目录。添加成功后需要刷新才能生效。',
            AddSkillFromGitHubUrlArgsSchema
        );
        this.skillApp = skillApp;
        this.executor = this.add.bind(this);
    }

    private async add(args: z.output<typeof AddSkillFromGitHubUrlArgsSchema>): Promise<string> {
        const result = this.skillApp.addSkillFromGitHubUrl(args.githubUrl);
        return JSON.stringify(result);
    }
}

const ListSkillsArgsSchema = z.object({});

export class ListSkillsTool extends BaseTool<typeof ListSkillsArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super('listSkills', '列出所有已安装的Skills及其详细信息，包括名称、描述、许可证等', ListSkillsArgsSchema);
        this.skillApp = skillApp;
        this.executor = this.list.bind(this);
    }

    private async list(): Promise<string> {
        const skills = this.skillApp.listSkills();
        return JSON.stringify(skills);
    }
}

const DeleteSkillsArgsSchema = z.object({
    skillIds: z.array(z.string()).describe('要删除的Skill ID列表（即目录名列表），支持批量删除')
});

export class DeleteSkillsTool extends BaseTool<typeof DeleteSkillsArgsSchema> {
    private skillApp: any;

    constructor(skillApp: any) {
        super('deleteSkills', '批量删除指定的Skill。删除后需要刷新才能生效。', DeleteSkillsArgsSchema);
        this.skillApp = skillApp;
        this.executor = this.delete.bind(this);
    }

    getDeclaredPermissions(args: z.output<typeof DeleteSkillsArgsSchema>): PermissionRequest[] {
        return args.skillIds.map((id) => ({
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
            RefreshSkillsArgsSchema
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
        super('getSkillsDirectory', '获取当前Skills的存储目录路径', GetSkillsDirectoryArgsSchema);
        this.skillApp = skillApp;
        this.executor = this.get.bind(this);
    }

    private async get(): Promise<string> {
        const dir = this.skillApp.getSkillsDirectory();
        return JSON.stringify({ directory: dir });
    }
}
