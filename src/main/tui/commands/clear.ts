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

import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay } from '../components/notice.js';
import { t } from '../../../locale/index.js';

function generateChallengeCode(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

export function registerClearCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'clear',
        description: t('clear.description'),
        execute: async () => {
            const code = generateChallengeCode();
            const confirm = new ConfirmOverlay(tui, {
                title: t('confirm.delete.title'),
                message: t('confirm.delete.message'),
                confirmLabel: t('common.delete.all'),
                cancelLabel: t('common.cancel'),
                challenge: code,
                challengeHint: t('confirm.delete.challenge_hint', { code })
            });
            confirm.show(() => {
                tui.taskManagerState.clearAllTasks();
                tui.clearActiveTask();
            });
        }
    });
}
