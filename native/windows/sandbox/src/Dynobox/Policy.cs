/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.IO.Pipes;
using System.Net.Http.Json;
using System.Text;
using System.Text.RegularExpressions;

namespace Dynobox;

public static class AccessKind
{
    public const string Read = "read";
    public const string Write = "write";
    public const string Execute = "execute";
    public static readonly string[] All = { Read, Write, Execute };
}

/// <summary>一条访问控制规则（静态策略或端点下发的临时授权）。</summary>
public sealed class Rule
{
    private readonly Regex _re;

    public Rule(string path, string access, string perm)
    {
        Path = path;
        Access = access;
        Perm = perm;
        _re = GlobToRegex(path);
    }

    public string Path { get; }
    public string Access { get; }
    public string Perm { get; }

    public string RegexPattern => _re.ToString();

    public bool Matches(string vpath, string kind) =>
        (Access == "all" || Access == kind) && _re.IsMatch(vpath);

    /// <summary>
    /// 策略路径 -> 正则。`**` 跨层级、`*` 单层级、`?` 单字符；
    /// 约定 `/dir/**` 同时匹配 `/dir` 本身。
    /// </summary>
    public static Regex GlobToRegex(string pat)
    {
        pat = pat.TrimEnd('/');
        if (pat.Length == 0) pat = "/";
        if (pat.EndsWith("/**"))
        {
            // "/**"（整盘/根通配）需要独立处理：base 为 "/" 时不能再叠斜杠
            if (pat == "/**")
                return new Regex("^/.*$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
            var baseRe = GlobToRegex(pat[..^3]).ToString();
            return new Regex(baseRe[..^1] + "(?:/.*)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        }

        var sb = new StringBuilder("^");
        for (var i = 0; i < pat.Length;)
        {
            var c = pat[i];
            if (c == '*')
            {
                if (pat[i..].StartsWith("**"))
                {
                    sb.Append(".*");
                    i += 2;
                }
                else
                {
                    sb.Append("[^/]*");
                    i += 1;
                }
            }
            else if (c == '?')
            {
                sb.Append("[^/]");
                i += 1;
            }
            else
            {
                sb.Append(Regex.Escape(c.ToString()));
                i += 1;
            }
        }
        sb.Append('$');
        return new Regex(sb.ToString(), RegexOptions.IgnoreCase | RegexOptions.Compiled);
    }
}

public sealed class AskConfig
{
    public string Endpoint { get; set; } = "";
    public string Token { get; set; } = "";
    public int TimeoutMs { get; set; } = 2000;
    public int CacheTtlSeconds { get; set; } = 60;
    public int GrantTtlSeconds { get; set; } = 300;   // 端点下发授权的默认有效期（响应可带 ttl，上限 1 小时）

    /// <summary>pipe://名字 => 命名管道；http(s):// => HTTP。</summary>
    public string Transport => Endpoint.StartsWith("pipe://") ? "pipe" : "http";

    public string PipeName => Endpoint["pipe://".Length..];
}

/// <summary>端点下发的子树授权（协议 v2）。</summary>
public sealed record Grant(string Path, string Access, int TtlSeconds);

/// <summary>策略：TOML 加载 + 顺序匹配 + ask 双传输（HTTP / 命名管道）+ 子树授权。</summary>
public sealed class Policy
{
    private readonly record struct CacheEntry(bool Allowed, DateTime Expiry);
    private readonly record struct Ephemeral(Rule Rule, DateTime Expiry);

    private readonly Dictionary<(string, string), CacheEntry> _cache = new();
    private readonly List<Ephemeral> _grants = new();
    // The per-request cancellation token owns the ask deadline (the host UI may
    // wait longer than HttpClient's default 100 seconds).
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly object _gate = new();
    private NamedPipeAskTransport? _pipe;

    public string Default { get; private set; } = "deny";
    public List<Rule> Rules { get; } = new();
    public AskConfig Ask { get; } = new();
    /// <summary>多根映射（[[roots]] virtual/real）。非空时启用多根模式。</summary>
    public List<(string Virtual, string Real)> Roots { get; } = new();

    public static Policy Load(string path)
    {
        var model = MiniToml.Parse(File.ReadAllText(path));
        var policy = new Policy();

        if (model.TryGetValue("default", out var def))
            policy.Default = def.ToString()!.ToLowerInvariant();
        if (policy.Default is not ("allow" or "deny"))
            throw new FormatException($"default 必须是 allow|deny，当前: {policy.Default}");

        if (model.TryGetValue("ask", out var askObj) && askObj is MiniToml.TomlTable ask)
        {
            if (ask.TryGetValue("endpoint", out var ep)) policy.Ask.Endpoint = ep.ToString() ?? "";
            if (ask.TryGetValue("token", out var token)) policy.Ask.Token = token.ToString() ?? "";
            if (ask.TryGetValue("timeout_ms", out var t)) policy.Ask.TimeoutMs = Convert.ToInt32(t);
            if (ask.TryGetValue("cache_ttl_seconds", out var c)) policy.Ask.CacheTtlSeconds = Convert.ToInt32(c);
            if (ask.TryGetValue("grant_ttl_seconds", out var g)) policy.Ask.GrantTtlSeconds = Convert.ToInt32(g);
        }

        // 内置引导区：/dynobox（子进程 exe 副本与自举数据），管理进程与
        // 沙箱子进程都需要读/执行；置于规则表首，用户规则无法意外关闭它
        policy.Rules.Add(new Rule("/dynobox", "all", "allow"));
        policy.Rules.Add(new Rule("/dynobox/**", "all", "allow"));

        if (model.TryGetValue("roots", out var rootsObj) && rootsObj is MiniToml.TomlTableArray rootsArr)
        {
            foreach (var r in rootsArr)
            {
                if (!r.ContainsKey("virtual") || !r.ContainsKey("real"))
                    throw new FormatException("roots 项缺少 virtual/real");
                policy.Roots.Add((NormalizeVirtualPath(r["virtual"].ToString()!),
                           r["real"].ToString()!));
            }
        }

        if (model.TryGetValue("rules", out var rulesObj) && rulesObj is MiniToml.TomlTableArray rules)
        {
            for (var i = 0; i < rules.Count; i++)
            {
                var r = rules[i];
                foreach (var key in new[] { "path", "access", "perm" })
                    if (!r.ContainsKey(key))
                        throw new FormatException($"rules[{i}] 缺少字段 {key}");
                var access = r["access"].ToString()!.ToLowerInvariant();
                var perm = r["perm"].ToString()!.ToLowerInvariant();
                if (access is not ("read" or "write" or "execute" or "all"))
                    throw new FormatException($"rules[{i}].access 非法: {access}");
                if (perm is not ("allow" or "ask" or "deny"))
                    throw new FormatException($"rules[{i}].perm 非法: {perm}");
                var vp = NormalizeVirtualPath(r["path"].ToString()!);
                policy.Rules.Add(new Rule(vp, access, perm));
            }
        }
        return policy;
    }

    /// <summary>Dokan 传来的 "\docs\a.txt" -> "/docs/a.txt"。</summary>
    public static string NormalizeVirtualPath(string name)
    {
        var p = name.Replace('\\', '/').TrimStart('/');
        return "/" + p;
    }

    /// <summary>
    /// 返回 (是否放行, 决策说明)。求值顺序：静态规则（deny/allow 是硬边界）→
    /// 静态 ask 规则命中时先查端点下发的临时授权 → 都没有才发起新的 ask。
    /// 临时授权只在静态 ask 规则命中时生效，永远不会越过 deny/allow/default。
    /// </summary>
    public (bool Allowed, string Why) Check(string vpath, string kind)
    {
        // The sandbox creates a per-run AppContainer profile named
        // dynobox-*. Windows stores that profile's private AC data under
        // the user's Packages directory. PowerShell may create policy-test
        // scripts and module-analysis caches there; these are sandbox runtime
        // files and must never round-trip through the host authorization UI.
        if (IsInternalAppContainerPath(vpath))
            return (true, "internal-appcontainer");

        for (var i = 0; i < Rules.Count; i++)
        {
            var rule = Rules[i];
            if (!rule.Matches(vpath, kind)) continue;
            if (rule.Perm != "ask") return (rule.Perm == "allow", $"rule#{i}");
            // 静态策略委托给端点：先看端点之前下发的子树授权
            if (MatchGrant(vpath, kind)) return (true, $"rule#{i}+grant");
            var (allowed, grants) = AskUpstream(vpath, kind);
            if (grants is { Count: > 0 }) InstallGrants(grants);
            return (allowed, $"rule#{i}+ask({(allowed ? "allow" : "deny")})");
        }
        return (Default == "allow", $"default:{Default}");
    }

    /// <summary>沙箱为每次运行创建的 AppContainer 私有 AC 数据不是用户数据；
    /// MirrorFs 的回收站分支同样用它排除内部文件（直接删除，不进回收站）。</summary>
    public static bool IsInternalAppContainerPath(string vpath)
    {
        var normalized = NormalizeVirtualPath(vpath);
        return Regex.IsMatch(
            normalized,
            @"^/[A-Za-z]/Users/[^/]+/AppData/Local/Packages/dynobox-[^/]+/AC(?:/|$)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    // -- 端点下发的临时授权 ---------------------------------------------------

    public void InstallGrants(IEnumerable<Grant> grants)
    {
        var now = DateTime.UtcNow;
        lock (_gate)
        {
            foreach (var g in grants)
            {
                var ttl = Math.Clamp(g.TtlSeconds, 0, 3600);
                _grants.Add(new Ephemeral(
                    new Rule(NormalizeVirtualPath(g.Path), g.Access.ToLowerInvariant(), "allow"),
                    now.AddSeconds(ttl)));
                Log.Info("[GRANT] + {0} {1} (ttl={2}s)", g.Access, g.Path, ttl);
            }
        }
    }

    private bool MatchGrant(string vpath, string kind)
    {
        lock (_gate)
        {
            _grants.RemoveAll(g => g.Expiry <= DateTime.UtcNow);
            return _grants.Any(g => g.Rule.Matches(vpath, kind));
        }
    }

    // -- ask 上游 -------------------------------------------------------------

    private (bool Allowed, List<Grant>? Grants) AskUpstream(string vpath, string kind)
    {
        var key = (vpath.ToLowerInvariant(), kind);
        if (Ask.CacheTtlSeconds > 0)
        {
            lock (_gate)
            {
                if (_cache.TryGetValue(key, out var hit) && hit.Expiry > DateTime.UtcNow)
                    return (hit.Allowed, null);
            }
        }

        // 失败（null）不缓存——否则瞬时故障产生的 deny 会污染缓存整个 TTL 周期
        var result = Ask.Transport == "pipe"
            ? AskPipe(vpath, kind)
            : AskHttp(vpath, kind);
        if (result is { } res)
        {
            if (Ask.CacheTtlSeconds > 0)
            {
                lock (_gate)
                {
                    _cache[key] = new CacheEntry(res.Allowed, DateTime.UtcNow.AddSeconds(Ask.CacheTtlSeconds));
                }
            }
            return (res.Allowed, res.Grants);
        }
        return (false, null);
    }

    private sealed record AskResult(bool Allowed, List<Grant>? Grants);

    private AskResult? AskHttp(string vpath, string kind)
    {
        if (string.IsNullOrEmpty(Ask.Endpoint))
        {
            Log.Warn("[ASK] 未配置上游端点，按 deny 处理: {0} {1}", kind, vpath);
            return null;
        }

        var t0 = DateTime.UtcNow;
        try
        {
            using var cts = new CancellationTokenSource(Ask.TimeoutMs);
            // 必须用定长 StringContent（带 Content-Length）：chunked 会被
            // python http.server 一类端点拒绝
            var json = System.Text.Json.JsonSerializer.Serialize(new { path = vpath, access = kind });
            using var content = new StringContent(json, Encoding.UTF8, "application/json");
            using var request = new HttpRequestMessage(HttpMethod.Post, Ask.Endpoint) { Content = content };
            if (!string.IsNullOrWhiteSpace(Ask.Token))
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", Ask.Token);
            using var resp = _http.SendAsync(request, cts.Token).GetAwaiter().GetResult();
            resp.EnsureSuccessStatusCode();
            using var doc = System.Text.Json.JsonDocument.Parse(
                resp.Content.ReadAsStringAsync(cts.Token).GetAwaiter().GetResult());
            var decision = doc.RootElement.TryGetProperty("decision", out var d)
                ? d.GetString()?.ToLowerInvariant() : null;
            // decision 缺失或不可识别属于不合法响应：按 deny 处理且不进缓存，
            // 否则端点一次瞬时故障（坏 JSON、代理错误页）会把 deny 固化整个 TTL。
            if (decision is not ("allow" or "deny"))
            {
                Log.Warn("[ASK] 响应不含合法 decision，按 deny（不缓存）: {0} {1}", kind, vpath);
                return null;
            }
            var grants = ParseGrants(doc.RootElement);
            Log.Info("[ASK] {0} {1} -> {2} ({3}ms, +{4} grants)", kind, vpath,
                decision, (long)(DateTime.UtcNow - t0).TotalMilliseconds, grants.Count);
            return new AskResult(decision == "allow", grants);
        }
        catch (Exception ex)
        {
            Log.Warn("[ASK] 上游调用失败({0}ms)，按 deny（不缓存）: {1} {2} err={3}",
                (long)(DateTime.UtcNow - t0).TotalMilliseconds, kind, vpath, ex.Message);
            return null;
        }
    }

    private static List<Grant> ParseGrants(System.Text.Json.JsonElement root)
    {
        var grants = new List<Grant>();
        if (root.TryGetProperty("grants", out var arr) && arr.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            foreach (var g in arr.EnumerateArray())
            {
                try
                {
                    var path = g.GetProperty("path").GetString()!;
                    var access = g.GetProperty("access").GetString()!.ToLowerInvariant();
                    var ttl = g.TryGetProperty("ttl", out var t)
                        ? t.ValueKind == System.Text.Json.JsonValueKind.Number
                            ? t.GetInt32()
                            : int.TryParse(t.GetString(), out var v) ? v : 300
                        : 300;
                    if (access is "read" or "write" or "execute" or "all")
                        grants.Add(new Grant(path, access, Math.Clamp(ttl, 0, 3600)));
                }
                catch (Exception ex)
                {
                    Log.Warn("[GRANT] 非法授权项，忽略: {0}", ex.Message);
                }
            }
        }
        return grants;
    }

    // -- 命名管道传输：持久连接 + 4 字节小端长度前缀 + JSON 帧 -------------------
    // 失败/超时 => null（不缓存）并丢弃连接，下次事务重连。

    private NamedPipeAskTransport? Pipe => _pipe ??= new NamedPipeAskTransport(Ask.PipeName);

    private AskResult? AskPipe(string vpath, string kind)
    {
        var t0 = DateTime.UtcNow;
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(new { path = vpath, access = kind });
            using var cts = new CancellationTokenSource(Ask.TimeoutMs);
            var resp = Pipe!.Transact(Encoding.UTF8.GetBytes(json), cts.Token);
            using var doc = System.Text.Json.JsonDocument.Parse(resp);
            var decision = doc.RootElement.TryGetProperty("decision", out var d)
                ? d.GetString()?.ToLowerInvariant() : null;
            if (decision is not ("allow" or "deny"))
            {
                Log.Warn("[ASK] 响应不含合法 decision，按 deny（不缓存）: {0} {1}", kind, vpath);
                return null;
            }
            var grants = ParseGrants(doc.RootElement);
            Log.Info("[ASK] {0} {1} -> {2} ({3:F1}ms, +{4} grants) [pipe]", kind, vpath,
                decision, (DateTime.UtcNow - t0).TotalMilliseconds, grants.Count);
            return new AskResult(decision == "allow", grants);
        }
        catch (Exception ex)
        {
            Log.Warn("[ASK] 管道调用失败({0:F1}ms)，按 deny（不缓存）: {1} {2} err={3}: {4} @ {5}",
                (DateTime.UtcNow - t0).TotalMilliseconds, kind, vpath,
                ex.GetType().Name, ex.Message, ex.StackTrace?.Split('\n')[0]?.Trim());
            _pipe?.Dispose();
            _pipe = null;
            return null;
        }
    }
}

/// <summary>命名管道客户端：连一次常驻复用，事务串行化（问询频率低，足够）。</summary>
public sealed class NamedPipeAskTransport : IDisposable
{
    private readonly string _pipeName;
    private NamedPipeClientStream? _stream;
    private readonly object _gate = new();

    public NamedPipeAskTransport(string pipeName) => _pipeName = pipeName;

    public byte[] Transact(byte[] request, CancellationToken ct)
    {
        lock (_gate)
        {
            var stream = _stream;
            if (stream is null || !stream.IsConnected)
            {
                stream?.Dispose();
                stream = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut,
                    PipeOptions.Asynchronous);
                // 连接与读写都必须消费取消令牌：阻塞式 API 忽略 ct 会让挂起的
                // 端点把 ask 永久卡死（fail-closed 超时失效，且锁内独占整条管线）。
                Log.Debug("[PIPE] connect {0}", _pipeName);
                stream.ConnectAsync(ct).GetAwaiter().GetResult();
                Log.Debug("[PIPE] connected");
                stream.ReadMode = PipeTransmissionMode.Byte;
                _stream = stream;
            }

            var lenBytes = BitConverter.GetBytes(request.Length);
            stream.Write(lenBytes);
            stream.Write(request);
            stream.Flush();
            Log.Debug("[PIPE] request sent ({0} bytes)", request.Length);

            var lenBuf = ReadExact(stream, 4, ct);
            Log.Debug("[PIPE] reply header received");
            var n = BitConverter.ToInt32(lenBuf);
            if (n is < 0 or > 4 * 1024 * 1024)
                throw new IOException($"非法帧长度 {n}");
            var body = ReadExact(stream, n, ct);
            return body;
        }
    }

    private static byte[] ReadExact(PipeStream s, int n, CancellationToken ct)
    {
        var buf = new byte[n];
        var read = 0;
        while (read < n)
        {
            // 异步读在超时触发时取消挂起的 IRP（管道以 Asynchronous 创建）；
            // 超时后连接的帧状态不可信，由上层弃连重连。必须经 AsTask 消费：
            // .NET 8 PipeStream 的定制 ValueTaskSource 被直接 GetResult 同步
            // 消费时，即使读成功完成也会误抛 InvalidOperationException。
            var k = s.ReadAsync(buf.AsMemory(read, n - read), ct).AsTask()
                     .GetAwaiter().GetResult();
            if (k == 0) throw new IOException("管道已关闭");
            read += k;
        }
        return buf;
    }

    public void Dispose()
    {
        lock (_gate) _stream?.Dispose();
    }
}
