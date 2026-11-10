/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <condition_variable>
#include <memory>

#include "ask.h"
#include "core_policy.h"
#include "paths.h"

namespace sbx {

// 访问类别（与 C# 版 AccessKind 对齐）
inline constexpr const char* kAccessRead = "read";
inline constexpr const char* kAccessWrite = "write";
inline constexpr const char* kAccessExecute = "execute";
inline constexpr const char* kAccessAll = "all";

enum class Perm { Allow, Ask, Deny };

// 规则求值语义（四平台统一，与 core 的 dbox_policy_eval_static 对齐）：
// 命中规则里取 specificity 最大者；同 specificity 取 perm 更严者
// （Perm 的枚举序 Allow < Ask < Deny 与 core 的 PERM_ALLOW/ASK/DENY 数值序一致）。
// 历史实现是 first-match-wins，宽 allow 写在前面会吞掉后面更具体的 deny
// （bugs.md BUG-009 的 fail-open 陷阱），规则书写顺序因此曾经有意义。
inline int permRank(Perm p) { return static_cast<int>(p); }

struct Rule {
    std::wstring path;            // 归一化虚拟路径
    std::string access;           // read/write/execute/all
    Perm perm = Perm::Deny;
    std::wstring literalPrefix;   // 小写字面前缀（热路径预筛）
    std::wstring basePath;        // `/dir/**` 剥离出的 base：判定时排除目录自身（`/dir/**` 不覆盖 `/dir`）
    size_t spec = 0;              // 模式特异性（core 的 rule_specificity，选优用）
    CoreGlob glob;                // 预编译 glob（空句柄时回退 coreGlobMatch）

    bool matchesKind(const std::string& kind) const {
        return access == kAccessAll || access == kind;
    }
    // pathKey 必须是 corePathKey(vpath) 的结果（每次判定只算一次，全部规则复用）。
    bool matches(const std::wstring& vpath, const std::string& pathKey,
                 const std::string& kind) const;
};

// 策略：TOML 加载 + most-specific 匹配 + ask 双传输 + 子树授权 + 决策缓存。
class Policy {
public:
    Policy();
    ~Policy();
    Policy(Policy&&) noexcept;
    Policy& operator=(Policy&&) noexcept;

    // 从 TOML 文件加载并校验（失败抛 std::runtime_error）。
    static Policy loadFromFile(const std::wstring& path);

    std::string def() const { return m_default; }
    const std::vector<Rule>& rules() const { return m_rules; }
    const std::vector<RootMap>& roots() const { return m_roots; }
    const AskConfig& askConfig() const { return m_ask; }
    AskConfig& mutableAsk() { return m_ask; }
    std::vector<RootMap>& mutableRoots() { return m_roots; }

    // 单根模式（--src DIR）：把 DIR 映射到虚拟根 /。
    void addSrcRoot(const std::wstring& realDir);
    // automount：把宿主全部盘符追加为 /C -> C:\ 等映射。
    void addAutomountRoots();

    // 求值：vpath 为虚拟路径（/ 开头正斜杠）。
    bool check(const std::wstring& vpath, const std::string& kind, std::string* why = nullptr);

    // 仅检查静态 deny 硬边界（框架探测类操作使用）：ask/allow 一律放行、不触发
    // ask，但 deny 规则仍拦截——保证探测不打扰的同时不削弱 deny 防逃逸。
    bool checkDenyOnly(const std::wstring& vpath, const std::string& kind) const;

    // ask 决策的进程内缓存（TTL 来自 ask.cache_ttl_seconds）。
    bool tryCached(const std::wstring& vpath, const std::string& kind, bool& allowed) const;
    void putCached(const std::wstring& vpath, const std::string& kind, bool allowed);

    // 进程内 ask 并发并发治理阈值（见 askUpstreamAndCache）：
    //  - 同 key 并发合并：缓存 miss 窗口内的重复请求只发一次，结果在
    //    "并发合并窗口"（kAskResultCoalesceMs）内由 pending 条目共享，
    //    窗口外重新 ask（不破坏 cache_ttl_seconds=0 的"每次问询"语义）；
    //  - 并发上限：超过后在原地排队（本地端点毫秒级，32 连接足够）；
    //  - 端点失败熔断：不可达/超时后 1s 内直接 fail-closed，避免失败风暴反复打满超时。
    static constexpr size_t kMaxConcurrentAsks = 32;
    static constexpr long long kAskFailureCooldownMs = 1000;
    static constexpr long long kAskResultCoalesceMs = 500;

private:
    struct CacheEntry {
        bool allowed;
        long long expiryTicks;    // GetTickCount64 毫秒
    };
    struct Ephemeral {
        Rule rule;
        long long expiryTicks;
    };
    // ask 并发闸口：mutex/cv 不可移动，随 State 一起放在堆上。
    struct PendingAsk {
        bool done = false;
        bool allowed = false;
        long long expiryTicks = 0;   // done 后结果保留到该时刻（并发合并窗口）
    };
    struct AskGate {
        std::mutex mtx;
        std::condition_variable cv;
        size_t inFlight = 0;                   // 在途 ask 数（限流排队）
        std::map<std::wstring, PendingAsk> pending; // key -> 在途/已完成结果（合并窗口内）
        long long lastFailureTicks = 0;        // 端点上次失败时刻（熔断）
    };
    // 缓存与临时授权放在堆上：Policy 自身保持可移动（std::mutex 不可移动）。
    struct State {
        std::mutex mutex;
        std::map<std::wstring, CacheEntry> cache;   // key = lower(vpath) + '\0' + kind
        std::vector<Ephemeral> grants;
        std::unique_ptr<AskGate> askGate = std::make_unique<AskGate>();
    };

    bool matchGrant(const std::wstring& vpath, const std::string& pathKey,
                    const std::string& kind) const;
    // most-specific 选优：命中规则里 spec 最大者，同 spec 取 perm 更严者；
    // 无命中返回 nullptr，否则经 index 回传该规则在 m_rules 中的下标（why 文案用）。
    const Rule* bestMatch(const std::wstring& vpath, const std::string& pathKey,
                          const std::string& kind, size_t& index) const;
    bool askUpstreamAndCache(const std::wstring& vpath, const std::string& kind, bool& allowed);
    void installGrants(const std::vector<Grant>& grants);

    std::string m_default = "deny";
    std::vector<Rule> m_rules;
    AskConfig m_ask;
    std::vector<RootMap> m_roots;
    std::unique_ptr<State> m_state;
};

} // namespace sbx