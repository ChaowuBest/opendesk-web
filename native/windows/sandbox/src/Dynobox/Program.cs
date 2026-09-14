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
          dynobox run  --policy <rules.toml> [--src DIR] [--automount] [--upstream URL] [--token TOKEN] [--mount X] [--log-file FILE] -- <子进程命令行>
          dynobox mount --policy <rules.toml> [--src DIR] [--automount] [--upstream URL] [--token TOKEN] [--mount X]
          dynobox endpoint [--port 8080] [--pipe 管道名] [--default deny]

        示例:
          dynobox run --automount --policy examples\rules_drive.toml ^
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

        var sub = args[0];
        args = args[1..];

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
                "endpoint" => RunEndpoint(args),
                "debug-rules" => RunDebugRules(args),
                "mount" => RunMount(args),
                "run" => RunSandbox(args, childCmd),
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

    private static int Unknown(string sub)
    {
        Log.Error("未知子命令: {0}", sub);
        Console.WriteLine(Usage);
        return 2;
    }

    private static (string Policy, string? Src, string? Upstream, string? Token, string? Mount, bool Automount,
        List<(string From, string To)> PathMaps) Parse(string[] args, bool requireCmd)
    {
        string? policy = null, src = null, upstream = null, token = null, mount = null;
        var automount = false;
        var pathMaps = new List<(string From, string To)>();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--automount": automount = true; break;
                case "--policy" when i + 1 < args.Length: policy = args[++i]; break;
                case "--src" when i + 1 < args.Length: src = args[++i]; break;
                case "--upstream" when i + 1 < args.Length: upstream = args[++i]; break;
                case "--token" when i + 1 < args.Length: token = args[++i]; break;
                case "--mount" when i + 1 < args.Length: mount = args[++i]; break;
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
        return (policy, src, upstream, token, mount, automount, pathMaps);
    }

    private static Sandbox Build(string[] args)
    {
        var (policyFile, src, upstream, token, mount, automount, pathMaps) = Parse(args, requireCmd: false);
        var policy = Policy.Load(policyFile);
        if (src is not null)
        {
            var srcFull = Path.GetFullPath(src);
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
        var sandbox = new Sandbox(policy, automount, mount);
        sandbox.PathMaps.AddRange(pathMaps);
        return sandbox;
    }

    private static int RunSandbox(string[] args, string[] childCmd)
    {
        if (childCmd.Length == 0)
        {
            Log.Error("run 子命令需要在 -- 之后提供子进程命令行");
            Console.WriteLine(Usage);
            return 2;
        }
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

        var rc = sandbox.Run(string.Join(' ', childCmd));
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
