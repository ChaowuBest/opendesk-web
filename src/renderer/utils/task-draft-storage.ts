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
 * 任务输入草稿的持久化。
 *
 * 任务视图在后台超时释放（或应用重启）时会销毁输入控件，草稿文本与图片附件
 * 只存在于控件内存中。这里以 localStorage 按 task_id 持久化，使控件释放后
 * 重新打开任务时草稿可恢复。
 *
 * 配额策略：localStorage 约 5-10MB 且各任务共享。图片附件以 dataUrl 存储、
 * 体积可能很大，因此先尝试完整保存；配额不足时降级为仅保存文本；文本本身
 * 超限时放弃保存（控件存活期间草稿仍在内存中，不受影响）。
 */

export interface PersistedTaskDraft {
    text: string;
    images: Array<{ dataUrl: string; name: string }>;
    /** 附件文件路径（瞬态引用，恢复时按当前文件系统重新校验，失效路径会被过滤） */
    filePaths: string[];
}

const KEY_PREFIX = 'opendesk:task-draft:';

function getStorage(): Storage | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage;
    } catch {
        return null;
    }
}

function draftKey(taskId: string): string {
    return `${KEY_PREFIX}${taskId}`;
}

export function isTaskDraftEmpty(draft: PersistedTaskDraft): boolean {
    return draft.text.trim().length === 0 && draft.images.length === 0 && draft.filePaths.length === 0;
}

export function loadTaskDraft(taskId: string): PersistedTaskDraft | null {
    const storage = getStorage();
    if (!storage || !taskId) return null;
    let raw: string | null = null;
    try {
        raw = storage.getItem(draftKey(taskId));
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedTaskDraft> | null;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.text !== 'string') return null;
        const images = Array.isArray(parsed.images)
            ? parsed.images.filter(
                  (img): img is { dataUrl: string; name: string } =>
                      Boolean(img) &&
                      typeof (img as { dataUrl?: unknown }).dataUrl === 'string' &&
                      typeof (img as { name?: unknown }).name === 'string'
              )
            : [];
        // 旧版本持久化数据没有 filePaths 字段，视为空数组，保证向后兼容
        const filePaths = Array.isArray(parsed.filePaths)
            ? parsed.filePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : [];
        return { text: parsed.text, images, filePaths };
    } catch {
        return null;
    }
}

export function saveTaskDraft(taskId: string, draft: PersistedTaskDraft): void {
    const storage = getStorage();
    if (!storage || !taskId) return;
    try {
        if (isTaskDraftEmpty(draft)) {
            storage.removeItem(draftKey(taskId));
            return;
        }
        try {
            storage.setItem(draftKey(taskId), JSON.stringify(draft));
        } catch {
            // 配额不足：丢弃图片附件（dataUrl 体积大），仅保留文本与文件路径（短字符串）
            if (draft.text.trim().length > 0) {
                storage.setItem(
                    draftKey(taskId),
                    JSON.stringify({ text: draft.text, images: [], filePaths: draft.filePaths })
                );
            }
        }
    } catch {
        // 文本本身超限或存储不可用：放弃本次持久化，内存中的草稿不受影响
    }
}

export function clearTaskDraft(taskId: string): void {
    const storage = getStorage();
    if (!storage || !taskId) return;
    try {
        storage.removeItem(draftKey(taskId));
    } catch {
        /* ignore */
    }
}
