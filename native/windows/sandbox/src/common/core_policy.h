/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */
#pragma once

#include <string>
#include <vector>

namespace sbx {

// 一条从共享 core 解析出的策略规则（path 已转 UTF-16，虚拟路径形态）。
struct CorePolicyRule {
    std::wstring path;   // 虚拟路径 glob（/ 开头正斜杠，** / * / ? 语义与 core 一致）
    std::string access;  // "read" / "write" / "execute" / "all"
    std::string perm;    // "allow" / "ask" / "deny"
};

struct CoreAskConfig {
    std::wstring endpoint;
    std::wstring token;
    long long timeoutMs = 0;
    long long cacheTtlSeconds = 0;
    long long grantTtlSeconds = 0;
};

// 共享 core（native/openharmony/sandbox/src，与 Linux/OpenHarmony/macOS 同一份
// C 源码）的桥接层：TOML 解析与路径 glob 匹配不再由 Windows 侧维护第二份实现。
//
// core 是 UTF-8 / char 世界；Windows hook 层是 UTF-16 / wchar_t。本层负责转换。
// 大小写：Windows 路径大小写不敏感——core 的匹配是大小写敏感的，桥接层把
// pattern 与 vpath 都折叠为小写后再交给 core（规则语义与既有 Windows 行为一致）。

// 解析策略 TOML。成功返回 true 并填充 rules/ask/defaultPerm；
// 失败返回 false 并填充 error（UTF-16，可直接展示）。
bool coreParsePolicyToml(const std::wstring& utf16Text,
                         std::vector<CorePolicyRule>& rules,
                         CoreAskConfig& ask,
                         std::string& defaultPerm,   // "allow" / "deny"
                         std::wstring& error);

// 策略路径 glob 匹配（大小写不敏感，经 core 的 dbox_glob_match）。
bool coreGlobMatch(const std::wstring& pattern, const std::wstring& vpath);

// 规则的字面前缀（首个通配符之前的小写部分），用于热路径预筛。
// 纯词法操作，本地实现（core 未导出等价函数）。
std::wstring coreGlobLiteralPrefix(const std::wstring& pattern);

} // namespace sbx