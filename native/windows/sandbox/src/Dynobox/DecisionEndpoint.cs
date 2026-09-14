/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.IO.Pipes;
using System.Net;
using System.Text;
using System.Text.Json;

namespace Dynobox;

/// <summary>内置测试用决策端点（对应 Python 版 tools/ask_endpoint.py）。</summary>
public static class DecisionEndpoint
{
    private static readonly List<Dictionary<string, string>> RequestLog = new();
    private static readonly object Gate = new();
    private static string _default = "deny";

    public static int Run(int port, string defaultDecision) => RunHttp(port, defaultDecision);

    // ---------------- 决策逻辑（HTTP 与管道共用） ----------------

    private static (string Decision, List<Dictionary<string, object>> Grants) Decide(
        string path, string access)
    {
        var grants = new List<Dictionary<string, object>>();
        if (path.StartsWith("/slow"))
        {
            Thread.Sleep(8000);
            return ("deny", grants);
        }
        if (path.StartsWith("/notes"))
        {
            grants.Add(G("/notes/**", "read"));
            return ("allow", grants);
        }
        if (path.StartsWith("/scratch"))
        {
            grants.Add(G("/scratch/**", "all"));
            return ("allow", grants);
        }
        if (path.StartsWith("/staging") && access == AccessKind.Write)
        {
            grants.Add(G("/staging/**", "write"));
            return ("allow", grants);
        }
        if (path.StartsWith("/reject")) return ("deny", grants);
        if (path.StartsWith("/guarded")) return ("allow", grants); // 有意不下发授权：每次新路径重新问询
        if (path.StartsWith("/tools/ask")) return ("allow", grants);
        return (_default, grants);

        static Dictionary<string, object> G(string path, string access) => new()
        {
            ["path"] = path, ["access"] = access, ["ttl"] = 120,
        };
    }

    private static void Record(string path, string access, string decision)
    {
        lock (Gate)
            RequestLog.Add(new()
            {
                ["ts"] = DateTime.Now.ToString("HH:mm:ss"),
                ["path"] = path, ["access"] = access, ["decision"] = decision,
            });
        Log.Info("[decide] {0,-7} {1,-32} -> {2}", access, path, decision);
    }

    // ---------------- HTTP 服务端 ----------------

    public static int RunHttp(int port, string defaultDecision)
    {
        _default = defaultDecision.ToLowerInvariant();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        Log.Info("决策端点已启动: http://127.0.0.1:{0}/decide  (兜底={1})", port, _default);
        Log.Info("查看请求日志: GET /log ；Ctrl+C 退出");
        var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        try
        {
            while (!cts.IsCancellationRequested)
            {
                var ctxTask = listener.GetContextAsync();
                Task.WaitAny(ctxTask, Task.Delay(Timeout.Infinite, cts.Token));
                if (cts.IsCancellationRequested) break;
                var ctx = ctxTask.Result;
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }
        catch (Exception) when (cts.IsCancellationRequested) { }
        Log.Info("端点已退出");
        return 0;
    }

    private static void Handle(HttpListenerContext ctx)
    {
        try
        {
            var path = ctx.Request.Url?.AbsolutePath ?? "/";
            switch (path.TrimEnd('/'))
            {
                case "/health":
                    Write(ctx, 200, """{"status":"ok"}""");
                    break;
                case "/log":
                    lock (Gate) Write(ctx, 200, JsonSerializer.Serialize(RequestLog));
                    break;
                case "/decide" when ctx.Request.HttpMethod == "POST":
                {
                    using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
                    HandleDecide(ctx, reader.ReadToEnd());
                    break;
                }
                default:
                    Write(ctx, 404, """{"error":"not found"}""");
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Warn("请求处理失败: {0}", ex.Message);
            try { Write(ctx, 400, """{"decision":"deny"}"""); } catch { }
        }
    }

    private static void HandleDecide(HttpListenerContext ctx, string body)
    {
        var (path, access) = ParseDecide(body);
        var (decision, grants) = Decide(path, access);
        Record(path, access, decision);
        Write(ctx, 200, JsonSerializer.Serialize(
            new { decision, grants }));
    }

    private static (string Path, string Access) ParseDecide(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return (
                doc.RootElement.TryGetProperty("path", out var p) ? p.GetString() ?? "/" : "/",
                doc.RootElement.TryGetProperty("access", out var a) ? a.GetString() ?? "read" : "read");
        }
        catch (JsonException)
        {
            return ("/", "read");
        }
    }

    // ---------------- 命名管道服务端 ----------------
    // 帧格式：4 字节小端长度 + JSON。与沙箱侧 NamedPipeAskTransport 一致。

    public static int RunPipe(string pipeName, string defaultDecision)
    {
        _default = defaultDecision.ToLowerInvariant();
        Log.Info("决策端点已启动（命名管道）: \\\\.\\pipe\\{0}  (兜底={1})", pipeName, _default);
        var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        try
        {
            while (!cts.IsCancellationRequested)
            {
                var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);
                var waitTask = server.WaitForConnectionAsync(cts.Token);
                Task.WaitAny(waitTask, Task.Delay(Timeout.Infinite, cts.Token));
                if (cts.IsCancellationRequested) { server.Dispose(); break; }
                var s = server;
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try { ServePipeClient(s); }
                    catch (Exception ex) { Log.Debug("管道客户端异常: {0}", ex.Message); }
                });
            }
        }
        catch (Exception) when (cts.IsCancellationRequested) { }
        Log.Info("端点已退出");
        return 0;
    }

    private static void ServePipeClient(NamedPipeServerStream server)
    {
        try
        {
            ServePipeClientInner(server);
        }
        finally
        {
            server.Dispose();
        }
    }

    private static void ServePipeClientInner(NamedPipeServerStream server)
    {
        while (server.IsConnected)
        {
            var lenBuf = ReadExact(server, 4);
            var n = BitConverter.ToInt32(lenBuf);
            if (n is < 0 or > 4 * 1024 * 1024) throw new IOException($"非法帧长度 {n}");
            var body = ReadExact(server, n);
            var (path, access) = ParseDecide(Encoding.UTF8.GetString(body));
            var (decision, grants) = Decide(path, access);
            Record(path, access, decision);
            var resp = JsonSerializer.SerializeToUtf8Bytes(
                new { decision, grants },
                new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var len = BitConverter.GetBytes(resp.Length);
            server.Write(len);
            server.Write(resp);
            server.Flush();
        }
    }

    private static byte[] ReadExact(PipeStream s, int n)
    {
        var buf = new byte[n];
        var read = 0;
        while (read < n)
        {
            var k = s.Read(buf, read, n - read);
            if (k == 0) throw new IOException("客户端断开");
            read += k;
        }
        return buf;
    }

    private static void Write(HttpListenerContext ctx, int code, string body)
    {
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        var bytes = Encoding.UTF8.GetBytes(body);
        ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes);
        ctx.Response.OutputStream.Close();
    }
}
