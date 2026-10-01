/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "utf.h"

namespace sbx {

std::string wideToUtf8(const std::wstring& w)
{
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s((size_t)n, '\0');
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring utf8ToWide(const char* bytes, size_t len)
{
    if (len == 0) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, nullptr, 0);
    std::wstring w((size_t)n, L'\0');
    if (n > 0) MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, &w[0], n);
    return w;
}

std::wstring ansiToWide(const char* s)
{
    if (!s || !*s) return std::wstring();
    int n = MultiByteToWideChar(CP_ACP, 0, s, -1, nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring w((size_t)n - 1, L'\0');
    MultiByteToWideChar(CP_ACP, 0, s, -1, &w[0], n);
    return w;
}

std::string narrowAscii(const std::wstring& w)
{
    std::string s;
    s.reserve(w.size());
    for (wchar_t c : w) s.push_back((char)c);
    return s;
}

} // namespace sbx