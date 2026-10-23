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

import { z } from 'zod';
import { BaseTool } from '../../aikernel/tool';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import { sanitizeLocalPath } from '../../utils/path.js';
import { Setting } from '../../utils/setting.js';
import { t } from './locale/index.js';
import { zhCn } from './locale/zh-cn.js';
import { enUs } from './locale/en-us.js';
import type { AdminConsoleApplication } from './app.js';

/** 用两套 locale 词典构造双语显示名，供 UI 按当前语言解析 */
function displayName(nameKey: string): Record<string, string> {
    return { 'zh-CN': zhCn[nameKey] ?? nameKey, 'en-US': enUs[nameKey] ?? nameKey };
}

const ListRecentArgsSchema = z.object({
    limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 20，最大 100'),
    offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('分页偏移，默认 0；翻页时 offset += limit，直到取满响应中的 total')
});

const DetailsArgsSchema = z.object({
    id: z.number().int().positive().describe('反馈记录 id，取自列表工具结果中的 id 字段')
});

const DownloadAttachmentArgsSchema = z.object({
    attachmentId: z.number().int().positive().describe('附件 id，取自列表或详情结果中 attachments[].attachment_id'),
    path: z
        .string()
        .min(1)
        .describe('保存到本地的文件路径，支持绝对路径或相对工作区路径，如 /path/to/attachment_name.txt')
});

/** 与 filemgr writeFile 同口径的路径规范化（共享实现，见 utils/path.ts） */
function getWorkingDirectory(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

/** AdminResult → 工具输出：错误抛异常（由工具调用框架标记失败），成功序列化为 JSON */
function unwrapAdminResult(result: { status: string; data?: unknown; code?: string; message?: string }): string {
    if (result.status !== 'ok') {
        throw new Error(result.message || result.code || 'adminconsole request failed');
    }
    return JSON.stringify(result.data, null, 2);
}

export class ListRecentRequirementsTool extends BaseTool<typeof ListRecentArgsSchema> {
    constructor(private readonly app: AdminConsoleApplication) {
        super(
            'listRecentRequirements',
            t('tool.listRecentRequirements.desc'),
            ListRecentArgsSchema,
            undefined,
            displayName('tool.listRecentRequirements.name')
        );
        this.setExecutor(async (args) =>
            unwrapAdminResult(await this.app.listFeedbackByType('feature', args.limit ?? 20, args.offset ?? 0))
        );
    }
}

export class GetRequirementDetailsTool extends BaseTool<typeof DetailsArgsSchema> {
    constructor(private readonly app: AdminConsoleApplication) {
        super(
            'getRequirementDetails',
            t('tool.getRequirementDetails.desc'),
            DetailsArgsSchema,
            undefined,
            displayName('tool.getRequirementDetails.name')
        );
        this.setExecutor(async (args) => unwrapAdminResult(await this.app.getFeedbackDetail('feature', args.id)));
    }
}

export class ListRecentBugsTool extends BaseTool<typeof ListRecentArgsSchema> {
    constructor(private readonly app: AdminConsoleApplication) {
        super(
            'listRecentBugs',
            t('tool.listRecentBugs.desc'),
            ListRecentArgsSchema,
            undefined,
            displayName('tool.listRecentBugs.name')
        );
        this.setExecutor(async (args) =>
            unwrapAdminResult(await this.app.listFeedbackByType('bug', args.limit ?? 20, args.offset ?? 0))
        );
    }
}

export class GetBugDetailsTool extends BaseTool<typeof DetailsArgsSchema> {
    constructor(private readonly app: AdminConsoleApplication) {
        super(
            'getBugDetails',
            t('tool.getBugDetails.desc'),
            DetailsArgsSchema,
            undefined,
            displayName('tool.getBugDetails.name')
        );
        this.setExecutor(async (args) => unwrapAdminResult(await this.app.getFeedbackDetail('bug', args.id)));
    }
}

export class DownloadAttachmentTool extends BaseTool<typeof DownloadAttachmentArgsSchema> {
    constructor(private readonly app: AdminConsoleApplication) {
        super(
            'downloadAttachment',
            t('tool.downloadAttachment.desc'),
            DownloadAttachmentArgsSchema,
            undefined,
            displayName('tool.downloadAttachment.name')
        );
        this.serialExecution = true;
        this.setExecutor(async (args, taskState) =>
            unwrapAdminResult(
                await this.app.downloadAttachmentToFile(
                    args.attachmentId,
                    sanitizeLocalPath(args.path, getWorkingDirectory(taskState))
                )
            )
        );
    }

    /** 与 writeFile 一致：声明目标路径的 file/write 权限，由权限网关在执行前审批 */
    getDeclaredPermissions(
        args: z.output<typeof DownloadAttachmentArgsSchema>,
        taskState?: TaskState
    ): PermissionRequest[] {
        const p = sanitizeLocalPath(args.path, getWorkingDirectory(taskState));
        if (!p) return [];
        return [{ resourceType: 'file', action: 'write', resourcePath: p }];
    }
}
