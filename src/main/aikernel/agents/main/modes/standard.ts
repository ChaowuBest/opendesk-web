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

import { createDefaultPermissionRules } from '../../../security/enforcer.js';
import type { ModeDecl } from '../../common.js';

/**
 * standard mode：默认工作模式，与原来行为一致
 */
export const MAIN_AGENT_STANDARD_MODE: ModeDecl = {
    id: 'standard',
    name: 'Standard',
    displayNameKey: 'mode.standard.name',
    description: 'Default mode: freely read and write inside the workspace, ask for confirmation outside it',
    descriptionKey: 'mode.standard.description',
    icon: '⚡',
    color: '#FFFFFF',
    permissionFactory: (workspace) => createDefaultPermissionRules(workspace)
};
