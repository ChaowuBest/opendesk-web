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

import { showConfirmModal } from '../../../../renderer/components/confirmModal.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            case "'":
                return '&#39;';
            default:
                return char;
        }
    });
}

async function runConfirmedAction(onConfirm) {
    if (typeof onConfirm !== 'function') {
        return true;
    }

    const result = await onConfirm();
    return result ?? true;
}

function modalText(t, key, vars, fallback) {
    const translated = t?.(key, vars);
    if (translated && translated !== key) {
        return translated;
    }
    return fallback.replace(/\$\{(\w+)\}/g, (_match, name) => String(vars?.[name] ?? ''));
}

export async function showDeleteRootModal({ rootName, onConfirm, mountTarget, t } = {}) {
    const escapedRootName = escapeHtml(rootName);
    const confirmed = await showConfirmModal({
        icon: 'fa-trash-can',
        iconBg: 'color-mix(in srgb, #ef4444 14%, var(--od-bg-elevated, #ffffff))',
        iconColor: '#ef4444',
        title: modalText(t, 'renderer.filemgr.source.removeDialog.title', null, 'Remove scan path'),
        message: modalText(
            t,
            'renderer.filemgr.source.removeDialog.message',
            { name: escapedRootName },
            'Remove scan path “${name}”? This folder will no longer be scanned and its search data will be cleared. No files will be deleted.'
        ),
        confirmText: modalText(t, 'renderer.filemgr.source.removeDialog.confirm', null, 'Remove'),
        cancelText: modalText(t, 'renderer.filemgr.source.removeDialog.cancel', null, 'Cancel'),
        danger: true,
        mountTarget
    });

    if (!confirmed) {
        return false;
    }

    return runConfirmedAction(onConfirm);
}

export async function showProtectedWorkspaceModal({ mountTarget } = {}) {
    await showConfirmModal({
        icon: 'fa-circle-info',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        title: '当前工作空间不可删除',
        message: '当前工作空间不能在这里移除。请回到主页面切换工作空间。',
        confirmText: '知道了',
        cancelText: null,
        mountTarget
    });
    return false;
}

export async function showResetModal({ onConfirm, mountTarget } = {}) {
    const confirmed = await showConfirmModal({
        icon: 'fa-trash-can',
        iconBg: '#FEF2F2',
        iconColor: '#DC2626',
        title: '重置智能文件系统',
        message: '这会清除 AI 已建立的文件索引，之后会重新整理。<br>不会删除你的文件，也不会取消已选择的文件夹。',
        confirmText: '重置',
        cancelText: '取消',
        danger: true,
        mountTarget
    });

    if (!confirmed) {
        return false;
    }

    return runConfirmedAction(onConfirm);
}
