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

/**
 * Electron 环境下的权限确认 PromptProvider。
 *
 * 通过 Electron 的 dialog API 显示一个全局浮窗来请求用户确认权限。
 * 当运行在 Electron 环境中时使用此 provider。
 */

import type { PermissionRequest, PermissionUserResponse, PermissionPromptProvider } from './permission.js';
import { logger } from '../../utils/logger.js';

const ACTION_LABELS: Record<string, string> = {
    read: '读取',
    write: '编辑',
    execute: '执行',
    access: '访问'
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
    file: '文件',
    network: '网络',
    skill: '技能'
};

/**
 * Electron 环境下通过 dialog.showMessageBox 实现的权限确认。
 * 注意：此类只能在 Electron 主进程中使用。
 */
export class ElectronPermissionPromptProvider implements PermissionPromptProvider {
    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[]
    ): Promise<PermissionUserResponse> {
        const first = requests[0];
        const actionLabel = ACTION_LABELS[first.action] || first.action;
        const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;
        const typeActionLabel = `${actionLabel}${typeLabel}`;

        const pathList = requests.map((r) => r.resourcePath).join('\n');

        try {
            const { dialog, BrowserWindow } = await import('electron');

            const focusedWindow = BrowserWindow.getFocusedWindow();

            // 构建按钮列表：本次允许 → 前缀选项(最多2个) → 始终允许所有 → 拒绝
            const buttons: string[] = ['本次允许'];
            const topPrefixes = prefixOptions.slice(0, 2);
            for (const opt of topPrefixes) {
                buttons.push(`始终允许 ${opt.label} 的${typeActionLabel}`);
            }
            buttons.push(`始终允许所有${typeActionLabel}操作`);
            buttons.push('拒绝');

            const cancelId = buttons.length - 1;

            const result = await dialog.showMessageBox(focusedWindow ?? (undefined as any), {
                type: 'warning',
                title: '权限确认',
                message: `${toolName} 请求${typeActionLabel}`,
                detail: `资源路径:\n${pathList}\n\n是否允许此操作？`,
                buttons,
                defaultId: cancelId,
                cancelId,
                noLink: true
            });

            const idx = result.response;
            if (idx === 0) {
                return { decision: 'allow', rememberScope: 'none' };
            } else if (idx <= topPrefixes.length) {
                return {
                    decision: 'allow',
                    rememberScope: 'prefix',
                    selectedPrefixPattern: topPrefixes[idx - 1].pattern
                };
            } else if (idx === topPrefixes.length + 1) {
                return { decision: 'allow', rememberScope: 'type' };
            } else {
                return { decision: 'deny', rememberScope: 'none' };
            }
        } catch (err) {
            logger.warn(`Electron dialog not available, denying permission: ${err}`);
            return { decision: 'deny', rememberScope: 'none' };
        }
    }
}
