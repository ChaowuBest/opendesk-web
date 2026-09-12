/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

export const HARMONYBREW_BIN_DIR = '/storage/Users/currentUser/.harmonybrew/bin';
export const HARMONYBREW_BIN_PATH = `${HARMONYBREW_BIN_DIR}/brew`;

export const HARMONY_PIP_INDEX_URL = 'https://pypi.repo.openharmony.cn/artifactory/openharmony-pypi/simple';
export const HARMONY_PIP_TRUSTED_HOST = 'pypi.repo.openharmony.cn';
export const HARMONY_PIP_ONLY_BINARY = ':all:';
export const HARMONY_NPM_REGISTRY = 'https://npm.cnb.cool/OpenHarmonyPCDeveloper/npm/-/packages/';

function prependPath(entries) {
    const current = process.env.PATH ?? '';
    const existing = new Set(current.split(':').filter(Boolean));
    process.env.PATH = [...entries.filter((entry) => !existing.has(entry)), ...existing].join(':');
}

function configureCommonEnvironment() {
    process.env.PIP_INDEX_URL = HARMONY_PIP_INDEX_URL;
    process.env.PIP_TRUSTED_HOST = HARMONY_PIP_TRUSTED_HOST;
    process.env.PIP_ONLY_BINARY = HARMONY_PIP_ONLY_BINARY;
    process.env.npm_config_registry = HARMONY_NPM_REGISTRY;
}

export function configureZshEnvironment(opendeskDir) {
    configureCommonEnvironment();
    prependPath([...(opendeskDir ? [`${opendeskDir}/interpreters/cmd-pkgs/bin`] : []), HARMONYBREW_BIN_DIR]);
}

export function configureBashEnvironment(opendeskDir) {
    configureCommonEnvironment();
    prependPath(opendeskDir ? [`${opendeskDir}/interpreters/cmd-pkgs/bin`] : []);
    const nodeOptions = new Set((process.env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean));
    // 鸿蒙平台：HNP node 的 V8 JIT 存在 native crash 问题，
    // --jitless 禁用 JIT 是所有 HNP node 子进程（包括 npm、agent-gate、agent-moss）的必要保护。
    // agent-moss 在 --jitless 下性能受限，但这是 OHOS 上唯一稳定的运行方式。
    nodeOptions.add('--jitless');
    process.env.NODE_OPTIONS = [...nodeOptions].join(' ');
}
