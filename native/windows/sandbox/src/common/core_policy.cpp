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

// 共享 core 桥接实现：TOML 解析与 glob 匹配委托给
// native/openharmony/sandbox/src 的 C 实现（三平台单一来源）。
//
// core 以 C 编译单元进入 Windows 构建（其自身 I/O 由 rawio_win32.c 提供；
// 本桥接只使用 dbox_policy_load_toml / dbox_glob_match 两个纯函数，不触碰
// core 的 shm/ask 传输——那两块在 Windows 侧由既有 ask.cpp/policy.cpp 承担）。

#include "core_policy.h"

#include <windows.h>
#include <cwctype>

// core 头文件（C 接口）。dynobox.h 纯类型定义无平台依赖；policy.h 因
// pthread.h 不便引入 MSVC，这里直接 include dynobox.h 并手动声明用到的
// core 函数（签名以 policy.h 为准，链接由 core 的 policy.c 提供）。
extern "C" {
#include "dynobox.h"

int dbox_policy_load_toml(const char *text, dbox_policy_t *p, char *err, size_t errsz);
void dbox_policy_init(dbox_policy_t *p);
void dbox_policy_free(dbox_policy_t *p);
const char *dbox_access_name(int acc);
int dbox_glob_match(const char *pat, const char *path);
}

namespace sbx {

// dynobox.h 未导出的 core 内部接口（policy.h 因 pthread.h 不便引入，在此
// 显式声明——签名以 policy.h 为准，链接由 core 的 policy.c 提供）。
extern "C" {
int dbox_policy_load_toml(const char *text, dbox_policy_t *p, char *err, size_t errsz);
void dbox_policy_init(dbox_policy_t *p);
void dbox_policy_free(dbox_policy_t *p);
}

static std::wstring utf8ToWideSimple(const std::string& s)
{
    if (s.empty()) return std::wstring();
    int need = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring out((size_t)need, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], need);
    return out;
}

static std::string wideToUtf8Simple(const std::wstring& s)
{
    if (s.empty()) return std::string();
    int need = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0, nullptr, nullptr);
    std::string out((size_t)need, '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), &out[0], need, nullptr, nullptr);
    return out;
}

static std::wstring toLowerSimple(const std::wstring& s)
{
    std::wstring out = s;
    for (auto& c : out) c = (wchar_t)towlower(c);
    return out;
}

bool coreParsePolicyToml(const std::wstring& utf16Text,
                         std::vector<CorePolicyRule>& rules,
                         CoreAskConfig& ask,
                         std::string& defaultPerm,
                         std::wstring& error)
{
    rules.clear();
    ask = CoreAskConfig{};
    defaultPerm = "deny";

    const std::string utf8 = wideToUtf8Simple(utf16Text);
    dbox_policy_t p;
    dbox_policy_init(&p);
    char err[512] = { 0 };
    if (dbox_policy_load_toml(utf8.c_str(), &p, err, sizeof err) != 0) {
        error = utf8ToWideSimple(err);
        dbox_policy_free(&p);
        return false;
    }

    for (int i = 0; i < p.nrules; i++) {
        CorePolicyRule r;
        r.path = utf8ToWideSimple(p.rules[i].path);
        r.access = dbox_access_name(p.rules[i].acc) ? dbox_access_name(p.rules[i].acc) : "all";
        switch (p.rules[i].perm) {
            case PERM_ALLOW: r.perm = "allow"; break;
            case PERM_ASK:   r.perm = "ask";   break;
            default:         r.perm = "deny";  break;
        }
        rules.push_back(std::move(r));
    }

    if (p.ask_endpoint) ask.endpoint = utf8ToWideSimple(p.ask_endpoint);
    if (p.ask_token) ask.token = utf8ToWideSimple(p.ask_token);
    ask.timeoutMs = p.ask_timeout_ms;
    ask.cacheTtlSeconds = p.cache_ttl_s;
    ask.grantTtlSeconds = p.grant_ttl_s;
    defaultPerm = p.default_perm == PERM_ALLOW ? "allow" : "deny";

    dbox_policy_free(&p);
    return true;
}

bool coreGlobMatch(const std::wstring& pattern, const std::wstring& vpath)
{
    // Windows 路径大小写不敏感：两侧折叠小写后交给 core（POSIX 敏感匹配）。
    const std::string pat = wideToUtf8Simple(toLowerSimple(pattern));
    const std::string path = wideToUtf8Simple(toLowerSimple(vpath));
    return dbox_glob_match(pat.c_str(), path.c_str()) != 0;
}

// 预编译句柄的释放走 core 的 dbox_glob_free（dynobox.h 已在本 TU 内可见）
static void coreGlobDeleter(::dbox_glob *p)
{
    if (p) dbox_glob_free(p);
}

CoreGlob coreGlobCompile(const std::wstring& pattern)
{
    const std::string pat = wideToUtf8Simple(toLowerSimple(pattern));
    ::dbox_glob *g = dbox_glob_compile(pat.c_str());
    return g ? CoreGlob(g, coreGlobDeleter) : CoreGlob();
}

bool coreGlobMatchCompiled(const CoreGlob& glob, const std::wstring& vpath)
{
    if (!glob) return false;
    const std::string path = wideToUtf8Simple(toLowerSimple(vpath));
    return dbox_glob_match_compiled(glob.get(), path.c_str()) != 0;
}

std::wstring coreGlobLiteralPrefix(const std::wstring& pattern)
{
    size_t cut = pattern.find_first_of(L"*?");
    std::wstring prefix = cut == std::wstring::npos ? pattern : pattern.substr(0, cut);
    return toLowerSimple(prefix);
}

} // namespace sbx