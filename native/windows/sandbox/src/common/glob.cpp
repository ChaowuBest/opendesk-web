/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "glob.h"

namespace sbx {

static bool globRec(const wchar_t* p, const wchar_t* s)
{
    if (*p == L'\0') return *s == L'\0';
    if (*p == L'*') {
        if (p[1] == L'*') {
            // `**` 匹配任意字符（含 '/'），贪婪展开 + 回溯
            return globRec(p + 2, s) || (*s != L'\0' && globRec(p, s + 1));
        }
        // `*` 不匹配 '/'
        return globRec(p + 1, s) || (*s != L'\0' && *s != L'/' && globRec(p, s + 1));
    }
    if (*p == L'?') {
        return *s != L'\0' && *s != L'/' && globRec(p + 1, s + 1);
    }
    return towlower(*p) == towlower(*s) && globRec(p + 1, s + 1);
}

bool globMatch(const std::wstring& pattern, const std::wstring& vpath)
{
    if (pattern.empty()) return false;

    // /dir/** 约定同时匹配 /dir 本身：先匹配"剥离 /** 后的 base"
    size_t pos = pattern.size() >= 3 ? pattern.size() - 3 : std::wstring::npos;
    if (pos != std::wstring::npos && pattern.compare(pos, 3, L"/**") == 0) {
        std::wstring base = pattern.substr(0, pos);
        if (base.empty()) base = L"/";
        if (globRec(base.c_str(), vpath.c_str())) return true;
        // 也要匹配 /dir/...（由主模式处理）
    }
    return globRec(pattern.c_str(), vpath.c_str());
}

std::wstring globLiteralPrefix(const std::wstring& pattern)
{
    size_t wc = pattern.find_first_of(L"*?");
    std::wstring lit = wc == std::wstring::npos ? pattern : pattern.substr(0, wc);
    std::wstring lower;
    lower.reserve(lit.size());
    for (wchar_t c : lit) lower.push_back((wchar_t)towlower(c));
    return lower;
}

} // namespace sbx
