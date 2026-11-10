/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#include "policy.h"

#include <windows.h>
#include <stdexcept>

#include "core_policy.h"
#include "log.h"
#include "utf.h"

namespace sbx {

Policy::Policy() : m_state(std::make_unique<State>()) {}
Policy::~Policy() = default;
Policy::Policy(Policy&&) noexcept = default;
Policy& Policy::operator=(Policy&&) noexcept = default;

// -- Rule --------------------------------------------------------------------

bool Rule::matches(const std::wstring& vpath, const std::string& pathKey,
                   const std::string& kind) const
{
    if (!matchesKind(kind)) return false;
    // `/dir/**` 只覆盖子树，不匹配 `/dir` 自身（与 core 的四平台语义一致：
    // core 的尾部 ** 不匹配空段，macOS boxdylib 走同一份 glob）。这里显式短路，
    // 不要依赖下面字面前缀预筛的字符串长度巧合：`/dir/**` 的预筛前缀是 `/dir/`，
    // 它恰好比 `/dir` 长一个字符，靠它"碰巧"挡住目录自身会让下一个人当成预筛
    // 写错而"修"回来。需要连目录自身一起覆盖时，策略里显式写 path = /dir。
    if (!basePath.empty() && vpath.size() == basePath.size() &&
        _wcsnicmp(vpath.c_str(), basePath.c_str(), basePath.size()) == 0) return false;
    // 字面前缀预筛
    if (vpath.size() < literalPrefix.size()) return false;
    if (_wcsnicmp(vpath.c_str(), literalPrefix.c_str(), literalPrefix.size()) != 0) return false;
    // 预编译匹配（省掉每规则每次的 normpath + 模式切分/小写化）；
    // 句柄缺失时回退逐次解析
    return glob ? coreGlobMatchCompiled(glob, pathKey) : coreGlobMatch(path, vpath);
}

// -- Policy ------------------------------------------------------------------

// 内置引导区规则的 specificity：取最大值使其永远最具体（见 loadFromFile 的注释）。
static const size_t kBuiltinSpec = static_cast<size_t>(-1);

static Perm parsePerm(const std::wstring& perm)
{
    if (perm == L"allow") return Perm::Allow;
    if (perm == L"ask") return Perm::Ask;
    if (perm == L"deny") return Perm::Deny;
    throw std::runtime_error("perm 非法（allow|ask|deny）");
}

// 与 core 的 rule_specificity 同算法：尾部 "/**" 剥离后取长度。必须按 **UTF-8
// 字节** 计算（core 用 strlen），不能用 wstring 长度——非 ASCII 路径（中文用户名
// 等）会得到与 core 不同的 specificity，同 spec 平局时的取舍随平台分叉。
// 输入是大小写折叠后的路径键（core 侧用原始模式），ASCII 路径下字节数完全相同；
// 仅在 glob 编译失败（OOM）时使用，正常路径取句柄里的 spec。
static size_t pathSpecFallback(const std::wstring& vpath)
{
    const std::string key = corePathKey(vpath);
    const size_t n = key.size();
    if (n >= 3 && key.compare(n - 3, 3, "/**") == 0) return n - 3;
    return n;
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
    r.literalPrefix = coreGlobLiteralPrefix(r.path);
    r.glob = coreGlobCompile(r.path);            // 装载时编译一次，判定热路径复用
    // most-specific 选优的键。句柄缺失时按 core 的 rule_specificity 兜底——
    // 与 core 的 rule_compile_one 一致，否则 OOM 下这条规则会被当成 spec=0 的
    // 过宽通配，输给任何 spec>0 的 allow（deny 规则 fail-open）。
    r.spec = r.glob ? coreGlobSpecificity(r.glob) : pathSpecFallback(r.path);
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

    // TOML 解析与规则评估内核委托给共享 core（native/openharmony/sandbox/src，
    // 三平台单一来源）：core 做 fail-loud 校验（未知表名/旧 schema 一律报错，
    // 含 [[rule]] 单数与 decision= 旧字段的静默降级防护）。
    std::vector<CorePolicyRule> coreRules;
    CoreAskConfig coreAsk;
    std::string coreDefault;
    std::wstring coreError;
    if (!coreParsePolicyToml(text, coreRules, coreAsk, coreDefault, coreError)) {
        throw std::runtime_error("策略文件解析失败: " + wideToUtf8(coreError));
    }

    Policy p;
    p.m_default = coreDefault.empty() ? "deny" : coreDefault;
    p.m_ask.endpoint = coreAsk.endpoint;
    p.m_ask.token = coreAsk.token;
    p.m_ask.timeoutMs = (int)coreAsk.timeoutMs;
    p.m_ask.cacheTtlSeconds = (int)coreAsk.cacheTtlSeconds;
    p.m_ask.grantTtlSeconds = (int)coreAsk.grantTtlSeconds;

    // 内置引导区规则（与 C# 版一致：用户规则无法关闭沙箱内部路径）。
    // most-specific 语义下"排在最前"不再意味着优先（同 specificity 时 deny 会反超
    // allow），所以把内置规则的 spec 提到最大值：内部路径（判定日志、ask 端点）
    // 恒为 allow，用户无法用同长度或更长的 deny 把它关掉——否则沙箱会把自己
    // 的日志/审批通道拒之门外。这与 core 的 specificity 定义（模式长度）不同，
    // 属 Windows 独有的引导区机制，故只作用于这两条规则。
    // 注意 `/dynobox` 目前没有 roots 映射（addSrcRoot 只映射 `/`，addAutomountRoots
    // 只映射 `/C` 等盘符，policy.cpp 的 roots 里没有 /dynobox 项），所以这两条规则
    // 实际不会命中任何宿主路径：它们只是"将来给 /dynobox 挂真实目录时不会被用户
    // 策略关闭"的预留。若真挂了映射，该目录立即成为用户策略无权约束的 access=all
    // 白通道——届时必须重新评估这个 SIZE_MAX，而不是直接沿用。
    {
        Rule dynobox, dynoboxDeep;
        buildRule(L"/dynobox", L"all", L"allow", dynobox);
        buildRule(L"/dynobox/**", L"all", L"allow", dynoboxDeep);
        dynobox.spec = kBuiltinSpec;
        dynoboxDeep.spec = kBuiltinSpec;
        p.m_rules.push_back(std::move(dynobox));
        p.m_rules.push_back(std::move(dynoboxDeep));
    }

    // core 解析出的用户规则 → Windows Rule（含 literalPrefix 热路径预筛）。
    // [[roots]] 不再支持（core 侧 fail-loud 拒绝；Windows 的虚拟根映射由
    // addAutomountRoots/addSrcRoot 运行时构造，不经策略文件）。
    for (const auto& cr : coreRules) {
        Rule rule;
        std::wstring accessW(cr.access.begin(), cr.access.end());
        std::wstring permW(cr.perm.begin(), cr.perm.end());
        if (!buildRule(cr.path, accessW, permW, rule))
            throw std::runtime_error("rules 字段非法: " + wideToUtf8(cr.path));
        p.m_rules.push_back(std::move(rule));
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

const Rule* Policy::bestMatch(const std::wstring& vpath, const std::string& pathKey,
                              const std::string& kind, size_t& index) const
{
    const Rule* best = nullptr;
    for (size_t i = 0; i < m_rules.size(); i++) {
        const Rule& rule = m_rules[i];
        // 这里刻意**不做**"遇到更不具体的规则就 break"的提前结束（core 的快路径
        // 有该优化）：那会把"m_rules 恒按 spec 降序"变成判定正确性的前提，顺序
        // 一旦不成立就会跳过一条本可胜出的更严规则（漏 deny 是 fail-open 方向）。
        // 代价可控——规则表是装载期一次性构建的定长向量（内置两条 + core 排序后
        // 的用户规则），170+ 条规则的全表预筛在微秒量级；真要做这个优化，应先让
        // 规则表在装载后自证降序，而不是在判定路径上假设它。
        if (!rule.matches(vpath, pathKey, kind)) continue;
        if (!best || rule.spec > best->spec ||
            (rule.spec == best->spec && permRank(rule.perm) > permRank(best->perm))) {
            best = &rule;
            index = i;
        }
    }
    return best;
}

bool Policy::check(const std::wstring& vpath, const std::string& kind, std::string* why)
{
    // 路径键每次判定只算一次（小写 + UTF-8），全部规则复用它做 glob 匹配
    const std::string pathKey = corePathKey(vpath);
    size_t index = 0;
    const Rule* rule = bestMatch(vpath, pathKey, kind, index);
    if (rule) {
        if (rule->perm != Perm::Ask) {
            bool allowed = rule->perm == Perm::Allow;
            if (why) *why = std::string("rule#") + std::to_string(index) +
                              (allowed ? " allow" : " deny");
            return allowed;
        }
        // 静态 ask 规则 → 先查端点下发的子树授权
        if (matchGrant(vpath, pathKey, kind)) {
            if (why) *why = std::string("rule#") + std::to_string(index) + "+grant";
            return true;
        }
        bool allowed = false;
        bool ok = askUpstreamAndCache(vpath, kind, allowed);
        if (why) *why = std::string("rule#") + std::to_string(index) + "+ask(" +
                        (ok ? (allowed ? "allow" : "deny") : "fail-closed") + ")";
        return allowed;
    }
    bool allowed = m_default == "allow";
    if (why) *why = std::string("default:") + m_default;
    return allowed;
}

bool Policy::checkDenyOnly(const std::wstring& vpath, const std::string& kind) const
{
    // 探测只看最优规则的 deny 硬边界：deny -> 拦截，allow/ask -> 放行（不触发 ask）。
    const std::string pathKey = corePathKey(vpath);
    size_t index = 0;
    const Rule* rule = bestMatch(vpath, pathKey, kind, index);
    if (!rule) return m_default == "deny";
    return rule->perm == Perm::Deny;
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

bool Policy::matchGrant(const std::wstring& vpath, const std::string& pathKey,
                        const std::string& kind) const
{
    long long now = (long long)GetTickCount64();
    std::lock_guard<std::mutex> lock(m_state->mutex);
    for (auto it = m_state->grants.begin(); it != m_state->grants.end();) {
        if (it->expiryTicks <= now) it = m_state->grants.erase(it);
        else ++it;
    }
    for (const auto& g : m_state->grants) {
        if (g.rule.matches(vpath, pathKey, kind)) return true;
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