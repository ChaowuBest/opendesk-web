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

import type { ModeDecl } from '../../common.js';
import { createCriticalPathRules } from '../../../../utils/permissionRules.js';

export const KNOWLEDGE_AGENT_DEFAULT_MODE: ModeDecl = {
    id: 'default',
    name: 'default',
    description: '只检索知识库索引并归纳证据',
    icon: '📚',
    color: '#3B82F6',
    permissionFactory: () => createCriticalPathRules(),
    allowedTools: ['semanticSearch', 'attemptCompletion']
};
