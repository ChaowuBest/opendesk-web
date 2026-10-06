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
 * 下载/传输工具策略（curl/wget，standard 模式）。
 *
 * 官方文档验证的 rc 查找顺序：
 * - curl：$CURL_HOME/.curlrc → {XDG_CONFIG}/curlrc → {home}/.curlrc（Windows
 *   另查 %APPDATA%/.curlrc 与 _curlrc 别名）；
 * - wget：全局 etc/wgetrc → $WGETRC → {home}/.wgetrc。
 *
 * 凭据边界：~/.netrc（明文机器凭据）已有 ask 保护（git 策略与敏感清单双覆盖）；
 * .curlrc/.wgetrc 若写入 Authorization header/http_password 即为凭据文件——
 * 【待收紧】当前从宽放行（curl 高频读 rc），统一审视时评估按行审查或 ask。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** curl/wget 运行时读放行（rc 配置）。 */
const TRANSFER_RUNTIME_READ_PATTERNS = [
    '{home}/.curlrc',
    '{home}/.wgetrc',
    '{home}/.config/curl/curlrc',
    '{home}/AppData/Roaming/.curlrc'
];

export function createTransferPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(TRANSFER_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}
