/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

namespace Dynobox;

/// <summary>dynobox —— 基于 Dokany 的轻量级文件访问控制沙箱。</summary>
public static class Program
{
    private const string Usage = """
        用法:
          dynobox run  --policy <rules.toml> [--src DIR] [--del-to-trash] [--upstream URL] [--token TOKEN] [--mount X] [--log-file FILE] -- <子进程命令行>
          dynobox mount --policy <rules.toml> [--src DIR] [--del-to-trash] [--upstream URL] [--token TOKEN] [--mount X]
          dynobox endpoint [--port 8080] [--pipe 管道名] [--default deny]
          dynobox network-status
          dynobox network-ensure
          dynobox pipes-status
          dynobox pipes-ensure
          dynobox cleanup

        示例:
          dynobox run --policy examples\rules_drive.toml ^
              --upstream pipe://dynobox-decide -- cmd /c tests\run_tests.bat
        """;

    public static int Main(string[] args)
    {
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { /* 无控制台时忽略 */ }
        // `--` 之后是被拉起的子进程命令行，手工切分
        string[] childCmd = Array.Empty<string>();
        var cut = Array.IndexOf(args, "--");
        if (cut >= 0)
        {
            childCmd = args[(cut + 1)..];
            args = args[..cut];
        }

        if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
        {
            Console.WriteLine(Usage);
            return 0;
        }

        var verbose = args.Contains("-v") || args.Contains("--verbose");
        Log.Verbose = verbose;
        if (verbose) args = args.Where(a => a is not ("-v" or "--verbose")).ToArray();

        // 隔离模式：compatible（受限令牌，默认）/ strict（AppContainer）
        var tokenMode = "appcontainer";
        var tokenIndex = Array.IndexOf(args, "--token");
        if (tokenIndex >= 0 && tokenIndex + 1 < args.Length)
        {
            tokenMode = args[tokenIndex + 1];
            args = args.Where((a, i) => i != tokenIndex && i != tokenIndex + 1).ToArray();
        }

        var sub = args[0];
        args = args[1..];

        if (sub is "session-setup" or "install-logon-task" or "grant")
        {
            string[] ReadDirs(string[] a)
            {
                var d = Array.IndexOf(a, "--dirs");
                return d >= 0 && d + 1 < a.Length
                    ? a[d + 1].Split(';', StringSplitOptions.RemoveEmptyEntries)
                    : Array.Empty<string>();
            }

            try
            {
                var sidIndex = Array.IndexOf(args, "--sandbox-sid");
                var sandboxSid = sidIndex >= 0 && sidIndex + 1 < args.Length
                    ? args[sidIndex + 1]
                    : SandboxGrant.SandboxSidFor(LoopbackAccess.CurrentUserSid);
                switch (sub)
                {
                    case "session-setup":
                        NamedPipeAccess.ProvisionForSandboxSid(sandboxSid);
                        Console.WriteLine("session-setup OK");
                        return 0;
                    case "install-logon-task":
                        // 一次性：仅注册登录触发的重放任务（设备 ACE）。
                        // AppContainer 模式不需要 NTFS/注册表授权（系统 ACL 已覆盖只读），
                        // 之前包含它们会因系统目录 DACL 写入被拒而整体失败。
                        SandboxGrant.InstallLogonTask(LoopbackAccess.CurrentUserSid);
                        Console.WriteLine("install-logon-task OK");
                        return 0;
                    case "grant":
                    {
                        SandboxGrant.Setup(LoopbackAccess.CurrentUserSid, ReadDirs(args));
                        Console.WriteLine("grant OK");
                        return 0;
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("{0}", ex.Message);
                try
                {
                    File.WriteAllText(Path.Combine(Path.GetTempPath(), "dynobox-grant-error.log"),
                        ex.ToString());
                }
                catch { }
                return 1;
            }
        }

        try
        {
            var logIndex = Array.IndexOf(args, "--log-file");
            if (logIndex >= 0)
            {
                if (logIndex + 1 >= args.Length) throw new ArgumentException("--log-file requires a path");
                Log.SetFile(args[logIndex + 1]);
                args = args.Take(logIndex).Concat(args.Skip(logIndex + 2)).ToArray();
            }
            return sub switch
            {
                "cleanup" => CleanupOrphans(),
                "network-status" or "network-ensure" or "network-setup" => LoopbackAccess.Run(sub, args),
                "pipes-status" or "pipes-ensure" or "pipes-setup" => NamedPipeAccess.Run(sub, args),
                "ensure-all" or "setup-all" => EnsureCompat.Run(args),
                "endpoint" => RunEndpoint(args),
                "debug-rules" => RunDebugRules(args),
                "mount" => RunMount(args),
                "run" => RunSandbox(args, childCmd, tokenMode),
                _ => Unknown(sub),
            };
        }
        catch (Exception ex)
        {
            Log.Error("{0}", ex.Message);
            return 1;
        }
        finally { Log.Close(); }
    }

    /// <summary>清理被强制结束的沙箱运行遗留的孤儿卷（系统级卡死的根源）。</summary>
    private static int CleanupOrphans()
    {
        var cleaned = MountSweep.Sweep();
        Console.WriteLine(cleaned.Count == 0
            ? "没有发现孤儿卷"
            : "已清理: " + string.Join(", ", cleaned.Select(l => l + ":")));
        return 0;
    }

    private static int Unknown(string sub)
    {
        Log.Error("未知子命令: {0}", sub);
        Console.WriteLine(Usage);
        return 2;
    }

    private static (string Policy, string? Src, string? Upstream, string? Token, string? Mount,
        List<(string From, string To)> PathMaps, bool DelToTrash,
        Dictionary<string, string> EnvExtra) Parse(string[] args, bool requireCmd)
    {
        string? policy = null, src = null, upstream = null, token = null, mount = null;
        var delToTrash = false;
        var pathMaps = new List<(string From, string To)>();
        var envExtra = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--del-to-trash": delToTrash = true; break;
                case "--policy" when i + 1 < args.Length: policy = args[++i]; break;
                case "--src" when i + 1 < args.Length: src = args[++i]; break;
                case "--upstream" when i + 1 < args.Length: upstream = args[++i]; break;
                case "--token" when i + 1 < args.Length: token = args[++i]; break;
                case "--mount" when i + 1 < args.Length: mount = args[++i]; break;
                // 透传子进程环境变量（工具链缓存重定向等）：--env NAME=VALUE，可重复
                case "--env" when i + 1 < args.Length:
                {
                    var kv = args[++i];
                    var eq = kv.IndexOf('=');
                    if (eq <= 0 || eq == kv.Length - 1)
                    {
                        Log.Error("--env 格式应为 NAME=VALUE: {0}", kv);
                        Console.WriteLine(Usage);
                        Environment.Exit(2);
                    }
                    envExtra[kv[..eq]] = kv[(eq + 1)..];
                    break;
                }
                case "--map" when i + 1 < args.Length:
                {
                    var m = args[++i];
                    var eq = m.IndexOf('=');
                    if (eq <= 0)
                    {
                        Log.Error("--map 格式应为 旧前缀=新前缀: {0}", m);
                        Console.WriteLine(Usage);
                        Environment.Exit(2);
                    }
                    pathMaps.Add((m[..eq].TrimEnd('\\', '/'), m[(eq + 1)..].TrimEnd('\\', '/')));
                    break;
                }
                default:
                    Log.Error("无法识别的参数: {0}", args[i]);
                    Console.WriteLine(Usage);
                    Environment.Exit(2);
                    break;
            }
        }
        if (policy is null)
        {
            Log.Error("--policy 为必填");
            Console.WriteLine(Usage);
            Environment.Exit(2);
        }
        return (policy, src, upstream, token, mount, pathMaps, delToTrash, envExtra);
    }

