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
import { TaskSwitcher } from '../components/taskswitcher.js';
import type { KeyId } from '@earendil-works/pi-tui';
import { getShortcuts } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';

export function registerSwitchCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'switch',
        description: t('switch.description'),
        get shortcut(): KeyId {
            return getShortcuts().list_tasks as KeyId;
        },
        execute: async () => {
            const switcher = new TaskSwitcher(tui);
            switcher.show();
        }
    });
}
