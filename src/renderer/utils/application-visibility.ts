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

export interface ApplicationMenuItem {
    showIcon?: boolean;
    isExperimental?: boolean;
}

export function isExperimentalApplicationEnabled(
    application: Pick<ApplicationMenuItem, 'isExperimental'>,
    experimentalFeatureEnabled: boolean
): boolean {
    return !application.isExperimental || experimentalFeatureEnabled;
}

export function isApplicationVisibleInMenu(
    application: ApplicationMenuItem,
    experimentalFeatureEnabled: boolean
): boolean {
    if (application.showIcon === false) return false;
    return isExperimentalApplicationEnabled(application, experimentalFeatureEnabled);
}
