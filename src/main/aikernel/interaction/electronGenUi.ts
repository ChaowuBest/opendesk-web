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
 * askUI 的 Electron 交互通道。
 *
 * 组件直接渲染在对话里，等待中的请求 id 随工具调用的渲染结果下发；用户操作后渲染进程
 * invoke genui:respond(requestId, response)，这里按组件 schema 校验后结算对应请求。
 * 所有任务共用一张等待表和一个 IPC 处理器，每个 provider 只负责取消自己发起的请求。
 */

import type { GenUiOutcome, GenUiProvider, GenUiRequest } from './genui.js';
import { GENUI_RESPOND_CHANNEL, parseGenUiResponse } from '../../../common/genui/catalog.js';
import { electron } from '../../../utils/electron.js';
import { logger } from '../../utils/logger.js';
import { showTaskNotification, clearPendingOpenTasks } from '../../utils/system-notification.js';
import { t } from '../../../locale/index.js';

const REQUEST_TIMEOUT_MS = 30 * 60_000;

export type GenUiRespondResult = { ok: true } | { ok: false; error: 'expired' | 'invalid'; message?: string };

interface PendingRequest {
    request: GenUiRequest;
    owner: ElectronGenUiProvider;
    resolve: (outcome: GenUiOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();
let ipcInstalled = false;

function settle(requestId: string, outcome: GenUiOutcome): boolean {
    const pending = pendingRequests.get(requestId);
    if (!pending) return false;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    clearPendingOpenTasks(pending.request.taskId);
    pending.resolve(outcome);
    return true;
}

/** 处理渲染进程的回传；导出供测试直接调用。 */
export function respondToGenUiRequest(requestId: unknown, response: unknown): GenUiRespondResult {
    if (typeof requestId !== 'string') return { ok: false, error: 'invalid', message: 'requestId must be a string' };
    const pending = pendingRequests.get(requestId);
    if (!pending) return { ok: false, error: 'expired' };
    const checked = parseGenUiResponse(pending.request.component, pending.request.props, response);
    if (!checked.success) {
        logger.warn(`genui: rejected response for ${requestId}: ${checked.error}`);
        return { ok: false, error: 'invalid', message: checked.error };
    }
    settle(requestId, { response: checked.response });
    return { ok: true };
}

export function installGenUiIpc(): void {
    if (ipcInstalled) return;
    ipcInstalled = true;
    electron().ipcMain.handle(GENUI_RESPOND_CHANNEL, (_event, requestId: unknown, response: unknown) =>
        respondToGenUiRequest(requestId, response)
    );
}

export function hasPendingGenUiRequest(requestId: string): boolean {
    return pendingRequests.has(requestId);
}

export class ElectronGenUiProvider implements GenUiProvider {
    constructor() {
        installGenUiIpc();
    }

    request(request: GenUiRequest): Promise<GenUiOutcome> {
        showTaskNotification({
            title: t('notification.askUser.title'),
            body: request.title || t('notification.askUser.body'),
            taskId: request.taskId
        });
        return new Promise<GenUiOutcome>((resolve) => {
            const timer = setTimeout(() => {
                logger.warn(`genui: request ${request.requestId} timed out`);
                settle(request.requestId, { cancelled: true });
            }, REQUEST_TIMEOUT_MS);
            pendingRequests.set(request.requestId, { request, owner: this, resolve, timer });
        });
    }

    cancelCurrent(): void {
        for (const [requestId, pending] of [...pendingRequests]) {
            if (pending.owner === this) settle(requestId, { cancelled: true });
        }
    }
}
