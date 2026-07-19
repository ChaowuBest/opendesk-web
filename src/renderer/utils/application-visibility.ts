/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
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
