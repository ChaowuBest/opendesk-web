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

// 管理进程日志：默认写入 stderr 与 --log-file（OpenDesk 总传 --log-file）。
// stdout 保留给子进程输出透传，绝不写日志。
// hook DLL 内嵌时该日志写入 stderr（策略/ask 诊断），可用环境变量关闭。
class Log {
public:
    static void setFile(const std::wstring& path);
    static void setVerbose(bool v) { g_verbose = v; }
    static bool verbose() { return g_verbose; }

    static void info(const wchar_t* fmt, ...);
    static void warn(const wchar_t* fmt, ...);
    static void error(const wchar_t* fmt, ...);
    static void debug(const wchar_t* fmt, ...);   // 仅 verbose

    static void setQuiet(bool q) { g_quiet = q; }

private:
    static void write(int level, const wchar_t* prefix, const std::wstring& msg);
    static CRITICAL_SECTION s_lock;
    static HANDLE s_file;
    static bool g_verbose;
    static bool g_quiet;
};

} // namespace sbx
