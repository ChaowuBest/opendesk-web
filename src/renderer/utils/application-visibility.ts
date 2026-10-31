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

/**
 * 与主进程 Setting 的 debug.experimental_features schema 对齐（按 renderer 消费面裁剪），
 * 各开关都可能缺省。
 */
export interface ExperimentalFeatureSettings {
    applications?: Record<string, boolean>;
    account?: boolean;
    immersive_desktop?: boolean;
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
