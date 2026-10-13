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

/**
 * bash/zsh 共用的环境变量：pip/npm 镜像 + cmd-pkgs 统一解释器前缀。
 * 与 shell 类型无关，插件 setup 时一次性写入 process.env，主进程与子进程继承。
 */
export function configureCommonEnvironment(opendeskDir) {
    process.env.PIP_INDEX_URL = HARMONY_PIP_INDEX_URL;
    process.env.PIP_TRUSTED_HOST = HARMONY_PIP_TRUSTED_HOST;
    process.env.PIP_ONLY_BINARY = HARMONY_PIP_ONLY_BINARY;
    process.env.npm_config_registry = HARMONY_NPM_REGISTRY;
    prependPath(opendeskDir ? [`${opendeskDir}/interpreters/cmd-pkgs/bin`] : []);
}

/** zsh 特有环境变量注入点，当前留空 */
export function injectZshEnv(env) {}

/**
 * bash 特有环境变量，写入 shell.env 钩子的本次子进程 env：--jitless
 * 鸿蒙平台：HNP node 的 V8 JIT 存在 native crash 问题，
 * --jitless 禁用 JIT 是 bash 会话中 HNP node 子进程（如 npm）的必要保护。
 */
export function injectBashEnv(env) {
    const nodeOptions = new Set((env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean));
    nodeOptions.add('--jitless');
    env.NODE_OPTIONS = [...nodeOptions].join(' ');
}
