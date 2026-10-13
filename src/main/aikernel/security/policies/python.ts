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
 * Python 运行时策略（python3/python/pip/pip3，standard 模式）。
 *
 * 三平台实测读路径画像（WSL strace / OHOS / macOS Apple Python + Homebrew）：
 *   - 用户站点包：~/.local/lib/python{X.Y}/site-packages（pip install --user 的
 *     落点；`引用全局和用户层级的包` 的用户层级即此目录）。Windows 为
 *     ~/AppData/Roaming/Python/Python{XY}/site-packages（PEP 370）。
 *   - pip 下载/构建缓存：沙箱内重定向到 ~/.cache/opendesk-sandbox/pip；同时
 *     保留三平台宿主默认缓存路径的读取兼容。
 *   - venv 探测：pyvenv.cfg 在 venv 根（工作空间内居多，工作空间外 venv 由
 *     兜底 ask 管控——冷门场景，不为它放行）。
 *
 * 系统与发行版站点包（/usr/lib/python3.X/site-packages、/usr/local/lib/python3.X、
 * Homebrew /opt/homebrew/lib/python3.X）已由 PATH 与系统目录读放行覆盖大半；
 * 剩余精确前缀在此声明，避免散弹式弹窗。
 *
 * 凭据边界：Python 无独立凭据文件（token 一般在各工具自身配置，如 ~/.pypirc）。
 * ~/.pypirc（PyPI 上传 token）ask 保护。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** PyPI 凭据（上传 token）：读 ask 保护。 */
const PYTHON_CREDENTIAL_ASK_PATTERNS = ['{home}/.pypirc'];

/**
 * Python 运行时读放行（glob 覆盖任意小版本）：
 * - 用户站点包（pip install --user 落点，`引用用户层级的包` 的读取需求）；
 * - pip 缓存（OpenDesk 重定向目录及三平台宿主默认读取路径）。
 */
function pythonRuntimeReadPatterns(): string[] {
    return [
        // 盘根 pyvenv.cfg 探测（解释器逐级向上找 venv 标记）不在此声明：不存在
        // 路径的读由沙箱判定层透传（ENOENT 与宿主一致），存在时也只是 venv 标记。
        '{home}/.local/lib/python*/site-packages',
        '{home}/.local/lib/python*/site-packages/**',
        '{home}/Library/Python/*/lib/python/site-packages',
        '{home}/Library/Python/*/lib/python/site-packages/**',
        '{home}/.cache/opendesk-sandbox/pip/**',
        '{home}/.cache/opendesk-sandbox/pycache/**',
        '{home}/.cache/pip/**',
        '{home}/Library/Caches/pip/**',
        '{home}/AppData/Local/pip/cache/**',
        // Windows PEP 370 用户站点包（Roaming/Python/Python{XY}/site-packages）
        '{home}/AppData/Roaming/Python/*/site-packages',
        '{home}/AppData/Roaming/Python/*/site-packages/**'
    ];
}

export function createPythonPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(PYTHON_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        ...homeRules(pythonRuntimeReadPatterns(), 'read', 'allow', homeDir)
    ];
}
