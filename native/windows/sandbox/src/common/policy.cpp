/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "policy.h"

#include <windows.h>
#include <stdexcept>

#include "glob.h"
#include "log.h"
#include "toml.h"
#include "utf.h"

namespace sbx {

Policy::Policy() : m_state(std::make_unique<State>()) {}
Policy::~Policy() = default;
Policy::Policy(Policy&&) noexcept = default;
Policy& Policy::operator=(Policy&&) noexcept = default;

// -- Rule --------------------------------------------------------------------

bool Rule::matches(const std::wstring& vpath, const std::string& kind) const
{
    if (!matchesKind(kind)) return false;
    // 字面前缀预筛
    if (vpath.size() < literalPrefix.size()) return false;
    if (_wcsnicmp(vpath.c_str(), literalPrefix.c_str(), literalPrefix.size()) != 0) return false;
    if (globMatch(path, vpath)) return true;
    // `/dir/**` 同时匹配 `/dir` 本身
    if (!basePath.empty() && globMatch(basePath, vpath)) return true;
    return false;
}

// -- Policy ------------------------------------------------------------------

static Perm parsePerm(const std::wstring& perm)
{
    if (perm == L"allow") return Perm::Allow;
    if (perm == L"ask") return Perm::Ask;
    if (perm == L"deny") return Perm::Deny;
    throw std::runtime_error("perm 非法（allow|ask|deny）");
}

static bool buildRule(const std::wstring& rawPath, const std::wstring& rawAccess,
                      const std::wstring& rawPerm, Rule& out)
{
    std::string access = narrowAscii(rawAccess);
    for (auto& c : access) c = (char)tolower((unsigned char)c);
    if (access != "read" && access != "write" && access != "execute" && access != "all")
        return false;
    std::wstring perm = rawPerm;
    for (auto& c : perm) c = (wchar_t)towlower(c);
    if (perm != L"allow" && perm != L"ask" && perm != L"deny") return false;

    Rule r;
    r.path = normalizeVirtualPath(rawPath);
    r.access = access;
    r.perm = parsePerm(perm);
    r.literalPrefix = globLiteralPrefix(r.path);
    if (r.path.size() >= 3 && r.path.compare(r.path.size() - 3, 3, L"/**") == 0) {
        std::wstring base = r.path.substr(0, r.path.size() - 3);
        r.basePath = base.empty() ? L"/" : base;
    }
    out = std::move(r);
    return true;
}

Policy Policy::loadFromFile(const std::wstring& path)
{
    // 读取文件（UTF-8 / UTF-16 LE / UTF-16 BE 皆可）
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        throw std::runtime_error("无法打开策略文件: " + wideToUtf8(path));
    std::wstring text;
    do {
        LARGE_INTEGER size;
        if (!GetFileSizeEx(h, &size) || size.QuadPart > 4 * 1024 * 1024) break;
        DWORD n = (DWORD)size.QuadPart;
        std::vector<BYTE> buf(n + 2, 0);
        DWORD read = 0;
        if (!ReadFile(h, buf.data(), n, &read, nullptr)) break;
        if (read >= 2 && buf[0] == 0xFF && buf[1] == 0xFE) {
            text.assign((const wchar_t*)(buf.data() + 2), (read - 2) / 2);
        } else if (read >= 2 && buf[0] == 0xFE && buf[1] == 0xFF) {
            std::wstring tmp((read - 2) / 2, L'\0');
            for (size_t i = 0; i + 1 < read - 2; i += 2)
                tmp[i / 2] = (wchar_t)((buf[2 + i] << 8) | buf[3 + i]);
            text = std::move(tmp);
        } else {
            int need = MultiByteToWideChar(CP_UTF8, 0, (const char*)buf.data(), (int)read, nullptr, 0);
            std::wstring tmp((size_t)need, L'\0');
            MultiByteToWideChar(CP_UTF8, 0, (const char*)buf.data(), (int)read, &tmp[0], need);
            text = std::move(tmp);
        }
    } while (false);
    CloseHandle(h);
    if (text.empty())
        throw std::runtime_error("策略文件为空或不可读: " + wideToUtf8(path));

    TomlTable root;
    try {
        root = parseToml(text);
    } catch (const std::exception& e) {
        throw std::runtime_error(std::string("策略文件解析失败: ") + e.what());
    }

    Policy p;

    auto defIt = root.find(L"default");
    if (defIt != root.end()) {
        std::wstring def = defIt->second.toString();
        for (auto& c : def) c = (wchar_t)towlower(c);
        p.m_default = (def == L"allow") ? "allow" : "deny";
    }

    auto askIt = root.find(L"ask");
    if (askIt != root.end() && askIt->second.kind() == TomlValue::Kind::Table) {
        const TomlTable& ask = askIt->second.table();
        auto it = ask.find(L"endpoint");
        if (it != ask.end()) p.m_ask.endpoint = it->second.toString();
        it = ask.find(L"token");
        if (it != ask.end()) p.m_ask.token = it->second.toString();
        it = ask.find(L"timeout_ms");
        if (it != ask.end()) p.m_ask.timeoutMs = (int)it->second.toInteger();
        it = ask.find(L"cache_ttl_seconds");
        if (it != ask.end()) p.m_ask.cacheTtlSeconds = (int)it->second.toInteger();
        it = ask.find(L"grant_ttl_seconds");
        if (it != ask.end()) p.m_ask.grantTtlSeconds = (int)it->second.toInteger();
    }

    // 内置引导区规则（与 C# 版一致：用户规则无法关闭沙箱内部路径）
    {
        Rule dynobox, dynoboxDeep;
        buildRule(L"/dynobox", L"all", L"allow", dynobox);
        buildRule(L"/dynobox/**", L"all", L"allow", dynoboxDeep);
        p.m_rules.push_back(std::move(dynobox));
        p.m_rules.push_back(std::move(dynoboxDeep));
    }

    auto rootsIt = root.find(L"roots");
    if (rootsIt != root.end() && rootsIt->second.kind() == TomlValue::Kind::TableArray) {
        for (const auto& r : rootsIt->second.array()) {
            auto vit = r.find(L"virtual");
            auto rit = r.find(L"real");
            if (vit == r.end() || rit == r.end())
                throw std::runtime_error("roots 项缺少 virtual/real");
            std::wstring real = rit->second.toString();
            while (real.size() > 1 && real.back() == L'\\') real.pop_back();
            if (real.size() == 2 && real[1] == L':') real.push_back(L'\\');   // "C:" -> "C:\"
            RootMap m;
            m.virtualPrefix = normalizeVirtualPath(vit->second.toString());
            while (m.virtualPrefix.size() > 1 && m.virtualPrefix.back() == L'/')
                m.virtualPrefix.pop_back();
            m.realPrefix = real;
            p.m_roots.push_back(std::move(m));
        }
    }

    auto rulesIt = root.find(L"rules");
    if (rulesIt != root.end() && rulesIt->second.kind() == TomlValue::Kind::TableArray) {
        size_t i = 0;
        for (const auto& r : rulesIt->second.array()) {
            auto pit = r.find(L"path");
            auto ait = r.find(L"access");
            auto perIt = r.find(L"perm");
            if (pit == r.end() || ait == r.end() || perIt == r.end())
                throw std::runtime_error("rules[" + std::to_string(i) + "] 缺少字段");
            Rule rule;
            if (!buildRule(pit->second.toString(), ait->second.toString(), perIt->second.toString(), rule))
                throw std::runtime_error("rules[" + std::to_string(i) + "] 字段非法");
            p.m_rules.push_back(std::move(rule));
            i++;
        }
    }
    return p;
}

void Policy::addSrcRoot(const std::wstring& realDir)
{
    std::wstring real = realDir;
    if (real.empty()) return;
    while (real.size() > 1 && real.back() == L'\\') real.pop_back();
    RootMap m;
    m.virtualPrefix = L"/";
    m.realPrefix = real;
    m_roots.clear();
    m_roots.push_back(std::move(m));
}

void Policy::addAutomountRoots()
{
    DWORD drives = GetLogicalDrives();
    for (wchar_t letter = L'A'; letter <= L'Z'; letter++) {
        if (!(drives & (1u << (letter - L'A')))) continue;
        std::wstring vp = L"/";
        vp.push_back(letter);
        std::wstring real(1, letter);
        real += L":\\";
        RootMap m;
        m.virtualPrefix = vp;
        m.realPrefix = real;
        m_roots.push_back(std::move(m));
    }
}

bool Policy::check(const std::wstring& vpath, const std::string& kind, std::string* why)
{
    // 静态规则顺序匹配（deny/allow 硬边界）
    for (size_t i = 0; i < m_rules.size(); i++) {
        const Rule& rule = m_rules[i];
        if (!rule.matches(vpath, kind)) continue;
        if (rule.perm != Perm::Ask) {
            bool allowed = rule.perm == Perm::Allow;
            if (why) *why = std::string("rule#") + std::to_string(i) +
                              (allowed ? " allow" : " deny");
            return allowed;
        }
        // 静态 ask 规则 → 先查端点下发的子树授权
        if (matchGrant(vpath, kind)) {
            if (why) *why = std::string("rule#") + std::to_string(i) + "+grant";
            return true;
        }
        bool allowed = false;
        bool ok = askUpstreamAndCache(vpath, kind, allowed);
        if (why) *why = std::string("rule#") + std::to_string(i) + "+ask(" +
                        (ok ? (allowed ? "allow" : "deny") : "fail-closed") + ")";
        return allowed;
    }
    bool allowed = m_default == "allow";
    if (why) *why = std::string("default:") + m_default;
    return allowed;
}

bool Policy::checkDenyOnly(const std::wstring& vpath, const std::string& kind) const
{
    // 顺序匹配：第一个命中的规则决定。deny -> 拦截；allow/ask -> 放行（探测不触发 ask）。
    for (size_t i = 0; i < m_rules.size(); i++) {
        const Rule& rule = m_rules[i];
        if (!rule.matches(vpath, kind)) continue;
        if (rule.perm == Perm::Deny) return true;
        return false;
    }
    return m_default == "deny";
}

bool Policy::tryCached(const std::wstring& vpath, const std::string& kind, bool& allowed) const
{
    if (m_ask.cacheTtlSeconds <= 0) return false;
    long long now = (long long)GetTickCount64();
    std::wstring key = vpath;
    for (auto& c : key) c = (wchar_t)towlower(c);
    key.push_back(L'\0');
    key.append(kind.begin(), kind.end());

    std::lock_guard<std::mutex> lock(m_state->mutex);
    auto it = m_state->cache.find(key);
    if (it == m_state->cache.end()) return false;
    if (it->second.expiryTicks <= now) {
        m_state->cache.erase(it);
        return false;
    }
    allowed = it->second.allowed;
    return true;
}

void Policy::putCached(const std::wstring& vpath, const std::string& kind, bool allowed)
{
    if (m_ask.cacheTtlSeconds <= 0) return;
    std::wstring key = vpath;
    for (auto& c : key) c = (wchar_t)towlower(c);
    key.push_back(L'\0');
    key.append(kind.begin(), kind.end());

    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (m_state->cache.size() > 4096) m_state->cache.clear();   // 防膨胀
    m_state->cache[key] = CacheEntry{ allowed,
        (long long)GetTickCount64() + (long long)m_ask.cacheTtlSeconds * 1000 };
}

bool Policy::matchGrant(const std::wstring& vpath, const std::string& kind) const
{
    long long now = (long long)GetTickCount64();
    std::lock_guard<std::mutex> lock(m_state->mutex);
    for (auto it = m_state->grants.begin(); it != m_state->grants.end();) {
        if (it->expiryTicks <= now) it = m_state->grants.erase(it);
        else ++it;
    }
    for (const auto& g : m_state->grants) {
        if (g.rule.matches(vpath, kind)) return true;
    }
    return false;
}

void Policy::installGrants(const std::vector<Grant>& grants)
{
    long long now = (long long)GetTickCount64();
    std::lock_guard<std::mutex> lock(m_state->mutex);
    // 防膨胀：过期项随 matchGrant 清理，但高频 ask 时无匹配路径的授权会累积，
    // 这里设置总量上限（1024 条），超出后清空由后续 ask 重新建立。
    if (m_state->grants.size() > 1024) m_state->grants.clear();
    for (const auto& g : grants) {
        int ttl = std::max(0, std::min(3600, g.ttlSeconds));
        Rule rule;
        std::wstring acc = ansiToWide(g.access.c_str());
        if (buildRule(g.path, acc, L"allow", rule)) {
            m_state->grants.push_back(Ephemeral{ std::move(rule), now + (long long)ttl * 1000 });
            Log::debug(L"[GRANT] + %ls %ls (ttl=%ds)", acc.c_str(), g.path.c_str(), ttl);
        }
    }
}

bool Policy::askUpstreamAndCache(const std::wstring& vpath, const std::string& kind, bool& allowed)
{
    // 决策缓存（按 路径+访问类型 键；失败不缓存）
    if (tryCached(vpath, kind, allowed)) {
        return true;
    }
    if (m_ask.timeoutMs <= 0) {
        allowed = false;
        return false;
    }

    std::wstring key = vpath;
    for (auto& c : key) c = (wchar_t)towlower(c);
    key.push_back(L'\0');
    key.append(kind.begin(), kind.end());

    AskGate& gate = *m_state->askGate;
    std::unique_lock<std::mutex> lock(gate.mtx);
    const auto timeoutMs = std::chrono::milliseconds(m_ask.timeoutMs);

    // 1) 同 key 已有在途/刚完成的 ask：复用其结果（并发合并窗口），
    //    消除缓存 miss 窗口内的重复请求（结果不依赖策略缓存，TTL=0 也生效）。
    {
        auto it = gate.pending.find(key);
        if (it != gate.pending.end()) {
            if (!it->second.done) {
                // 在途：等待发起方完成
                gate.cv.wait_for(lock, timeoutMs,
                                 [&] { return gate.pending.count(key) == 0 || gate.pending[key].done; });
            }
            auto cur = gate.pending.find(key);
            if (cur != gate.pending.end() && cur->second.done &&
                cur->second.expiryTicks > (long long)GetTickCount64()) {
                allowed = cur->second.allowed;
                return true;
            }
            if (cur != gate.pending.end() && !cur->second.done) {
                // 等待超时仍未完成：fail-closed（不重复打端点）
                lock.unlock();
                Log::warn(L"[ASK] 同路径 ask 等待超时，fail-closed: %ls %ls", vpath.c_str(),
                          std::wstring(kind.begin(), kind.end()).c_str());
                allowed = false;
                return false;
            }
            // 合并结果已过期：擦除后按新请求处理
            if (cur != gate.pending.end()) gate.pending.erase(cur);
        }
    }

    // 2) 端点失败熔断：上次失败在冷却窗口内 -> 直接 fail-closed，
    //    避免端点不可达时每一次访问都打满超时（失败风暴）。
    {
        long long now = (long long)GetTickCount64();
        if (gate.lastFailureTicks != 0 && now - gate.lastFailureTicks < kAskFailureCooldownMs) {
            lock.unlock();
            Log::warn(L"[ASK] 端点熔断（失败冷却期内）按 deny: %ls %ls", vpath.c_str(),
                      std::wstring(kind.begin(), kind.end()).c_str());
            allowed = false;
            return false;
        }
    }

    // 3) 并发上限排队：在途 ask 超限时等待（带超时），保护端点不被并发压垮。
    {
        auto deadline = std::chrono::steady_clock::now() + timeoutMs;
        while (gate.inFlight >= kMaxConcurrentAsks) {
            if (gate.cv.wait_until(lock, deadline) == std::cv_status::timeout) {
                lock.unlock();
                Log::warn(L"[ASK] ask 排队超时，fail-closed（并发=%zu）: %ls %ls", gate.inFlight,
                          vpath.c_str(), std::wstring(kind.begin(), kind.end()).c_str());
                allowed = false;
                return false;
            }
        }
    }
    // 注册为该 key 的发起方
    gate.inFlight++;
    gate.pending[key] = PendingAsk{};

    // 请求期间不持 gate 锁（允许其他线程排队/合并进入等待）
    lock.unlock();
    AskResult result;
    std::wstring err;
    AskOutcome outcome = AskOutcome::TransportError;
    bool ok = askUpstream(m_ask, vpath, kind, result, err, outcome);

    lock.lock();
    gate.inFlight--;
    {
        auto p = gate.pending.find(key);
        if (p != gate.pending.end()) {
            p->second.done = true;
            p->second.allowed = ok && result.allowed;
            // 成功结果在合并窗口内共享；失败结果立即过期（供并发等待者读到，
            // 但后续访问重新发起——保持"失败不缓存"语义）
            p->second.expiryTicks = ok
                ? (long long)GetTickCount64() + kAskResultCoalesceMs
                : (long long)GetTickCount64();
        }
    }
    if (ok) {
        allowed = result.allowed;
        if (!result.grants.empty()) installGrants(result.grants);
        putCached(vpath, kind, allowed);
    } else {
        // 仅传输级失败（端点不可达/挂/超时）触发熔断；HTTP 非 200/坏响应是
        // 端点"可达但拒绝"，不熔断（fail-closed 且下次重试）
        if (outcome == AskOutcome::TransportError) {
            gate.lastFailureTicks = (long long)GetTickCount64();
        }
        allowed = false;
        Log::warn(L"[ASK] 上游调用失败，按 deny（不缓存）: %ls %ls err=%ls", vpath.c_str(),
                  std::wstring(kind.begin(), kind.end()).c_str(), err.c_str());
    }
    gate.cv.notify_all();
    return ok;
}

} // namespace sbx