/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "log.h"

#include <cstdarg>
#include <vector>

namespace sbx {

CRITICAL_SECTION Log::s_lock;
HANDLE Log::s_file = INVALID_HANDLE_VALUE;
bool Log::g_verbose = false;
bool Log::g_quiet = false;

static CRITICAL_SECTION& lockInstance()
{
    static CRITICAL_SECTION lock = [] {
        CRITICAL_SECTION cs;
        InitializeCriticalSection(&cs);
        return cs;
    }();
    return lock;
}

// 变参格式化到 std::wstring。注意：不能先 _vscwprintf 测长度再 _vsnwprintf_s
// 两遍——_vscwprintf 会把内容输出到 stdout（违反"日志绝不写 stdout"），且
// va_list 在两次调用间不可复用。用 va_copy + 动态缓冲单遍写入。
static std::wstring vformat(const wchar_t* fmt, va_list ap)
{
    std::vector<wchar_t> buf(256);
    for (int attempt = 0; attempt < 4; attempt++) {
        va_list ap2;
        va_copy(ap2, ap);
        int n = _vsnwprintf_s(buf.data(), buf.size(), _TRUNCATE, fmt, ap2);
        va_end(ap2);
        if (n >= 0) return std::wstring(buf.data(), (size_t)n);
        buf.resize(buf.size() * 8);
    }
    return std::wstring();
}

void Log::setFile(const std::wstring& path)
{
    if (s_file != INVALID_HANDLE_VALUE) {
        CloseHandle(s_file);
        s_file = INVALID_HANDLE_VALUE;
    }
    s_file = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
}

void Log::info(const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::wstring buf = vformat(fmt, ap);
    va_end(ap);
    write(0, L"[INF]", buf);
}

void Log::warn(const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::wstring buf = vformat(fmt, ap);
    va_end(ap);
    write(1, L"[WRN]", buf);
}

void Log::error(const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::wstring buf = vformat(fmt, ap);
    va_end(ap);
    write(2, L"[ERR]", buf);
}

void Log::debug(const wchar_t* fmt, ...)
{
    if (!g_verbose)
        return;
    va_list ap;
    va_start(ap, fmt);
    std::wstring buf = vformat(fmt, ap);
    va_end(ap);
    write(3, L"[DBG]", buf);
}

// 策略判定日志通道：只写文件、不写 stderr、不受 verbose 约束。hook 子进程内
// 每次访问判定都经此落盘（事故后可归因"哪个 pid、哪个路径、哪条规则、放行还是拒绝"）。
static void stampAndEncode(const std::wstring& msg, std::string& lineUtf8)
{
    wchar_t timeBuf[32];
    SYSTEMTIME st;
    GetLocalTime(&st);
    swprintf_s(timeBuf, L"%04d-%02d-%02d %02d:%02d:%02d.%03d",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

    std::wstring line = std::wstring(timeBuf) + L" " + msg + L"\r\n";
    int n = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), nullptr, 0, nullptr, nullptr);
    lineUtf8.resize((size_t)n);
    WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), &lineUtf8[0], n, nullptr, nullptr);
}

void Log::policy(const wchar_t* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::wstring buf = vformat(fmt, ap);
    va_end(ap);

    CRITICAL_SECTION& lock = lockInstance();
    EnterCriticalSection(&lock);
    if (s_file != INVALID_HANDLE_VALUE) {
        std::string lineUtf8;
        stampAndEncode(L"[POLICY] " + buf, lineUtf8);
        DWORD written = 0;
        WriteFile(s_file, lineUtf8.data(), (DWORD)lineUtf8.size(), &written, nullptr);
    }
    LeaveCriticalSection(&lock);
}

void Log::write(int level, const wchar_t* prefix, const std::wstring& msg)
{
    wchar_t timeBuf[32];
    SYSTEMTIME st;
    GetLocalTime(&st);
    swprintf_s(timeBuf, L"%04d-%02d-%02d %02d:%02d:%02d.%03d",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

    std::wstring line = std::wstring(timeBuf) + L" " + prefix + L" " + msg + L"\r\n";
    std::string lineUtf8;
    {
        int n = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), nullptr, 0, nullptr, nullptr);
        lineUtf8.resize((size_t)n);
        WideCharToMultiByte(CP_UTF8, 0, line.c_str(), (int)line.size(), &lineUtf8[0], n, nullptr, nullptr);
    }

    CRITICAL_SECTION& lock = lockInstance();
    EnterCriticalSection(&lock);
    if (s_file != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(s_file, lineUtf8.data(), (DWORD)lineUtf8.size(), &written, nullptr);
    }
    if (!g_quiet && level >= 1) {
        HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
        if (err != INVALID_HANDLE_VALUE && err != nullptr) {
            DWORD written = 0;
            // stderr 是控制台时用 WriteConsoleW 输出 UTF-16 原文：控制台按 Unicode
            // 渲染，不受代码页（GBK/UTF-8）影响，中文不再乱码。管道/文件（重定向、
            // 日志查看器）保持 UTF-8 字节，与既有日志消费方兼容。
            DWORD mode = 0;
            if (GetConsoleMode(err, &mode)) {
                WriteConsoleW(err, line.c_str(), (DWORD)line.size(), &written, nullptr);
            } else {
                WriteFile(err, lineUtf8.data(), (DWORD)lineUtf8.size(), &written, nullptr);
            }
        }
    }
    LeaveCriticalSection(&lock);
}

} // namespace sbx
