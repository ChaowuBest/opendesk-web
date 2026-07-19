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

import { ApplicationRegistry } from '../../applications/registry.js';
import { DashboardOverlay, type MailAccountInfo } from '../components/dashboard.js';
import { logger } from '../../utils/logger.js';
import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';

async function fetchMailAccounts(): Promise<MailAccountInfo[]> {
    try {
        const [accountsRes, countsRes] = await Promise.allSettled([
            ApplicationRegistry.callWorker('mailbox', 'getAccountList'),
            ApplicationRegistry.callWorker('mailbox', 'getAllNewEmailCounts')
        ]);
        const accounts: any[] =
            accountsRes.status === 'fulfilled' && accountsRes.value?.status === 'ok'
                ? accountsRes.value.data || []
                : [];
        const counts: Record<string, number> =
            countsRes.status === 'fulfilled' && countsRes.value?.status === 'ok' ? countsRes.value.data || {} : {};
        return accounts.map((a: any) => ({
            email: a.email,
            name: a.name,
            active: a.active,
            newCount: counts[a.email] || 0
        }));
    } catch {
        return [];
    }
}

export function registerDashboardCommand(tui: OpenDeskTUI): void {
    const showDashboard = async () => {
        try {
            const [todosResult, mailAccounts] = await Promise.all([
                ApplicationRegistry.callWorker('todomgr', 'listGlobalTodos', 'all'),
                fetchMailAccounts()
            ]);
            const todos = todosResult?.data || [];
            const tasks = tui.taskManagerState.tasks;

            let channelStates: any[] = [];
            const channelsApp = ApplicationRegistry.getApplication('channelmgr');
            if (channelsApp && 'getChannelStates' in channelsApp) {
                channelStates = (channelsApp as any).getChannelStates();
            }

            new DashboardOverlay(tui, {
                globalTodos: todos,
                tasks,
                channelStates,
                mailAccounts
            }).show();
        } catch (err) {
            logger.error(`Failed to open dashboard: ${err}`);
        }
    };

    tui.commandRegistry.register({
        name: 'dashboard',
        description: t('dashboard.description'),
        execute: async (args: string) => {
            if (args.trim() === 'bar') {
                tui.dashboardBar.toggleVisible();
            } else {
                await showDashboard();
            }
        },
        getArgumentCompletions: (prefix: string) => {
            const opts = [{ value: 'bar', label: 'bar', description: t('dashboard.bar.description') }];
            return opts.filter((o) => o.value.startsWith(prefix));
        }
    });
}