    private static Sandbox Build(string[] args, string tokenMode = "compatible")
    {
        var (policyFile, src, upstream, token, mount, pathMaps, delToTrash, _) = Parse(args, requireCmd: false);
        var policy = Policy.Load(policyFile);
        if (src is not null)
        {
            var srcFull = Path.GetFullPath(src);
            // --src 的语义是"镜像这个已存在的目录"；目录不存在时挂载虽能成功，
            // 但之后所有 IO 都按 not-found 静默失败。启动期给出明确错误。
            if (!Directory.Exists(srcFull))
                throw new ArgumentException($"--src 目录不存在: {srcFull}");
            var root = policy.Roots.FirstOrDefault(r => r.Virtual == "/");
            if (policy.Roots.Count == 0)
                policy.Roots.Add(("/", srcFull));
            else if (root == default || !Path.GetFullPath(root.Real).Equals(
                         srcFull, StringComparison.OrdinalIgnoreCase))
                throw new FormatException("--src 不能与策略文件中的 [[roots]] 同时使用");
        }
        if (upstream is not null) policy.Ask.Endpoint = upstream;
        if (token is not null) policy.Ask.Token = token;
        Log.Info("策略: {0} 条规则, default={1}, ask={2} (timeout={3}ms, cache={4}s)",
            policy.Rules.Count, policy.Default,
            policy.Ask.Endpoint.Length == 0 ? "<未配置>" : policy.Ask.Endpoint,
            policy.Ask.TimeoutMs, policy.Ask.CacheTtlSeconds);
        var sandbox = new Sandbox(policy, mount, delToTrash, tokenMode);
        sandbox.PathMaps.AddRange(pathMaps);
        return sandbox;
    }

