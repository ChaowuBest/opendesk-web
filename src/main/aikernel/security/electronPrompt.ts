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
 * 通过 IPC 将权限请求发送到 renderer 的 permission-prompt 组件展示，
 * 等待用户在内嵌浮窗中做出选择后回传结果。
 * 同时向操作系统发送通知，提示用户需要进行权限授权。
 */

import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider,
    PermissionTaskInfo
} from './permission.js';
import { logger } from '../../utils/logger.js';
import { electron } from '../../../utils/electron.js';

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

export class ElectronPermissionPromptProvider implements PermissionPromptProvider {
    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo
    ): Promise<PermissionUserResponse> {
        try {
            const { BrowserWindow, ipcMain, Notification } = electron();
            const focusedWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;

            if (!focusedWindow) {
                logger.warn('No Electron window available for permission prompt, denying');
                return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
            }

            const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            const first = requests[0];
            const actionLabel = ACTION_LABELS[first.action] || first.action;
            const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;

            if (Notification.isSupported()) {
                const notification = new Notification({
                    title: 'OpenDesk - 权限确认',
                    body: `${toolName} 请求${actionLabel}${typeLabel}，请在应用内确认`,
                    silent: false
                });
                notification.show();
                notification.on('click', () => {
                    if (focusedWindow && !focusedWindow.isDestroyed()) {
                        focusedWindow.show();
                        focusedWindow.focus();
                    }
                });
            }

            return new Promise<PermissionUserResponse>((resolve) => {
                const timeoutSec = 300;
                const timeoutMs = timeoutSec * 1000;
                let settled = false;

                const cleanup = () => {
                    ipcMain.removeAllListeners('permission:response');
                };

                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        if (focusedWindow && !focusedWindow.isDestroyed()) {
                            focusedWindow.webContents.send('permission:dismiss', requestId);
                        }
                        logger.warn(`Permission prompt timed out after ${timeoutMs}ms, denying`);
                        resolve({ decision: 'deny', rememberScope: 'none', denyReason: 'timeout' });
                    }
                }, timeoutMs);

                const handler = (_event: any, respRequestId: string, response: any) => {
                    if (respRequestId !== requestId) return;
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    const decision = response.decision || 'deny';
                    resolve({
                        decision,
                        rememberScope: response.rememberScope || 'none',
                        selectedPrefixPattern: response.selectedPrefixPattern,
                        denyReason: decision === 'deny' ? 'user_denied' : undefined
                    });
                };

                ipcMain.on('permission:response', handler);

                focusedWindow.webContents.send('permission:request', requestId, {
                    requests: requests.map((r) => ({
                        resourceType: r.resourceType,
                        action: r.action,
                        resourcePath: r.resourcePath
                    })),
                    toolName,
                    prefixOptions,
                    timeoutSec,
                    taskId: taskInfo?.taskId ?? '',
                    taskName: taskInfo?.taskName ?? null
                });
            });
        } catch (err) {
            logger.warn(`Electron permission prompt failed, denying: ${err}`);
            return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
        }
    }
}
