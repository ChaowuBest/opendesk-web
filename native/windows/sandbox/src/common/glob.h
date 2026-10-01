/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>

namespace sbx {

// 策略路径 glob 匹配（与 C# 版 GlobToRegex 语义等价）：
//   `**` 跨层级（匹配任意字符含 '/'）；`*` 单层级（不匹配 '/'）；`?` 单字符（不匹配 '/'）
//   `/dir/**` 同时匹配 `/dir` 本身；`/**` 匹配整卷；大小写不敏感。
// pattern 为虚拟路径（以 '/' 开头，正斜杠）。
bool globMatch(const std::wstring& pattern, const std::wstring& vpath);

// 返回规则的字面前缀（首个通配符之前的小写部分），用于热路径预筛。
std::wstring globLiteralPrefix(const std::wstring& pattern);

} // namespace sbx
