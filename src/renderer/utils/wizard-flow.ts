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

/**
 * 决定向导第二步展示的视图：
 * - 选择个人/企业账号（且账号能力可用）时展示账号登录，登录完成后由调用方直接进入完成页，跳过模型配置；
 * - 不登录或账号能力不可用时仍是原来的模型配置。
 */
export function resolveWizardStep2View(
    loginChoice: WizardLoginChoice,
    accountFeatureEnabled: boolean
): WizardStep2View {
    if (!accountFeatureEnabled || loginChoice === 'nologin') {
        return 'model-config';
    }
    return loginChoice === 'enterprise' ? 'enterprise-login' : 'personal-login';
}