    private static int RunSandbox(string[] args, string[] childCmd, string tokenMode)
    {
        if (childCmd.Length == 0)
        {
            Log.Error("run 子命令需要在 -- 之后提供子进程命令行");
            Console.WriteLine(Usage);
            return 2;
        }
        // 启动前清扫被强制结束的上一次运行遗留的孤儿卷（详见 MountSweep）
        foreach (var letter in MountSweep.Sweep())
            Log.Info("[SWEEP] 启动前清理孤儿卷 {0}:", letter);
        using var sandbox = Build(args);
        try
        {
            sandbox.Mount();
        }
        catch (Exception ex)
        {
            Log.Error("挂载失败: {0}", ex.Message);
            return 1;
        }

        var (_, _, _, _, _, _, _, envExtra) = Parse(args, requireCmd: false);
        var rc = sandbox.Run(string.Join(' ', childCmd), envExtra);
        Log.Info("[RUN] 子进程退出码: {0}", rc);
        return rc;
    }

    private static int RunMount(string[] args)
    {
        using var sandbox = Build(args);
        try
        {
            sandbox.Mount();
            Log.Info("已挂载，Ctrl+C 退出");
            while (sandbox.IsRunning) Thread.Sleep(500);
        }
        catch (Exception ex)
        {
            Log.Error("挂载失败: {0}", ex.Message);
            return 1;
        }
        finally
        {
            sandbox.Unmount();
        }
        return 0;
    }

    private static int RunDebugRules(string[] args)
    {
        string? policyFile = null, path = "/Windows/win.ini", access = "read";
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--policy" && i + 1 < args.Length) policyFile = args[++i];
            else if (args[i] == "--path" && i + 1 < args.Length) path = args[++i];
            else if (args[i] == "--access" && i + 1 < args.Length) access = args[++i];
        }
        var policy = Policy.Load(policyFile!);
        Console.WriteLine($"default={policy.Default}");
        foreach (var r in policy.Rules)
            Console.WriteLine($"  rule path={r.Path} access={r.Access} perm={r.Perm} regex={r.RegexPattern}");
        foreach (var r in policy.Rules)
            Console.WriteLine($"  match({path}, {access}) -> {r.Matches(path, access)}");
        var (ok, why) = policy.Check(path, access);
        Console.WriteLine($"check -> {ok} ({why})");
        return 0;
    }

    private static int RunEndpoint(string[] args)
    {
        var port = 8080;
        var def = "deny";
        string? pipe = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[++i]);
            else if (args[i] == "--pipe" && i + 1 < args.Length) pipe = args[++i];
            else if (args[i] == "--default" && i + 1 < args.Length) def = args[++i].ToLowerInvariant();
        }
        return pipe is not null
            ? DecisionEndpoint.RunPipe(pipe, def)
            : DecisionEndpoint.RunHttp(port, def);
    }
}
