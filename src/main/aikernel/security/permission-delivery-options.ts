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

import { t } from '../../../locale/index.js';
import type { PermissionDeliveryOption } from '../interaction/delivery.js';

export function createPermissionDeliveryOptions(
    toolName: string,
    prefixOptions: readonly { label: string; pattern: string }[]
): PermissionDeliveryOption[] {
    return [
        {
            optionId: 'allow-once',
            kind: 'allowOnce',
            label: t('acp.permission.allow_once'),
            response: { decision: 'allow', rememberScope: 'none' }
        },
        ...prefixOptions.map((prefix, index) => ({
            optionId: `allow-prefix-${index}`,
            kind: 'allowAlwaysPrefix' as const,
            label: t('acp.permission.allow_always', { scope: prefix.label }),
            prefix: prefix.pattern,
            response: {
                decision: 'allow' as const,
                rememberScope: 'prefix' as const,
                selectedPrefixPattern: prefix.pattern
            }
        })),
        {
            optionId: 'allow-type',
            kind: 'allowAlwaysType',
            label: t('acp.permission.allow_always', { scope: toolName }),
            response: { decision: 'allow', rememberScope: 'type' }
        },
        {
            optionId: 'reject-once',
            kind: 'rejectOnce',
            label: t('acp.permission.reject_once'),
            response: { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
        }
    ];
}
