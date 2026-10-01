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
    // 逐路径分量剥离尾部的 '.' 与空格（Windows 归一化别名：每个分量末尾的
    // 点/空格都会被文件系统忽略，如 "a.txt." -> "a.txt"、"C:\dir. \file" 中
    // 的 "dir. " 等同 "dir"）。只处理整串末尾会漏掉中间分量，导致 hook 判定
    // 用的 vpath 与系统实际解析的路径不一致（deny 可被中间分量尾点绕过）。
    for (size_t i = 0; i < s.size();) {
        size_t start = i;
        size_t sep = s.find_first_of(L"/\\", i);
        size_t end = (sep == std::wstring::npos) ? s.size() : sep;
        // 该分量末尾（不含分隔符）向前剥离 '.' 与空格
        size_t compEnd = end;
        while (compEnd > start && (s[compEnd - 1] == L'.' || s[compEnd - 1] == L' ')) compEnd--;
        if (compEnd < end) s.erase(compEnd, end - compEnd);
        if (sep == std::wstring::npos) break;
        i = sep + 1;
    }
}

// 路径含 `.` 或 `..` 分量（正/反斜杠分隔的完整段）。
// 这类段必须经 GetFullPathNameW 展开：绝对路径（C:\a\..\b）中的 `..`
// 同样要展开，否则 hook 判定基于未规范化 vpath，deny 规则可被 `..` 别名绕过
// （GetFileAttributesW 等不经 NtCreateFile 二次判定的 API 直接泄露 deny 目录）。
static bool hasDotSegment(const std::wstring& p)
{
    size_t start = 0;
    while (start < p.size()) {
        size_t sep = p.find_first_of(L"/\\", start);
        size_t end = (sep == std::wstring::npos) ? p.size() : sep;
        size_t n = end - start;
        if ((n == 1 && p[start] == L'.') || (n == 2 && p[start] == L'.' && p[start + 1] == L'.'))
            return true;
        if (sep == std::wstring::npos) break;
        start = sep + 1;
    }
    return false;
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

    // 含 `.`/`..` 分量的路径（无论相对还是绝对）经 GetFullPathNameW 展开，
    // 解析 `..` 并结合进程 cwd；无可疑段时不调用（热路径零开销）。
    if (hasDotSegment(p)) {
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

bool mapGlobalRootToDrive(const std::wstring& path, std::wstring& drivePath)
{
    // 目标形如 \\?\GLOBALROOT\Device\HarddiskVolumeN\...（也接受 \\.\GLOBALROOT\...）
    const wchar_t* prefix = nullptr;
    if (path.rfind(L"\\\\?\\GLOBALROOT\\", 0) == 0) prefix = L"\\\\?\\GLOBALROOT\\";
    else if (path.rfind(L"\\\\.\\GLOBALROOT\\", 0) == 0) prefix = L"\\\\.\\GLOBALROOT\\";
    else return false;

    std::wstring rest = path.substr(wcslen(prefix));
    if (rest.rfind(L"Device\\HarddiskVolume", 0) != 0) return false;   // 非卷设备（NamedPipe 等）不映射

    // 解析卷号（数字，可能后跟 '\' 或路径）
    size_t numStart = wcslen(L"Device\\HarddiskVolume");
    size_t i = numStart;
    std::wstring num;
    while (i < rest.size() && iswdigit(rest[i])) { num.push_back(rest[i]); i++; }
    if (num.empty()) return false;
    // 找到该卷号对应的盘符（QueryDosDeviceW 反查 \Device\HarddiskVolumeN -> "X:"）
    wchar_t buf[1024] = {};
    for (wchar_t letter = L'Z'; letter >= L'A'; letter--) {
        wchar_t dos[4] = { letter, L':', L'\0', L'\0' };
        DWORD need = QueryDosDeviceW(dos, buf, 1024);
        if (need == 0) continue;
        // buf 可能是多字符串：找到与 \Device\HarddiskVolumeN 匹配的那条
        wchar_t* entry = buf;
        while (entry && *entry) {
            std::wstring target(entry);
            if (target.find(L"\\Device\\HarddiskVolume" + num) == 0) {
                std::wstring letterStr(1, letter);
                // rest 从数字之后开始：卷号后的部分（'\' 或 '\path'）
                std::wstring tail = rest.substr(i);
                drivePath = letterStr + L":" + (tail.empty() ? std::wstring(L"\\") : tail);
                return true;
            }
            entry += wcslen(entry) + 1;
        }
    }
    return false;
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
