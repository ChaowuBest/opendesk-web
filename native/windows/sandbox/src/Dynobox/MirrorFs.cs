/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Text;
using DokanNet;
using Microsoft.Win32.SafeHandles;
using static DokanNet.DokanResult;
using FileAccess = DokanNet.FileAccess;

namespace Dynobox;

/// <summary>
/// 镜像文件系统：把真实目录以策略强制的方式暴露为 Dokan 卷。
/// 语义与 Python 版 mirror.py 一致：先决策（allow/ask/deny），再转发真实目录；
/// 任何回调异常一律 ACCESS_DENIED（fail-closed）。
/// </summary>
public sealed class MirrorFs : IDokanOperations
{
    private sealed class RootMap
    {
        public string Prefix = "/";   // 虚拟前缀（/、/C、/NET/server/share ...）
        public string RealRoot = "";
        public string RealTrim = "";
    }

    private readonly Policy _policy;
    private readonly List<RootMap> _roots = new();
    private readonly object _life = new();
    private readonly Dictionary<Ctx, Ctx> _ctx = new();
    // 运行时兼容 overlay 配置在子进程产生任何 I/O 之前写入，之后只读；
    // volatile 保证 Dokan 线程池上的可见性。
    private volatile string? _runtimeOverlayDirectory;
    private volatile (string From, string To)[] _runtimePathMaps = Array.Empty<(string From, string To)>();
    // Lazy 保证同一个可执行文件的内容分析（整文件读取 + 扫描）至多执行一次，
    // 且不持任何共享锁：互不相关的 exe 首次打开不会互相阻塞。
    private readonly ConcurrentDictionary<string, Lazy<string?>> _runtimeOverlays =
        new(StringComparer.OrdinalIgnoreCase);

    private sealed class Ctx
    {
        public FileStream? Stream;
        public readonly object Gate = new();
        public string RealPath = "";
    }

    /// <summary>单源模式：一个真实目录映射到虚拟根 /。</summary>
    public MirrorFs(string src, Policy policy) : this(new[] { ("/", src) }, policy) { }

    /// <summary>多根模式：virtual=/C real=C:\\ 、virtual=/NET/server/share real=\\\\server\\share ...</summary>
    public MirrorFs(IReadOnlyList<(string Virtual, string Real)> roots, Policy policy)
    {
        _policy = policy;
        foreach (var (v, r) in roots)
        {
            var prefix = Normalize(v);
            if (prefix != "/") prefix = prefix.TrimEnd('/');
            var real = Path.GetFullPath(r);
            _roots.Add(new RootMap
            {
                Prefix = prefix,
                RealRoot = real,
                RealTrim = real.TrimEnd(Path.DirectorySeparatorChar),
            });
        }
        // 长前缀优先
        _roots.Sort((a, b) => b.Prefix.Length.CompareTo(a.Prefix.Length));
    }

    /// <summary>用新的根集合重建映射（挂载盘符确定后排除自身）。</summary>
    public void RebuildRoots(IReadOnlyList<(string Virtual, string Real)> roots)
    {
        _roots.Clear();
        foreach (var (v, r) in roots)
        {
            var prefix = Normalize(v);
            if (prefix != "/") prefix = prefix.TrimEnd('/');
            var real = Path.GetFullPath(r);
            _roots.Add(new RootMap
            {
                Prefix = prefix,
                RealRoot = real,
                RealTrim = real.TrimEnd(Path.DirectorySeparatorChar),
            });
        }
        _roots.Sort((a, b) => b.Prefix.Length.CompareTo(a.Prefix.Length));
    }

    // -- 路径与策略 ----------------------------------------------------------

    private sealed class Resolved
    {
        public string RealPath = "";
        /// <summary>与 RealPath 一一对应的规范虚拟路径（折叠 .. 段、展开 8.3 短名
        /// 与尾点别名）。策略判定必须使用它：原始请求串的 .. 段或短名会让 glob
        /// 规则失配，形成 deny 规则逃逸。</summary>
        public string VirtualPath = "";
        /// <summary>RealPath 所属的根映射，供落点校验使用。</summary>
        public RootMap Map = null!;
    }

    private static readonly char Sep = Path.DirectorySeparatorChar;

    /// <summary>单源模式返回镜像源；多根模式为空串。</summary>
    public string Src =>
        _roots.Count == 1 && _roots[0].Prefix == "/" ? _roots[0].RealRoot : "";

    /// <summary>暴露根映射供启动期路径翻译（prefix / realTrim）。</summary>
    public IReadOnlyList<(string Prefix, string RealTrim)> RootMaps =>
        _roots.Select(r => (r.Prefix, r.RealTrim)).ToList();

    /// <summary>
    /// 启用后，Cleanup 阶段的最终删除不再直接抹除，而是把目标送入 Windows 回收站；
    /// 回收站不可用或移动失败时保留原文件。覆盖写、截断与 move 语义不受影响。
    /// 挂载后不再变更，Dokan 线程池仅做读取。
    /// </summary>
    public bool DeleteToTrash { get; set; }

    /// <summary>配置当前运行的可执行文件内容兼容 overlay。
    /// 仅在挂载后、子进程启动前调用一次；此后配置只读。</summary>
    public void ConfigureRuntimeCompatibility(
        string overlayDirectory,
        IEnumerable<(string From, string To)> pathMaps)
    {
        _runtimePathMaps = pathMaps.ToArray();
        _runtimeOverlays.Clear();
        _runtimeOverlayDirectory = Path.GetFullPath(overlayDirectory);
    }

