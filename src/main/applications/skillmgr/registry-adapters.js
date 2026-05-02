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

/**
 * 第三方 Skill Registry 适配器（兼容层）
 *
 * 现已委托给 registry/ 目录下的各 SkillRegistryBase 子类实现。
 * 本文件保留导出接口以兼容现有调用方（worker、TUI、util 等）。
 */

import {
    allRegistries,
    getRegistry,
    getRegistriesInfo as _getRegistriesInfo,
    searchRegistry as _searchRegistry,
    getInstallMethod as _getInstallMethod,
    parseInstallUrl as _parseInstallUrl
} from './registry/index.js';

const CLAWHUB_INSTALL_PREFIX = 'clawhub:';
const MATRIX_INSTALL_PREFIX = 'matrix:';
const MODELSCOPE_INSTALL_PREFIX = 'modelscope:';
const SKILLHUB_INSTALL_PREFIX = 'skillhub:';

function parseClawHubInstallUrl(installUrl) {
    const reg = getRegistry('clawhub');
    return reg ? reg.parseInstallUrl(installUrl) : null;
}

function parseMatrixInstallUrl(installUrl) {
    const reg = getRegistry('matrix');
    return reg ? reg.parseInstallUrl(installUrl) : null;
}

function parseModelScopeInstallUrl(installUrl) {
    const reg = getRegistry('modelscope');
    return reg ? reg.parseInstallUrl(installUrl) : null;
}

function parseSkillHubInstallUrl(installUrl) {
    const reg = getRegistry('skillhub');
    return reg ? reg.parseInstallUrl(installUrl) : null;
}

async function searchRegistry(registryId, opts = {}) {
    return _searchRegistry(registryId, opts);
}

function getInstallMethod(installUrl) {
    return _getInstallMethod(installUrl);
}

function getRegistriesInfo() {
    return _getRegistriesInfo();
}

export const RegistryAdapters = {
    searchRegistry,
    getInstallMethod,
    getRegistriesInfo,
    parseClawHubInstallUrl,
    parseMatrixInstallUrl,
    parseModelScopeInstallUrl,
    parseSkillHubInstallUrl,
    allRegistries,
    getRegistry,
    CLAWHUB_INSTALL_PREFIX,
    MATRIX_INSTALL_PREFIX,
    MODELSCOPE_INSTALL_PREFIX,
    SKILLHUB_INSTALL_PREFIX
};
