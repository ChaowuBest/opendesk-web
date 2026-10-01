/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "glob.h"

#include <cwctype>
#include <vector>

namespace sbx {

// 线性 glob 匹配（DP，严格 O(n*m)，无递归/无指数回溯）：
//   `**` 匹配任意字符（含 '/'）；`*` 不匹配 '/'；`?` 匹配单个非 '/' 字符。
// 原递归回溯实现在多 `*` 模式 + 长路径下呈指数复杂度（实测 14 个 `*a` 段 +
// 52 字符路径即可卡死），可被不可信子进程构造路径对 hook 线程 DoS，且深递归
// 有栈溢出风险。DP 将最坏复杂度压到 O(n*m)。
static bool globMatchLinear(const wchar_t* p, const wchar_t* s)
{
    size_t np = 0;
    for (const wchar_t* q = p; *q; q++) np++;
    size_t ns = 0;
    for (const wchar_t* q = s; *q; q++) ns++;

    // dp[j] = 模式前 i 个字符是否匹配 s 前 j 个字符（滚动数组）
    std::vector<char> dp(ns + 1, 0), next(ns + 1, 0);
    dp[0] = 1;
    for (size_t i = 1; i <= np; i++) {
        wchar_t c = p[i - 1];
        std::fill(next.begin(), next.end(), 0);
        if (c == L'*') {
            // `**`（连续两个及以上 `*` 折叠）跨 `/`；单个 `*` 不跨 `/`
            const bool isDouble = (i >= 2 && p[i - 2] == L'*');
            for (size_t j = 0; j <= ns; j++) {
                if (dp[j]) {                       // 吞 0 个
                    next[j] = 1;
                } else if (j > 0 && next[j - 1]) { // 吞 1 个（连续）
                    if (isDouble || s[j - 1] != L'/') next[j] = 1;
                }
            }
        } else if (c == L'?') {
            for (size_t j = 1; j <= ns; j++)
                if (dp[j - 1] && s[j - 1] != L'/') next[j] = 1;
        } else {
            for (size_t j = 1; j <= ns; j++)
                if (dp[j - 1] && towlower(c) == towlower(s[j - 1])) next[j] = 1;
        }
        dp.swap(next);
    }
    return dp[ns] != 0;
}

bool globMatch(const std::wstring& pattern, const std::wstring& vpath)
{
    if (pattern.empty()) return false;

    // /dir/** 约定同时匹配 /dir 本身：先匹配"剥离 /** 后的 base"
    size_t pos = pattern.size() >= 3 ? pattern.size() - 3 : std::wstring::npos;
    if (pos != std::wstring::npos && pattern.compare(pos, 3, L"/**") == 0) {
        std::wstring base = pattern.substr(0, pos);
        if (base.empty()) base = L"/";
        if (globMatchLinear(base.c_str(), vpath.c_str())) return true;
        // 也要匹配 /dir/...（由主模式处理）
    }
    return globMatchLinear(pattern.c_str(), vpath.c_str());
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