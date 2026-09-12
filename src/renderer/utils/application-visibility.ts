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
    bundleName?: string;
    showIcon?: boolean;
    isExperimental?: boolean;
}

export interface ExperimentalFeatureSettings {
    applications?: Record<string, boolean>;
}

export function isExperimentalApplicationEnabled(
    application: Pick<ApplicationMenuItem, 'bundleName' | 'isExperimental'>,
    experimentalFeatures: ExperimentalFeatureSettings | null | undefined
): boolean {
    if (!application.isExperimental) return true;
    const bundleName = application.bundleName;
    return bundleName ? experimentalFeatures?.applications?.[bundleName] === true : false;
}

export function isApplicationVisibleInMenu(
    application: ApplicationMenuItem,
    experimentalFeatures: ExperimentalFeatureSettings | null | undefined
): boolean {
    if (application.showIcon === false) return false;
    return isExperimentalApplicationEnabled(application, experimentalFeatures);
}
