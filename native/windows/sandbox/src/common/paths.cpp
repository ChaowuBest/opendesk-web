/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "paths.h"

#include <windows.h>
#include <algorithm>

namespace sbx {

std::wstring normalizeVirtualPath(const std::wstring& raw)
{
    std::wstring p;
    p.reserve(raw.size() + 1);
    for (wchar_t c : raw)
        p.push_back(c == L'\\' ? L'/' : c);
    while (!p.empty() && p.front() == L'/') p.erase(p.begin());
    if (p.empty()) return L"/";
    return L"/" + p;
}

static void stripTrailingDotsAndSpaces(std::wstring& s)
{
    // 去掉路径分量末尾的 '.' 与空格（Windows 归一化别名，如 "a.txt." -> "a.txt"）
    size_t end = s.size();
    while (end > 0) {
        wchar_t c = s[end - 1];
        if (c == L'.' || c == L' ') end--;
        else break;
    }
    s.resize(end);
}

bool normalizeHostPath(const std::wstring& raw, std::wstring& out)
{
    if (raw.empty()) return false;

    // 去掉 Win32 命名空间前缀
    std::wstring p = raw;
    if (p.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        p = L"\\\\" + p.substr(8);
    } else if (p.rfind(L"\\\\?\\", 0) == 0) {
        p = p.substr(4);
    } else if (p.rfind(L"\\??\\UNC\\", 0) == 0) {
        p = L"\\\\" + p.substr(8);
    } else if (p.rfind(L"\\??\\", 0) == 0) {
        p = p.substr(4);
    }
    if (p.empty()) return false;

    // 相对路径展开（GetFullPathName 解析 '..' 并结合进程 cwd）
    if (!(isalpha(p[0]) && p.size() > 1 && p[1] == L':') && p.rfind(L"\\\\", 0) != 0) {
        DWORD need = GetFullPathNameW(p.c_str(), 0, nullptr, nullptr);
        if (need == 0) return false;
        std::wstring buf(need, L'\0');
        if (GetFullPathNameW(p.c_str(), need, &buf[0], nullptr) == 0) return false;
        buf.resize(wcslen(buf.c_str()));
        p = std::move(buf);
    }

    // 8.3 短名 -> 长名（含 '~' 的分量才需转换）
    if (p.find(L'~') != std::wstring::npos) {
        DWORD need = GetLongPathNameW(p.c_str(), nullptr, 0);
        if (need > 0) {
            std::wstring buf(need, L'\0');
            if (GetLongPathNameW(p.c_str(), &buf[0], need) > 0) {
                buf.resize(wcslen(buf.c_str()));
                p = std::move(buf);
            }
        }
    }

    stripTrailingDotsAndSpaces(p);

    // 归一化斜杠与尾分隔符：剥离目录尾部的 '\'（根 "C:\" 3 字符保留；
    // 盘符/UNC 子目录 "C:\foo\"、"\\srv\share\" 剥成 "C:\foo"、"\\srv\share"），
    // 否则映射出的虚拟路径带尾 '/' 会导致规则（如 /C/foo）不匹配而误判。
    for (wchar_t& c : p)
        if (c == L'/') c = L'\\';
    while (p.size() > 3 && p.back() == L'\\') p.pop_back();

    out = std::move(p);
    return true;
}

static bool startsWithNoCase(const std::wstring& s, const std::wstring& prefix)
{
    if (s.size() < prefix.size()) return false;
    return _wcsnicmp(s.c_str(), prefix.c_str(), prefix.size()) == 0;
}

bool mapHostToVirtual(const std::wstring& hostPath, const std::vector<RootMap>& roots,
                      std::wstring& vpath)
{
    const RootMap* best = nullptr;
    for (const auto& r : roots) {
        if (r.realPrefix.empty()) continue;
        if (!startsWithNoCase(hostPath, r.realPrefix)) continue;
        // 边界：前缀必须落在分量边界上（C:\foo 不应匹配 root "C:\f"）
        size_t len = r.realPrefix.size();
        if (len < hostPath.size()) {
            wchar_t lastPrefix = r.realPrefix.back();
            wchar_t next = hostPath[len];
            bool prefixEndsAtBoundary = (lastPrefix == L'\\' || lastPrefix == L':');
            if (!prefixEndsAtBoundary && next != L'\\') continue;
        }
        if (!best || r.realPrefix.size() > best->realPrefix.size()) best = &r;
    }
    if (!best) return false;

    std::wstring vp = best->virtualPrefix;
    if (vp.empty()) vp = L"/";
    if (vp != L"/") {
        while (!vp.empty() && vp.back() == L'/') vp.pop_back();
    }
    std::wstring rest = hostPath.substr(best->realPrefix.size());
    for (wchar_t& c : rest)
        if (c == L'\\') c = L'/';
    while (!rest.empty() && rest.front() == L'/') rest.erase(rest.begin());
    vpath = (vp == L"/") ? (L"/" + rest) : (vp + L"/" + rest);
    return true;
}

bool mapVirtualToHost(const std::wstring& vpath, const std::vector<RootMap>& roots,
                      std::wstring& hostPath)
{
    const RootMap* best = nullptr;
    for (const auto& r : roots) {
        std::wstring vp = r.virtualPrefix.empty() ? L"/" : r.virtualPrefix;
        while (vp.size() > 1 && vp.back() == L'/') vp.pop_back();
        if (vp == L"/") {
            if (!best) best = &r;
            continue;
        }
        if (vpath.size() >= vp.size() && _wcsnicmp(vpath.c_str(), vp.c_str(), vp.size()) == 0 &&
            (vpath.size() == vp.size() || vpath[vp.size()] == L'/')) {
            if (!best || vp.size() > best->virtualPrefix.size()) best = &r;
        }
    }
    if (!best) return false;
    std::wstring vp = best->virtualPrefix.empty() ? L"/" : best->virtualPrefix;
    while (vp.size() > 1 && vp.back() == L'/') vp.pop_back();
    std::wstring rest = (vp == L"/") ? vpath : vpath.substr(vp.size());
    for (wchar_t& c : rest)
        if (c == L'/') c = L'\\';
    std::wstring real = best->realPrefix;
    while (real.size() > 1 && real.back() == L'\\' && real.size() > 3) real.pop_back();
    hostPath = real + rest;
    return true;
}

} // namespace sbx