    private string? GetRuntimeOverlay(string real)
    {
        if (!real.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return null;
        var overlayDirectory = _runtimeOverlayDirectory;
        if (overlayDirectory is null ||
            real.StartsWith(overlayDirectory + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase))
            return null;
        return _runtimeOverlays.GetOrAdd(
            real,
            key => new Lazy<string?>(() => AnalyzeRuntimeOverlay(key, overlayDirectory))).Value;
    }

    /// <summary>在 Lazy 工厂内执行（每个路径至多一次，无共享锁）：读取整个文件
    /// 做内容级兼容分析并按需生成 overlay 副本。null（无需改写或分析失败）同样
    /// 缓存，避免每次打开都重复整文件扫描。</summary>
    private string? AnalyzeRuntimeOverlay(string real, string overlayDirectory)
    {
        try
        {
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(real)))[..16];
            var name = hash + "-" + Path.GetFileName(real);
            var destination = Path.Combine(overlayDirectory, name);
            if (RuntimeCompatibility.PrepareExecutable(real, destination, _runtimePathMaps))
            {
                Log.Info("[COMPAT] 为可执行文件创建沙箱 overlay: {0}", real);
                return destination;
            }
        }
        catch (Exception ex)
        {
            Log.Debug("[COMPAT] 可执行文件 overlay 跳过 {0}: {1}", real, ex.Message);
        }
        return null;
    }

    private RootMap? FindMapping(string vpath)
    {
        foreach (var r in _roots)
        {
            if (r.Prefix == "/") return vpath.StartsWith("/") ? r : null;
            if (vpath.Equals(r.Prefix, StringComparison.OrdinalIgnoreCase) ||
                vpath.StartsWith(r.Prefix + "/", StringComparison.OrdinalIgnoreCase))
                return r;
        }
        return null;
    }

    private bool IsSyntheticContainer(string vpath)
    {
        // 多根模式下，卷根与“映射前缀的父级装配节点”（如 /NET）是虚拟容器
        if (_roots.Any(r => r.Prefix == "/")) return false;
        if (vpath == "/") return true;
        return _roots.Any(r => r.Prefix.StartsWith(vpath.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>/dynobox 是沙箱内部引导区（每次运行重建的管理副本与 overlay），
    /// 不是用户数据；即使启用回收站也按原语义直接清除，避免内部副本灌满回收站。
    /// AppContainer 私有 AC 数据（PowerShell 每条命令都会删除自己的
    /// __PSScriptPolicyTest 临时脚本）同理。</summary>
    private static bool IsSandboxInternalPath(string vpath) =>
        vpath.Equals("/dynobox", StringComparison.OrdinalIgnoreCase) ||
        vpath.StartsWith("/dynobox/", StringComparison.OrdinalIgnoreCase) ||
        Policy.IsInternalAppContainerPath(vpath);

    private Resolved Resolve(string name)
    {
        var vpath = CanonicalVirtual(name);
        // 未映射的路径在沙箱里"不存在"。必须按 FileNotFound 语义返回而非
        // AccessDenied：宿主机上对不存在的路径探测得到的是 not-found，工具
        // （PATH 搜索、mime.types 探测等）把它当作正常未命中；虚拟卷同样
        // 未命中时返回拒绝会让大量合法探测报错并拖慢启动。
        var best = FindMapping(vpath) ?? throw new FileNotFoundException($"未映射的路径: {name}");
        string real;
        if (best.Prefix == "/")
        {
            var rel = vpath[1..].Replace('/', Sep);
            real = rel.Length == 0 ? best.RealRoot : Path.GetFullPath(Path.Combine(best.RealRoot, rel));
        }
        else if (vpath.Equals(best.Prefix, StringComparison.OrdinalIgnoreCase))
        {
            real = best.RealRoot;
        }
        else
        {
            var rest = vpath[(best.Prefix.Length + 1)..].Replace('/', Sep);
            real = Path.GetFullPath(Path.Combine(best.RealRoot, rest));
        }
        real = ExpandRealAliases(real);
        GuardWithin(real, best);
        return new Resolved { RealPath = real, VirtualPath = VirtualOfReal(real, best), Map = best };
    }

    /// <summary>把真实路径映射回所在根的规范虚拟路径（正斜杠相对形式）。</summary>
    private static string VirtualOfReal(string real, RootMap map)
    {
        var rel = real.Length > map.RealTrim.Length
            ? real[(map.RealTrim.Length + 1)..].Replace(Sep, '/')
            : "";
        return map.Prefix == "/" ? "/" + rel : rel.Length == 0 ? map.Prefix : map.Prefix + "/" + rel;
    }

    /// <summary>折叠虚拟路径中的 `.` / `..` 段（根之上的越界段丢弃）。
    /// 纯字符串操作：不要求任何段真实存在，因此对 create 语义同样成立。</summary>
    private static string CanonicalizeVirtual(string vpath)
    {
        if (!vpath.Contains("/.", StringComparison.Ordinal)) return vpath;
        var stack = new List<string>();
        foreach (var part in vpath.Split('/'))
        {
            if (part.Length == 0 || part == ".") continue;
            if (part == "..")
            {
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                continue;
            }
            stack.Add(part);
        }
        return "/" + string.Join("/", stack);
    }

    private static string Normalize(string name) => "/" + name.Replace('\\', '/').TrimStart('/');

    /// <summary>规范化入口：Dokan 请求名 -> 规范虚拟路径。</summary>
    private static string CanonicalVirtual(string name) => CanonicalizeVirtual(Normalize(name));

    /// <summary>把真实路径中调用方可用于改写身份的别名（8.3 短名、结尾的
    /// 点/空格）展开为磁盘上的规范形态。NTFS 会把 `dir~/x` 与 `LongDir\x`、
    /// `name.` 与 `name` 当作同一文件打开；策略若按请求串匹配就会被这类
    /// 别名绕过。目标不存在时展开已存在的最长祖先，其余段保持原样。</summary>
    private static string ExpandRealAliases(string real)
    {
        // 快路径：无 ~ 且没有以点/空格结尾的段时不存在别名，避免每个请求
        // 都多付一次元数据查询。
        var needsExpansion = false;
        foreach (var segment in real.Split(Sep))
        {
            if (segment.Length == 0) continue;
            if (segment.Contains('~') || segment.EndsWith('.') || segment.EndsWith(' '))
            {
                needsExpansion = true;
                break;
            }
        }
        return needsExpansion ? ExpandLongPath(real) : real;
    }

    private static string ExpandLongPath(string path)
    {
        // 无 \\?\ 前缀的 GetLongPathNameW 在超过 MAX_PATH 的路径上依赖进程的
        // 长路径感知配置；带前缀查询始终可用，使规范化行为不随机器配置漂移。
        var query = path;
        var prefixed = false;
        if (query.Length >= 248 && !query.StartsWith(@"\\?\"))
        {
            query = query.StartsWith(@"\\")
                ? @"\\?\UNC\" + query[2..]
                : @"\\?\" + query;
            prefixed = true;
        }
        var sb = new StringBuilder(1024);
        var n = GetLongPathNameW(query, sb, (uint)sb.Capacity);
        if (n == 0)
        {
            var err = Marshal.GetLastWin32Error();
            if (err is not (0x00000002 or 0x00000003)) return path;   // 仅处理"不存在"
            var sep = path.LastIndexOf(Sep);
            if (sep < 0 || sep == path.Length - 1) return path;
            var parent = ExpandLongPath(path[..sep]);
            return parent.Length > 0 && parent[^1] == Sep
                ? parent + path[(sep + 1)..]
                : parent + Sep + path[(sep + 1)..];
        }
        if (n > (uint)sb.Capacity)
        {
            sb = new StringBuilder((int)n);
            n = GetLongPathNameW(query, sb, n);
            if (n == 0) return path;
        }
        var expanded = sb.ToString(0, (int)n);
        return prefixed ? StripFinalPathPrefix(expanded) : expanded;
    }

    private static void GuardWithin(string real, RootMap map)
    {
        if (!real.Equals(map.RealTrim, StringComparison.OrdinalIgnoreCase) &&
            !real.StartsWith(map.RealTrim + Sep, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"路径越界: {real}");
    }

    private static bool WithinRoot(string real, RootMap map) =>
        real.Equals(map.RealTrim, StringComparison.OrdinalIgnoreCase) ||
        real.StartsWith(map.RealTrim + Sep, StringComparison.OrdinalIgnoreCase);

    // -- 重解析点落点校验 ------------------------------------------------------
    // 策略边界定义在映射根上。镜像树内的 junction / 符号链接 / 卷挂载点会把
    // "根内路径"的 IO 重定向到根外：路径串与策略完全合法，落点却越界。
    // 因此对成功打开的句柄查询最终路径（GetFinalPathNameByHandle 自动穿透
    // 全部祖先重解析点），落点越界即拒绝。根内的重解析点不受影响。

    private const uint FileReadAttributesAccess = 0x00000080;
    private const uint FileShareEverything = 0x00000007;
    private const uint OpenExistingDisposition = 3;
    private const uint FileBackupSemanticsFlag = 0x02000000;
    private static readonly IntPtr InvalidFileHandle = new(-1);

    /// <summary>校验已打开句柄的最终落点是否在根内。查询失败（刚打开的句柄
    /// 上几乎不会发生）时不阻塞原判定，交由真实文件系统语义兜底。</summary>
    private bool HandleLandsWithinRoot(SafeHandle handle, RootMap map)
    {
        var sb = new StringBuilder(1024);
        var n = GetFinalPathNameByHandleW(handle.DangerousGetHandle(), sb, (uint)sb.Capacity, 0);
        if (n == 0)
        {
            Log.Debug("[RESOLVE] 最终路径查询失败，跳过落点校验: {0}", Marshal.GetLastWin32Error());
            return true;
        }
        if (n > (uint)sb.Capacity)
        {
            sb = new StringBuilder((int)n);
            n = GetFinalPathNameByHandleW(handle.DangerousGetHandle(), sb, n, 0);
            if (n == 0) return true;
        }
        var final = StripFinalPathPrefix(sb.ToString(0, (int)n));
        return WithinRoot(final, map);
    }

    /// <summary>对尚未打开的路径做落点校验（move 目标、目录创建）：目标不存在
    /// 时沿祖先向上打开第一个可打开的锚点查询——该句柄已解析其全部祖先的
    /// 重解析点，锚点落点在根内则整条路径都在根内。</summary>
    private bool PathLandsWithinRoot(string real, RootMap map)
    {
        var anchor = real;
        while (anchor.Length > map.RealTrim.Length)
        {
            var handle = CreateFileW(anchor, FileReadAttributesAccess, FileShareEverything,
                IntPtr.Zero, OpenExistingDisposition, FileBackupSemanticsFlag, IntPtr.Zero);
            if (handle != InvalidFileHandle)
            {
                try { return HandleLandsWithinRoot(new FileOnlyHandle(handle), map); }
                finally { CloseHandle(handle); }
            }
            var sep = anchor.LastIndexOf(Sep);
            if (sep < 0) break;
            anchor = anchor[..sep];
        }
        return true;
    }

    /// <summary>剥离 GetFinalPathNameByHandle 返回的设备路径前缀。</summary>
    private static string StripFinalPathPrefix(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..];
        if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return path[4..];
        if (path.StartsWith(@"\??\", StringComparison.OrdinalIgnoreCase)) return path[4..];
        return path;
    }

    /// <summary>仅为满足 HandleLandsWithinRoot 的 SafeHandle 形参包装原生句柄，
    /// 不拥有资源（CloseHandle 由调用方负责）。</summary>
    private sealed class FileOnlyHandle : SafeHandle
    {
        public FileOnlyHandle(IntPtr handle) : base(IntPtr.Zero, true) => SetHandle(handle);
        public override bool IsInvalid =>
            handle == IntPtr.Zero || handle == new IntPtr(-1);
        protected override bool ReleaseHandle() => true;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(string name, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(IntPtr handle, [Out] StringBuilder buffer,
        uint bufferLength, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathNameW(string shortPath,
        [Out] System.Text.StringBuilder longPath, uint bufferLength);

    private bool Check(string vpath, IEnumerable<string> kinds, IDokanFileInfo info)
    {
        var ok = true;
        foreach (var kind in kinds.OrderBy(k => k, StringComparer.Ordinal))
        {
            var (allowed, why) = _policy.Check(vpath, kind);
            Log.Info("[POLICY] pid={0,-6} {1,-7} {2,-32} -> {3} ({4})",
                info.ProcessId, kind, vpath, allowed ? "ALLOW" : "DENY", why);
            if (!allowed) ok = false;
        }
        return ok;
    }

    private static readonly FileAccess ReadBits =
        FileAccess.ReadData | FileAccess.ReadExtendedAttributes | FileAccess.ReadAttributes |
        FileAccess.ReadPermissions | FileAccess.AccessSystemSecurity;

    private static readonly FileAccess WriteBits =
        FileAccess.WriteData | FileAccess.AppendData | FileAccess.WriteExtendedAttributes |
        FileAccess.WriteAttributes | FileAccess.Delete | FileAccess.ChangePermissions |
        FileAccess.SetOwnership;

    private static HashSet<string> AccessToKinds(FileAccess access)
    {
        if ((access & FileAccess.GenericAll) != 0)
            return new HashSet<string> { AccessKind.Read, AccessKind.Write, AccessKind.Execute };
        var kinds = new HashSet<string>();
        if ((access & (ReadBits | FileAccess.GenericRead)) != 0) kinds.Add(AccessKind.Read);
        if ((access & (WriteBits | FileAccess.GenericWrite)) != 0) kinds.Add(AccessKind.Write);
        if ((access & (FileAccess.Execute | FileAccess.GenericExecute)) != 0)
            kinds.Add(AccessKind.Execute);
        return kinds;
    }

    private static FileAccess WithoutExecute(FileAccess access) =>
        access & ~(FileAccess.Execute | FileAccess.GenericExecute);

    private Ctx? GetCtx(IDokanFileInfo info) => info.Context as Ctx;

    // A user can spend five minutes answering. Renew this specific driver request
    // while it is waiting, without raising Dokan's timeout for ordinary IO.
    private static Timer KeepRequestAlive(IDokanFileInfo info) => new(_ =>
    {
        try { info.TryResetTimeout(30_000); }
        catch (Exception ex) { Log.Debug("Request timeout renewal failed: {0}", ex.Message); }
    }, null, 10_000, 10_000);

    private Ctx? PopCtx(IDokanFileInfo info)
    {
        lock (_life)
        {
            var cx = info.Context as Ctx;
            info.Context = null;
            if (cx is not null) _ctx.Remove(cx);
            return cx;
        }
    }

    // -- 文件生命周期 --------------------------------------------------------

    public NtStatus CreateFile(string fileName, FileAccess access, FileShare share,
        FileMode mode, FileOptions options, FileAttributes attributes, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] ZwCreateFile {0} mode={1}", fileName, mode);
        using var keepAlive = KeepRequestAlive(info);
        try
        {
            lock (info)
            {
                var vpath = CanonicalVirtual(fileName);
                var pid = info.ProcessId;
                var isDirReq = info.IsDirectory;
                var kinds = AccessToKinds(access);

                if (info.Context is not null)
                {
                    Log.Debug("ZwCreateFile 复用上下文 {0}", vpath);
                    return Success;
                }

                // 虚拟容器（卷根 / 装配节点）：只读目录，写与创建一律拒绝
                if (IsSyntheticContainer(vpath))
                {
                    // Assembly nodes have no host file behind them. Traversal must
                    // work before the child starts, even under an all-ask policy.
                    if (kinds.Contains(AccessKind.Write) ||
                        mode is not (FileMode.Open or FileMode.OpenOrCreate))
                        return AccessDenied;
                    info.IsDirectory = true;
                    info.Context = NewCtx(null);
                    return Success;
                }

                var res = Resolve(fileName);
                var real = res.RealPath;
                var targetIsDir = Directory.Exists(real);
                var exists = targetIsDir || File.Exists(real);
                var creating = mode is FileMode.Create or FileMode.CreateNew or FileMode.Truncate
                               || (mode == FileMode.OpenOrCreate && !exists);

                // 目录上的 Execute 是 traverse 语义，按 read 管控；
                // 只有"文件 + Execute"才是执行管控（拉起进程/加载 DLL）。
                if (kinds.Contains(AccessKind.Execute) && (isDirReq || targetIsDir))
                {
                    kinds.Remove(AccessKind.Execute);
                    kinds.Add(AccessKind.Read);
                    access = WithoutExecute(access);
                }

                if (!Check(res.VirtualPath, kinds, info)) return AccessDenied;

                if (isDirReq)
                {
                    // junction / 符号链接目录会把打开与创建重定向到根外
                    if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                    if (mode is FileMode.Create or FileMode.CreateNew or FileMode.OpenOrCreate && !exists)
                    {
                        Directory.CreateDirectory(real);
                        Log.Info("[FS] mkdir {0}", vpath);
                    }
                    else if (!Directory.Exists(real))
                    {
                        return FileNotFound;
                    }
                    info.Context = NewCtx(null);
                    return Success;
                }

                if (targetIsDir)
                {
                    // .NET 的目录枚举可能未预先设置 IsDirectory；ReadData 在目录上即 ListDirectory。
                    var directoryRead = (access & ~(ReadBits | FileAccess.GenericRead
                        | FileAccess.Synchronize | FileAccess.MaximumAllowed)) == 0;
                    if (!directoryRead || mode is not (FileMode.Open or FileMode.OpenOrCreate)) return AccessDenied;
                    if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                    info.IsDirectory = true;
                    info.Context = NewCtx(null);
                    return Success;
                }

                if (mode == FileMode.CreateNew && exists) return FileExists;
                if (mode is FileMode.Open or FileMode.Truncate && !exists) return FileNotFound;

                try
                {
                    var streamPath = real;
                    // Launchers commonly reopen their own image read-only to
                    // parse an embedded shebang after the loader has opened it
                    // for execution. Keep every read-only handle on the same
                    // compatibility view; otherwise it sees the host path
                    // again and falls back to an unrelated PATH executable.
                    if (!kinds.Contains(AccessKind.Write) &&
                        GetRuntimeOverlay(real) is { } overlay)
                        streamPath = overlay;
                    var stream = new FileStream(streamPath, mode,
                        kinds.Contains(AccessKind.Write) ? System.IO.FileAccess.ReadWrite : System.IO.FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete,
                        64 * 1024, FileOptions.None);
                    // overlay 副本在引导区内，不属于该根映射，跳过落点校验；
                    // 其源文件的内容扫描由管理进程完成，子进程永远只见到副本。
                    if (streamPath == real && !HandleLandsWithinRoot(stream.SafeFileHandle, res.Map))
                    {
                        stream.Dispose();
                        if (creating)
                        {
                            // 越界创建的文件不属于沙箱世界，清理掉
                            try { File.Delete(real); } catch { }
                        }
                        Log.Info("[FS] 落点越界拒绝 {0}", vpath);
                        return AccessDenied;
                    }
                    info.Context = NewCtx(stream, real);
                }
                catch (FileNotFoundException) { return FileNotFound; }
                catch (DirectoryNotFoundException) { return PathNotFound; }
                catch (UnauthorizedAccessException) { return AccessDenied; }
                catch (IOException ex) when ((uint)ex.HResult == 0x80070020u) { return SharingViolation; }
                catch (IOException ex) { Log.Warn("[FS] 打开失败 {0}: {1}", vpath, ex.Message); return AccessDenied; }
                return Success;
            }
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Log.Debug("[FS] 路径未映射: {0}", fileName);
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("ZwCreateFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    private Ctx NewCtx(FileStream? stream, string realPath = "")
    {
        var cx = new Ctx { Stream = stream, RealPath = realPath };
        lock (_life) _ctx[cx] = cx;
        return cx;
    }

    public void Cleanup(string fileName, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] Cleanup {0}", fileName);
        try
        {
            // Executable images and memory-mapped files can still issue paging IO
            // after Cleanup. Keep the authorized stream until the final CloseFile.
            var cx = GetCtx(info);
            if (cx is not null)
            {
                lock (cx.Gate) { cx.Stream?.Flush(); }
            }
            if (info.DeletePending)
            {
                var res = Resolve(fileName);
                var real = res.RealPath;
                // 必须用规范虚拟路径判断：原始请求名可能携带 .. 段
                // （如 /dynobox/../C/...，按原始名前缀匹配会误判为内部区域，
                // 导致开启回收站时用户文件被永久删除）。
                if (DeleteToTrash && !IsSandboxInternalPath(res.VirtualPath))
                {
                    // 回收站模式：先释放本进程持有的句柄（回收站移动要求句柄关闭），
                    // 然后送回收站；任何失败都保留原文件——宁可让删除结果失真，
                    // 也不能让用户数据被永久清除。
                    var cxTrash = GetCtx(info);
                    if (cxTrash is not null)
                    {
                        lock (cxTrash.Gate)
                        {
                            try { cxTrash.Stream?.Dispose(); }
                            finally { cxTrash.Stream = null; }
                        }
                    }
                    if (RecycleBin.TrySend(real, out var trashError))
                        Log.Info("[FS] 删除 {0} (已送回收站)", Normalize(fileName));
                    else
                        Log.Warn("[FS] 回收站删除未执行，文件保留 {0}: {1}", fileName, trashError);
                }
                else
                {
                    try
                    {
                        if (info.IsDirectory) Directory.Delete(real);
                        else File.Delete(real);
                        Log.Info("[FS] 删除 {0}", Normalize(fileName));
                    }
                    catch (FileNotFoundException) { }
                    catch (DirectoryNotFoundException) { }
                    catch (IOException ex) { Log.Warn("[FS] 删除失败 {0}: {1}", fileName, ex.Message); }
                }
            }
        }
        catch (FileNotFoundException ex)
        {
            // 未映射路径的删除请求按"目标不存在"静默处理
            Log.Debug("[FS] Cleanup 忽略未映射路径 {0}: {1}", fileName, ex.Message);
        }
        catch (Exception ex)
        {
            Log.Error("Cleanup 内部异常: {0}", ex);
            // Cleanup 无返回值通道，吞掉异常保证稳定
        }
    }

    public void CloseFile(string fileName, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] CloseFile {0}", fileName);
        try
        {
            var cx = PopCtx(info);
            if (cx is not null)
            {
                lock (cx.Gate)
                {
                    try { cx.Stream?.Dispose(); }
                    finally { cx.Stream = null; }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Error("CloseFile 内部异常: {0}", ex);
        }
    }

    // -- 读写 ---------------------------------------------------------------

    public NtStatus ReadFile(string fileName, byte[] buffer, out int bytesRead, long offset,
        IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] ReadFile {0} len={1} off={2}", fileName, buffer.Length, offset);
        try
        {
            var cx = GetCtx(info);
            if (cx?.Stream is null) { bytesRead = 0; return AccessDenied; }
            lock (cx.Gate)
            {
                if (cx.Stream is null) { bytesRead = 0; return AccessDenied; }
                cx.Stream.Seek(offset, SeekOrigin.Begin);
                bytesRead = 0;
                while (bytesRead < buffer.Length)
                {
                    var n = cx.Stream.Read(buffer, bytesRead, buffer.Length - bytesRead);
                    if (n == 0) break;
                    bytesRead += n;
                }
            }
            return bytesRead == 0 ? NtStatus.EndOfFile : Success;
        }
        catch (Exception ex)
        {
            Log.Error("ReadFile 内部异常: {0}", ex);
            bytesRead = 0;
            return AccessDenied;
        }
    }

    /// <summary>追加写（WriteToEndOfFile）的全局串行化。并发追加必须以真实
    /// 文件的当前长度为准——.NET FileStream 的 Seek(End) 用的是自己缓存的
    /// 位置（打开时的旧 EOF），两个句柄并发追加会互相覆盖丢数据。</summary>
    private readonly object _appendGate = new();

    public NtStatus WriteFile(string fileName, byte[] buffer, out int bytesWritten, long offset,
        IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] WriteFile {0} len={1} off={2}", fileName, buffer.Length, offset);
        try
        {
            var cx = GetCtx(info);
            if (cx?.Stream is null) { bytesWritten = 0; return AccessDenied; }
            lock (cx.Gate)
            {
                if (cx.Stream is null) { bytesWritten = 0; return AccessDenied; }
                if (info.WriteToEndOfFile)
                {
                    lock (_appendGate)
                    {
                        // 以真实文件的当前长度定位：其他句柄可能已经追加过
                        var realEnd = 0L;
                        try { realEnd = new FileInfo(cx.RealPath).Length; }
                        catch { realEnd = cx.Stream.Length; }
                        cx.Stream.Seek(realEnd, SeekOrigin.Begin);
                        cx.Stream.Write(buffer, 0, buffer.Length);
                        cx.Stream.Flush(flushToDisk: false);
                    }
                }
                else
                {
                    cx.Stream.Seek(offset, SeekOrigin.Begin);
                    cx.Stream.Write(buffer, 0, buffer.Length);
                    cx.Stream.Flush(flushToDisk: false);
                }
            }
            bytesWritten = buffer.Length;
            return Success;
        }
        catch (Exception ex)
        {
            Log.Error("WriteFile 内部异常: {0}", ex);
            bytesWritten = 0;
            return AccessDenied;
        }
    }

    public NtStatus FlushFileBuffers(string fileName, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] Flush {0}", fileName);
        try
        {
            var cx = GetCtx(info);
            if (cx?.Stream is not null)
            {
                lock (cx.Gate) { try { cx.Stream.Flush(flushToDisk: true); } catch { } }
            }
            return Success;
        }
        catch (Exception ex)
        {
            Log.Error("Flush 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    // -- 元数据 --------------------------------------------------------------

    public NtStatus GetFileInformation(string fileName, out FileInformation fileInfo,
        IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] GetFileInfo {0}", fileName);
        try
        {
            if (IsSyntheticContainer(CanonicalVirtual(fileName)))
            {
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = FileAttributes.Directory,
                    CreationTime = DateTime.Now,
                    LastAccessTime = DateTime.Now,
                    LastWriteTime = DateTime.Now,
                    Length = 0,
                };
                return Success;
            }
            var res = Resolve(fileName);
                var real = res.RealPath;
            var di = new DirectoryInfo(real);
            if (di.Exists)
            {
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = di.Attributes == 0 ? FileAttributes.Normal : di.Attributes,
                    CreationTime = di.CreationTime,
                    LastAccessTime = di.LastAccessTime,
                    LastWriteTime = di.LastWriteTime,
                    Length = 0,
                };
                return Success;
            }
            var fi = new FileInfo(real);
            if (!fi.Exists)
            {
                fileInfo = default;
                return FileNotFound;
            }
            fileInfo = new FileInformation
            {
                FileName = fileName,
                Attributes = fi.Attributes == 0 ? FileAttributes.Normal
                           : fi.Attributes & ~FileAttributes.Normal,
                CreationTime = fi.CreationTime,
                LastAccessTime = fi.LastAccessTime,
                LastWriteTime = fi.LastWriteTime,
                Length = GetRuntimeOverlay(real) is { } overlay
                    ? new FileInfo(overlay).Length
                    : fi.Length,
            };
            return Success;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            fileInfo = default;
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("GetFileInformation 内部异常: {0}", ex);
            fileInfo = default;
            return AccessDenied;
        }
    }

    public NtStatus FindFiles(string fileName, out IList<FileInformation> files,
        IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] FindFiles {0}", fileName);
        files = new List<FileInformation>();
        try
        {
            var vpath = CanonicalVirtual(fileName);

            // 虚拟容器：合成映射装配节点的子目录（/ 下的 C、D；/NET 下的 server ...）
            if (IsSyntheticContainer(vpath))
            {
                var vroot = vpath.TrimEnd('/') + "/";
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var m in _roots)
                {
                    if (!m.Prefix.StartsWith(vroot, StringComparison.OrdinalIgnoreCase))
                        continue;
                    var head = m.Prefix[vroot.Length..].Split('/')[0];
                    if (head.Length == 0 || !seen.Add(head)) continue;
                    files.Add(new FileInformation
                    {
                        FileName = head,
                        Attributes = FileAttributes.Directory,
                        CreationTime = DateTime.Now,
                        LastAccessTime = DateTime.Now,
                        LastWriteTime = DateTime.Now,
                        Length = 0,
                    });
                }
                return Success;
            }

            var dir = new DirectoryInfo(Resolve(fileName).RealPath);
            if (!dir.Exists) return NotADirectory;
            foreach (var entry in dir.EnumerateFileSystemInfos())
            {
                files.Add(new FileInformation
                {
                    FileName = entry.Name,
                    Attributes = entry is DirectoryInfo
                        ? FileAttributes.Directory
                        : entry.Attributes & ~FileAttributes.Normal,
                    CreationTime = entry.CreationTime,
                    LastAccessTime = entry.LastAccessTime,
                    LastWriteTime = entry.LastWriteTime,
                    Length = (entry as FileInfo)?.Length ?? 0,
                });
            }
            return Success;
        }
        catch (FileNotFoundException)
        {
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("FindFiles 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus FindFilesWithPattern(string fileName, string searchPattern,
        out IList<FileInformation> files, IDokanFileInfo info)
    {
        files = new List<FileInformation>();
        return NotImplemented;
    }

    public NtStatus SetFileAttributes(string fileName, FileAttributes attributes,
        IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] SetAttr {0} {1}", fileName, attributes);
        try
        {
            try
            {
                var res = Resolve(fileName);
                var real = res.RealPath;
                if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                var cur = File.GetAttributes(real);
                if (attributes.HasFlag(FileAttributes.ReadOnly))
                    File.SetAttributes(real, cur | FileAttributes.ReadOnly);
                else
                    File.SetAttributes(real, cur & ~FileAttributes.ReadOnly);
                Log.Debug("[FS] SetAttr 完成 {0} -> {1}", fileName, attributes);
                return Success;
            }
            catch (Exception ex)
            {
                Log.Warn("[FS] SetAttr 失败 {0}: {1}", fileName, ex.Message);
                return AccessDenied;
            }
        }
        catch (Exception ex)
        {
            Log.Error("SetFileAttributes 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus SetFileTime(string fileName, DateTime? creationTime, DateTime? lastAccessTime,
        DateTime? lastWriteTime, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] SetTime {0}", fileName);
        try
        {
            var res = Resolve(fileName);
                var real = res.RealPath;
            if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
            if (creationTime.HasValue) File.SetCreationTime(real, creationTime.Value);
            if (lastAccessTime.HasValue) File.SetLastAccessTime(real, lastAccessTime.Value);
            if (lastWriteTime.HasValue) File.SetLastWriteTime(real, lastWriteTime.Value);
            return Success;
        }
        catch (FileNotFoundException)
        {
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("SetFileTime 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus DeleteFile(string fileName, IDokanFileInfo info)
    {
        using var keepAlive = KeepRequestAlive(info);
        Log.Debug("[ENTRY] DeleteFile {0}", fileName);
        try
        {
            var res = Resolve(fileName);
                var real = res.RealPath;
            if (!File.Exists(real)) return FileNotFound;
            if (!info.DeletePending) return Success;
            var (allowed, _) = _policy.Check(res.VirtualPath, AccessKind.Write);
            return allowed ? Success : AccessDenied;
        }
        catch (FileNotFoundException)
        {
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("DeleteFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus DeleteDirectory(string fileName, IDokanFileInfo info)
    {
        using var keepAlive = KeepRequestAlive(info);
        Log.Debug("[ENTRY] DeleteDirectory {0}", fileName);
        try
        {
            var res = Resolve(fileName);
                var real = res.RealPath;
            if (!Directory.Exists(real)) return PathNotFound;
            if (!info.DeletePending) return Success;
            var (allowed, _) = _policy.Check(res.VirtualPath, AccessKind.Write);
            if (!allowed) return AccessDenied;
            if (Directory.EnumerateFileSystemEntries(real).Any()) return DirectoryNotEmpty;
            return Success;
        }
        catch (FileNotFoundException)
        {
            return PathNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("DeleteDirectory 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus MoveFile(string oldName, string newName, bool replace, IDokanFileInfo info)
    {
        using var keepAlive = KeepRequestAlive(info);
        Log.Debug("[ENTRY] MoveFile {0} -> {1}", oldName, newName);
        try
        {
            lock (_life)
            {
                var oldRes = Resolve(oldName);
                var newRes = Resolve(newName);
                var oldVp = oldRes.VirtualPath;
                var newVp = newRes.VirtualPath;
                var oldReal = oldRes.RealPath;
                var newReal = newRes.RealPath;
                if (!Check(oldVp, new[] { AccessKind.Write }, info) ||
                    !Check(newVp, new[] { AccessKind.Write }, info))
                    return AccessDenied;
                // 目标经 junction 目录会落到根外（写入逃逸），先校验落点
                if (!PathLandsWithinRoot(newReal, newRes.Map))
                {
                    Log.Info("[FS] move 目标落点越界拒绝 {0} -> {1}", oldVp, newVp);
                    return AccessDenied;
                }

                var cx = info.Context as Ctx;
                if (cx?.Stream is not null)
                {
                    // 句柄不带 FILE_SHARE_DELETE：先关 -> 改名 -> 重开
                    lock (cx.Gate)
                    {
                        try { cx.Stream.Dispose(); } catch { }
                        cx.Stream = null;
                    }
                }
                try
                {
                    if (replace && File.Exists(newReal)) File.Replace(oldReal, newReal, null);
                    else if (Directory.Exists(oldReal)) Directory.Move(oldReal, newReal);
                    else File.Move(oldReal, newReal, replace);
                }
                catch (IOException ex) when (unchecked((uint)ex.HResult) == 0x800700B7u)
                {
                    // 目标已存在必须如实返回 FileExists：调用方（PowerShell -Force 等）
                    // 依赖该条件先删除目标再重试；映射成 AccessDenied 会破坏覆盖语义。
                    return FileExists;
                }
                catch (IOException ex)
                {
                    Log.Warn("[FS] move 失败 {0}: {1}", oldVp, ex.Message);
                    return AccessDenied;
                }
                if (cx is not null && cx.Stream is null)
                {
                    try
                    {
                        cx.Stream = new FileStream(newReal, FileMode.Open,
                            System.IO.FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
                    }
                    catch { /* 重开失败：后续 IO 返回拒绝 */ }
                }
                Log.Info("[FS] move {0} -> {1}", oldVp, newVp);
                return Success;
            }
        }
        catch (FileNotFoundException)
        {
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("MoveFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus SetEndOfFile(string fileName, long length, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] SetEndOfFile {0} {1}", fileName, length);
        try
        {
            var cx = GetCtx(info);
            if (cx?.Stream is not null)
            {
                lock (cx.Gate)
                {
                    if (cx.Stream is not null) cx.Stream.SetLength(length);
                }
            }
            else
            {
                // 无句柄流的兜底路径必须与常规写入同一策略闸门（fail-closed），
                // 不能因为缺少上下文就绕过 write 判定直接落盘。
                var res = Resolve(fileName);
                var (allowed, _) = _policy.Check(res.VirtualPath, AccessKind.Write);
                if (!allowed) return AccessDenied;
                if (!PathLandsWithinRoot(res.RealPath, res.Map)) return AccessDenied;
                using var fs = new FileStream(res.RealPath, FileMode.Open, System.IO.FileAccess.Write);
                fs.SetLength(length);
            }
            return Success;
        }
        catch (FileNotFoundException)
        {
            return FileNotFound;
        }
        catch (Exception ex)
        {
            Log.Error("SetEndOfFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    public NtStatus SetAllocationSize(string fileName, long length, IDokanFileInfo info) =>
        SetEndOfFile(fileName, length, info);

    public NtStatus LockFile(string fileName, long offset, long length, IDokanFileInfo info) =>
        Success;

    public NtStatus UnlockFile(string fileName, long offset, long length, IDokanFileInfo info) =>
        Success;

    // -- 卷信息 ---------------------------------------------------------------

    public NtStatus GetDiskFreeSpace(out long freeBytesAvailable, out long totalNumberOfBytes,
        out long totalNumberOfFreeBytes, IDokanFileInfo info)
    {
        Log.Debug("[ENTRY] DiskFree");
        try
        {
            // GetDiskFreeSpaceExW 对盘符与 UNC 根都有效；DriveInfo 只接受
            // 本地盘符，UNC 根（\server\share）会抛异常导致整卷查询失败。
            foreach (var root in _roots)
            {
                var probe = root.RealRoot.Length > 0 ? root.RealRoot : root.RealTrim;
                if (!probe.EndsWith(Sep)) probe += Sep;
                if (GetDiskFreeSpaceExW(probe, out var available, out var total, out var free))
                {
                    freeBytesAvailable = available;
                    totalNumberOfBytes = total;
                    totalNumberOfFreeBytes = free;
                    return Success;
                }
            }
            freeBytesAvailable = totalNumberOfBytes = totalNumberOfFreeBytes = 0;
            return AccessDenied;
        }
        catch (Exception ex)
        {
            Log.Error("GetDiskFreeSpace 内部异常: {0}", ex);
            freeBytesAvailable = totalNumberOfBytes = totalNumberOfFreeBytes = 0;
            return AccessDenied;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetDiskFreeSpaceExW(string directory, out long freeBytesAvailable,
        out long totalNumberOfBytes, out long totalNumberOfFreeBytes);

    public NtStatus GetVolumeInformation(out string volumeLabel,
        out FileSystemFeatures features, out string fileSystemName,
        out uint maximumComponentLength, IDokanFileInfo info)
    {
        volumeLabel = "dynobox";
        features = FileSystemFeatures.CasePreservedNames | FileSystemFeatures.UnicodeOnDisk;
        fileSystemName = "NTFS";
        maximumComponentLength = 255;
        return Success;
    }

    public NtStatus Mounted(string mountPoint, IDokanFileInfo info)
    {
        MountedPoint = mountPoint;
        Log.Info("[FS] 已挂载到 {0}", mountPoint);
        return Success;
    }

    public NtStatus Unmounted(IDokanFileInfo info)
    {
        MountedPoint = null;
        Log.Info("[FS] 已卸载");
        return Success;
    }

    public string? MountedPoint { get; private set; }

    // 注意：GetFileSecurity/SetFileSecurity 刻意保持 NotImplemented。曾尝试转发
    // 真实安全描述符，但 DokanNet 的 SD 编解码在 robocopy 的多线程安全查询下会
    // 造成 IRP 挂起；NotImplemented 会让 robocopy/Get-Acl 收到明确错误
    // （已知限制，见 README 第七节），Copy-Item 等 .NET 语义不受影响。

    public NtStatus GetFileSecurity(string fileName, out FileSystemSecurity? security,
        AccessControlSections sections, IDokanFileInfo info)
    {
        security = default;
        return NotImplemented;
    }

    public NtStatus SetFileSecurity(string fileName, FileSystemSecurity? security,
        AccessControlSections sections, IDokanFileInfo info) => NotImplemented;

    public NtStatus FindStreams(string fileName, out IList<FileInformation> streams,
        IDokanFileInfo info)
    {
        streams = new List<FileInformation>();
        return NotImplemented;
    }
}
