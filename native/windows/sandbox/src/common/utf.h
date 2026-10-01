/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <windows.h>
#include <string>

namespace sbx {

// UTF-8 <-> UTF-16 转换（配置文件/策略/日志按 UTF-8 处理）。
std::string wideToUtf8(const std::wstring& w);
std::wstring utf8ToWide(const char* bytes, size_t len);

// ANSI 代码页 -> UTF-16（A 版 Win32 API 的 lpFileName 等参数转换；
// -1 自动含结尾 null，调用方传入以 null 结尾的窄字符串）。
// 失败（非法/空输入）返回空串。
std::wstring ansiToWide(const char* s);

// ASCII 窄化：仅用于 read/write/execute/all 等 ASCII 关键字，
// 非 ASCII 字符取低字节（与 std::string(iter, iter) 旧行为一致）。
std::string narrowAscii(const std::wstring& w);

} // namespace sbx