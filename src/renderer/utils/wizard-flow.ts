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

export type WizardLoginChoice = 'opendesk' | 'enterprise' | 'nologin';
export type WizardStep2View = 'personal-login' | 'enterprise-login' | 'model-config';

export function resolveWizardStep2View(
    loginChoice: WizardLoginChoice,
    accountLoginComplete: boolean,
    accountFeatureEnabled: boolean
): WizardStep2View {
    if (!accountFeatureEnabled || loginChoice === 'nologin' || accountLoginComplete) {
        return 'model-config';
    }
    return loginChoice === 'enterprise' ? 'enterprise-login' : 'personal-login';
}
