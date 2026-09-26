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
    // 生命周期一致性锁（MoveFile 换流等需要跨字段原子性的操作）；
    // 活跃句柄登记表用无锁 ConcurrentDictionary，消除 stat 序列
    // （CreateFile+CloseFile）高频争用同一把全局锁的串行瓶颈。
    private readonly object _life = new();
    private readonly ConcurrentDictionary<Ctx, Ctx> _ctx = new();
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

        // 延迟宿主打开：存在性探测类打开（stat 的 CreateFile+Query+Close 序列）
        // 绝大多数从不读写。CreateFile 仅记录打开意图（零宿主系统调用，探测
        // 结果存 Probe），首个真正读写的回调经 EnsureStream 触发打开。创建类
        // 语义（文件必须在 CreateFile 返回后即刻存在）保持急切打开。
        public bool PendingOpen;
        public string OpenPath = "";
        public System.IO.FileMode OpenMode;
        public System.IO.FileAccess OpenAccess;
        public System.IO.FileShare OpenShare;
        public FileSystemInfo? Probe;

        // SetEndOfFile 的最终长度提示：Dokan 驱动对部分页写入做 read-modify-write
        // （ReadFile 整页 + WriteFile 整页回写，未初始化部分补 NUL），实测 tar 解压
        // 的 write(30)+ftruncate(30) 被驱动拆成 SetEndOfFile(30) 先到、WriteFile(4096)
        // 后到覆盖（宿主 NTFS 无此问题）。CloseFile 时按本提示强制截断，保证文件
        // 最终长度与 ftruncate 语义一致。null 表示未设置。
        public long? EndOfFileHint;
    }

    /// <summary>纯元数据探测打开：仅请求属性/权限/同步位，不含任何数据读写、
    /// 删除或属性修改访问。此类句柄由内核保证不会产生 ReadFile/WriteFile IRP，
    /// 可以安全延迟宿主打开（stat 序列 = 0 宿主系统调用）。含数据/写/删除访问
    /// 的打开必须急切：共享冲突（如 FileShare.None 独占）必须像 NTFS 一样在
    /// 打开时刻失败，而不是推迟到首次 IO。</summary>
    private static bool IsMetadataOnlyOpen(DokanNet.FileAccess access)
    {
        // DokanNet.FileAccess 与 System.IO.FileAccess 同名冲突，按数值判定：
        // READ_DATA|WRITE_DATA|APPEND_DATA|DELETE|EXECUTE|WRITE_ATTRIBUTES|
        // GENERIC_READ|GENERIC_WRITE|GENERIC_EXECUTE|GENERIC_ALL
        const DokanNet.FileAccess mutatingOrData =
            DokanNet.FileAccess.ReadData | DokanNet.FileAccess.WriteData |
            DokanNet.FileAccess.AppendData | DokanNet.FileAccess.Delete |
            DokanNet.FileAccess.Execute | DokanNet.FileAccess.WriteAttributes |
            DokanNet.FileAccess.GenericRead | DokanNet.FileAccess.GenericWrite |
            DokanNet.FileAccess.GenericExecute | DokanNet.FileAccess.GenericAll;
        return (access & mutatingOrData) == 0;
    }

    /// <summary>确保延迟打开的宿主流已就绪；打开失败按异常映射返回 false。</summary>
    private static bool EnsureStream(Ctx cx)
    {
        if (!cx.PendingOpen) return cx.Stream is not null;
        try
        {
            // 高并发 worker（jest 24 worker）同时读同一缓存文件时，Dokan 卷上
            // 偶发 ERROR_BUSY（0x80070021）——另一 worker 的句柄尚未完全释放。
            // 宿主 NTFS 无此问题；这里对瞬态 BUSY/共享冲突重试少量几次。
            cx.Stream = WithTransientShareRetry(() =>
                new FileStream(cx.OpenPath, cx.OpenMode, cx.OpenAccess,
                    cx.OpenShare, 64 * 1024, FileOptions.None));
            cx.PendingOpen = false;
            cx.Probe = null;   // 打开后写入可能改变大小/时间，探针数据作废
            return true;
        }
        catch (Exception)
        {
            // 文件在打开与首次使用之间被删除等竞态：句柄已在手，按访问失败处理
            cx.PendingOpen = false;
            return false;
        }
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
        StartDeferredDeleteWorker();
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

    // 本实例运行期间经镜像文件系统新建的规范虚拟路径（大小写不敏感）。删除这些
    // 路径时跳过回收站直接清除，避免任务期间的反复增删把回收站灌满；跟踪表随
    // 进程结束一起消失，不跨沙箱实例残留。超过上限后停止记录，之后的删除退回
    // 回收站语义（保守方向：宁可多送回收站，不错误永久清除宿主既有数据）。
    private const int MaxTrackedSessionCreations = 200_000;
    private readonly ConcurrentDictionary<string, bool> _sessionCreated = new(StringComparer.OrdinalIgnoreCase);

    // 删除挂起队列：宿主侧删除被占用（Defender 扫描、镜像节未拆完等）时把
    // 备份路径挂到这里，由后台任务周期重试；目录判空会把队列中的"幽灵"视为
    // 已删除，避免调用方（go RemoveAll 等）看到永久的 ENOTEMPTY。
    private readonly ConcurrentDictionary<string, bool> _deferredDeletes = new(StringComparer.OrdinalIgnoreCase);

    // 目录枚举缓存：键 = 规范虚拟路径。TTL 2 秒 + 本卷变更立即失效；
    // 条目数组跨 IRP 只读共享。
    private readonly ConcurrentDictionary<string, (DateTime Expiry, System.Collections.Generic.List<FileInformation> Entries)>
        _dirListingCache = new(StringComparer.Ordinal);

    // 文件元数据缓存（stat 缓存）：键 = 规范虚拟路径。TTL 1 秒 + 本卷变更立即失效。
    // 每次 stat（GetFileInformation）都会穿透宿主 new FileInfo/DirectoryInfo——这是
    // node_modules 爬取类负载（jest 模块解析）的最大头。缓存只覆盖"存在"条目，
    // 不做负缓存（FileNotFound 不缓存）：创建后立即 stat 必须看到新条目，负缓存
    // 会让新建文件在 TTL 内不可见。仅缓存存在性已知且元数据稳定的快照。
    private readonly struct FileInfoSnapshot
    {
        public readonly FileAttributes Attributes;
        public readonly DateTime CreationTime;
        public readonly DateTime LastAccessTime;
        public readonly DateTime LastWriteTime;
        public readonly long Length;

        public FileInfoSnapshot(FileAttributes attributes, DateTime creationTime,
            DateTime lastAccessTime, DateTime lastWriteTime, long length)
        {
            Attributes = attributes;
            CreationTime = creationTime;
            LastAccessTime = lastAccessTime;
            LastWriteTime = lastWriteTime;
            Length = length;
        }
    }

    // 负缓存（ENOENT 探测缓存）：Node/工具链的模块解析会对候选路径反复探测
    // （扩展名轮询、node_modules 目录逐级上探），每个不存在的路径一次完整 IRP
    // 往返（~140µs）。短期负缓存（300ms）把这些探测压成一次宿主 stat。
    // 正确性：所有写路径（创建/删除/改名）已对对应路径失效 _fileInfoCache，
    // 因此"创建后立即 stat 可见"成立；300ms 窗口仅覆盖宿主带外变更，与正缓存
    // 同一失效保证。以规范虚拟路径为键，容量受限，超出后不缓存新负条目。
    private readonly ConcurrentDictionary<string, DateTime> _fileInfoNegativeCache =
        new(StringComparer.Ordinal);
    private const int MaxNegativeEntries = 200_000;
    private static readonly TimeSpan NegativeCacheTtl = TimeSpan.FromMilliseconds(300);

    private readonly ConcurrentDictionary<string, (DateTime Expiry, FileInfoSnapshot Snapshot)>
        _fileInfoCache = new(StringComparer.Ordinal);
    // TTL 10s：写路径都会立即失效，TTL 只兜底宿主带外变更（与目录枚举 2s 同一
    // 思路，但 stat 更频繁，拉长命中窗口；正确性由失效保证）。
    private static readonly TimeSpan FileInfoCacheTtl = TimeSpan.FromSeconds(10);

    /// <summary>条目变更（创建/删除/改名/延后删除）后使其【父目录】的枚举
    /// 缓存失效——枚举缓存以目录为键，条目增删改变的是父目录的列表内容。
    /// fileName 为目录本身时（mkdir/rmdir）额外失效该目录自身的缓存。</summary>
    private void InvalidateDirListing(string fileName, bool isDirectory = false)
    {
        var vpath = CanonicalVirtual(fileName);
        vpath = vpath.TrimEnd('/');
        var slash = vpath.LastIndexOf('/');
        var parent = slash > 0 ? vpath[..slash] : "/";
        _dirListingCache.TryRemove(parent, out _);
        if (isDirectory) _dirListingCache.TryRemove(vpath, out _);
    }

    /// <summary>写操作后使目标条目的 stat 缓存失效（长度/时间/属性可能已变）。
    /// stop 缓存只存正条目，删除/改名后残留的旧快照必须移除，否则后续
    /// GetFileInformation 会命中已不存在的条目。负缓存（ENOENT 探测）同
    /// 一并清：创建新文件后立即 stat 不能命中旧的"不存在"。
    /// 目录创建（mkdirSync recursive）只下发最深子路径的 CreateFile，中间
    /// 祖先目录由系统隐式创建——必须递归失效祖先链，否则"先 existsSync 探测
    /// 得到 ENOENT 负缓存、再 mkdir 子目录、随即 readdirSync 父目录"的场景
    /// 会命中父目录残留的负缓存而误报目录不存在（appmgr 安装流程实测）。</summary>
    private void InvalidateFileInfo(string fileName)
    {
        var vpath = CanonicalVirtual(fileName).TrimEnd('/');
        if (vpath.Length > 0)
        {
            _fileInfoCache.TryRemove(vpath, out _);
            _fileInfoNegativeCache.TryRemove(vpath, out _);
            // 递归失效祖先：/a/b/c → /a/b、/a（负缓存命中"不存在"后会阻止
            // 祖先显影）。自环到跟即可，根 "/" 不做条目缓存。
            var idx = vpath.LastIndexOf('/');
            while (idx > 0)
            {
                var ancestor = vpath[..idx];
                _fileInfoCache.TryRemove(ancestor, out _);
                _fileInfoNegativeCache.TryRemove(ancestor, out _);
                idx = ancestor.LastIndexOf('/');
            }
        }
    }

    private void EnqueueDeferredDelete(string realPath)
    {
        _deferredDeletes.TryAdd(realPath.TrimEnd(Sep), true);
    }

    /// <summary>宿主路径是否处于挂起删除状态（或是挂起删除目录的后代）。</summary>
    private bool IsDeferredDelete(string realPath) =>
        _deferredDeletes.Keys.Any(queued =>
            realPath.Equals(queued, StringComparison.OrdinalIgnoreCase) ||
            realPath.StartsWith(queued + Sep, StringComparison.OrdinalIgnoreCase));

    private void StartDeferredDeleteWorker()
    {
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(500).ConfigureAwait(false);
                foreach (var path in _deferredDeletes.Keys)
                {
                    try
                    {
                        if (File.Exists(path)) File.Delete(path);
                        else if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
                        _deferredDeletes.TryRemove(path, out _);
                    }
                    catch (DirectoryNotFoundException) { _deferredDeletes.TryRemove(path, out _); }
                    catch (FileNotFoundException) { _deferredDeletes.TryRemove(path, out _); }
                    catch (IOException) { /* 仍被占用，下轮重试 */ }
                    catch (UnauthorizedAccessException) { /* 同上 */ }
                }
                if (_deferredDeletes.IsEmpty) await Task.Delay(4000).ConfigureAwait(false);
            }
        });
    }

    private void TrackSessionCreated(string virtualPath)
    {
        if (_sessionCreated.Count < MaxTrackedSessionCreations) _sessionCreated.TryAdd(virtualPath, true);
    }

    /// <summary>move/rename 后跟随跟踪记录：oldVirtual 及其后代（目录整体改名）
    /// 重写到 newVirtual 前缀下。源路径未被跟踪时目标也不跟踪——被移动的可能是
    /// 宿主既有内容，必须继续受回收站保护；replace 覆盖目标时目标内容被源内容
    /// 取代，同样按源的跟踪状态归一。</summary>
    private void FollowSessionCreatedMove(string oldVirtual, string newVirtual, bool targetExistedBefore)
    {
        var prefix = oldVirtual.TrimEnd('/') + "/";
        var moved = new List<string>();
        foreach (var key in _sessionCreated.Keys)
        {
            if (key.Equals(oldVirtual, StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                moved.Add(key);
        }
        var sourceWasTracked = moved.Count > 0;
        foreach (var key in moved)
        {
            _sessionCreated.TryRemove(key, out _);
            if (sourceWasTracked) _sessionCreated.TryAdd(newVirtual + key[oldVirtual.Length..], true);
        }
        if (targetExistedBefore && !sourceWasTracked) _sessionCreated.TryRemove(newVirtual, out _);
    }

    /// <summary>Cleanup 阶段判断删除目标是否应送回收站：仅在回收站开启、目标不属
    /// 于沙箱内部区域、且不是本实例运行期间新建时为 true。</summary>
    private bool ShouldSendToTrash(string virtualPath)
    {
        if (!DeleteToTrash) return false;
        if (IsSandboxInternalPath(virtualPath)) return false;
        return !_sessionCreated.ContainsKey(virtualPath);
    }

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
    /// __PSScriptPolicyTest 临时脚本）同理。统一判定见 SandboxPaths。</summary>
    private static bool IsSandboxInternalPath(string vpath) => SandboxPaths.IsInternal(vpath);


    // Resolve 结果的每运行缓存：同一虚拟路径在短时间内被反复 stat/open/read
    private readonly ConcurrentDictionary<string, Resolved> _resolveCache = new(StringComparer.Ordinal);
    private const int MaxResolveCache = 100_000;

    private Resolved ResolveCached(string name)
    {
        if (_resolveCache.TryGetValue(name, out var cached)) return cached;
        var resolved = Resolve(name);
        if (_resolveCache.Count < MaxResolveCache)
            _resolveCache[name] = resolved;
        return resolved;
    }

    /// <summary>ProbeAttributes 的"不存在"哨兵值（真实属性不会是全 1）。</summary>
    private static readonly FileAttributes NotExists = unchecked((FileAttributes)uint.MaxValue);

    /// <summary>一次元数据调用返回宿主属性；目标不存在（或因越权/非法字符
    /// 无法探测）时返回 NotExists。与 Directory.Exists/File.Exists 组合语义
    /// 等价，但每路径只付一次系统调用。</summary>
    private static FileAttributes ProbeAttributes(string real) => ProbeFile(real)?.Attributes ?? NotExists;

    /// <summary>单次元数据探测返回宿主文件信息（一次系统调用同时给出属性、
    /// 大小与时间戳，.NET FileSystemInfo 在首次访问后缓存）；目标不存在时
    /// 返回 null。</summary>
    private static FileSystemInfo? ProbeFile(string real)
    {
        try
        {
            var fi = new FileInfo(real);
            if (fi.Exists) return fi;          // 文件：一次系统调用带属性/大小/时间
            var di = new DirectoryInfo(real);
            return di.Exists ? di : null;      // 目录
        }
        catch (Exception ex) when (ex is FileNotFoundException
                or DirectoryNotFoundException or IOException
                or UnauthorizedAccessException or ArgumentException
                or NotSupportedException)
        {
            return null;
        }
    }

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

    // 落点校验记忆化：验证干净的父目录集合。安全前提——沙箱内进程无
    // SeCreateSymbolicLink 特权且 .NET 无法创建 junction，重解析点只能来自
    // 宿主侧带外变更；配合文件的 ReparsePoint 属性位廉价检查，干净结论
    // 不会放过真正的越界路径。
    private readonly ConcurrentDictionary<string, bool> _verifiedCleanParents = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>打开已存在的 real 时的落点校验（带父目录记忆化）。
    /// 命中记忆化时省去 GetFinalPathNameByHandleW（每次打开约 50µs 的主要
    /// 回调开销）；未命中才走完整校验并把父目录记入干净集合。</summary>
    private bool LandsWithinRootCached(string real, RootMap map, FileAttributes attrs)
    {
        var parent = Path.GetDirectoryName(real);
        var parentKnown = parent is not null
            && parent.Length >= map.RealTrim.Length
            && _verifiedCleanParents.ContainsKey(parent);
        var fileClean = attrs == NotExists || (attrs & FileAttributes.ReparsePoint) == 0;
        if (parentKnown && fileClean) return true;

        if (!PathLandsWithinRoot(real, map)) return false;
        if (parent is not null && parent.Length >= map.RealTrim.Length)
            _verifiedCleanParents.TryAdd(parent, true);
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
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileExW(string existingName, string newName, uint flags);

    /// <summary>仅大小写改名（skill.md → SKILL.md）：MoveFileExW 语义与 Node
    /// fs.renameSync 一致——NTFS 对同文件的大小写变更允许，.NET File.Move
    /// 的"目标存在"预检查会误判。MOVEFILE_REPLACE_EXISTING(1) 用于覆盖。</summary>
    private static void MoveFileExCaseRename(string oldReal, string newReal)
    {
        if (!MoveFileExW(oldReal, newReal, 1 /* MOVEFILE_REPLACE_EXISTING */))
            throw new IOException(null, Marshal.GetLastWin32Error());
    }

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
            var (allowed, why) = CheckCached(vpath, kind);
            // 放行决策走 Debug：jest 等工具的模块解析风暴会把默认 INFO 级别的
            // 逐访问日志放大成数十万行同步刷盘（全局锁串行所有 IO 线程），
            // 是沙箱内构建极慢的主因。拒绝与提权询问罕见且是诊断关键，保留 INFO。
            // VerboseEnabled 守卫避免热路径上无谓的 params 数组分配。
            if (Log.VerboseEnabled)
                Log.Debug("[POLICY] pid={0,-6} {1,-7} {2,-32} -> {3} ({4})",
                    info.ProcessId, kind, vpath, allowed ? "ALLOW" : "DENY", why);
            else if (!allowed)
                Log.Info("[POLICY] pid={0,-6} {1,-7} {2,-32} -> {3} ({4})",
                    info.ProcessId, kind, vpath, "DENY", why);
            if (!allowed) ok = false;
        }
        return ok;
    }

    // 策略判定的每运行缓存：jest 等工具会对同一批路径反复 stat/open。
    // 只缓存静态判定——ask/grant 的结果带副作用与 TTL，必须每次实测。
    private readonly ConcurrentDictionary<string, (bool Allowed, string Why)> _policyDecisions =
        new(StringComparer.Ordinal);

    private const int MaxPolicyDecisions = 200_000;

    private (bool Allowed, string Why) CheckCached(string vpath, string kind)
    {
        var key = string.Concat(kind, "\n", vpath);
        if (_policyDecisions.TryGetValue(key, out var cached)) return cached;
        var (allowed, why) = _policy.Check(vpath, kind);
        var decision = (allowed, why);
        if (!why.Contains('+') && _policyDecisions.Count < MaxPolicyDecisions)
            _policyDecisions[key] = decision;
        return decision;
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

    /// <summary>宿主端瞬时共享冲突退避。索引服务/杀软会以不含 FILE_SHARE_DELETE
    /// 的共享模式短暂握住刚写完的文件，紧接着的宿主端改名/删除虽合法却收到
    /// ERROR_SHARING_VIOLATION（沙箱侧表现为 EPERM）。只对 sharing/lock
    /// violation 重试少量几次，持锁者不释放时按原语义尽快失败。</summary>
    private static T WithTransientShareRetry<T>(Func<T> action)
    {
        const int MaxAttempts = 4;
        for (var attempt = 1; ; attempt++)
        {
            try { return action(); }
            catch (IOException ex) when (IsTransientShareConflict(ex) && attempt < MaxAttempts)
            {
                Thread.Sleep(attempt * 150);
            }
        }
    }

    private static void WithTransientShareRetry(Action action) =>
        WithTransientShareRetry<object?>(() => { action(); return null; });

    private static bool IsTransientShareConflict(IOException ex) =>
        unchecked((uint)ex.HResult) is 0x80070020u or 0x80070021u;

    /// <summary>删除类操作的宽限重试。刚执行完的 exe 其镜像节在 Dokan 卷上
    /// 异步拆除（宿主/驱动侧还要释放节引用），紧随其后的 File.Delete 可能短暂
    /// 收到 ERROR_ACCESS_DENIED——与"只读属性拒绝"同码，只能靠有界重试区分：
    /// 永久性拒绝在重试耗尽后按原语义失败，仅多付不到一秒的延迟。</summary>
    private const int MaxDeleteAttempts = 6;

    private static T WithDeleteRetry<T>(Func<T> action)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return action();
            }
            catch (Exception ex)
                when (attempt < MaxDeleteAttempts
                    && (ex is UnauthorizedAccessException
                        || (ex is IOException io
                            && unchecked((uint)io.HResult) is 0x80070005u or 0x80070020u or 0x80070021u)))
            {
                Thread.Sleep(100 * attempt);
            }
        }
    }

    private static void WithDeleteRetry(Action action) =>
        WithDeleteRetry<object?>(() => { action(); return null; });

    // A user can spend five minutes answering. Renew this specific driver request
    // while it is waiting, without raising Dokan's timeout for ordinary IO.
    private static Timer KeepRequestAlive(IDokanFileInfo info) => new(_ =>
    {
        try { info.TryResetTimeout(30_000); }
        catch (Exception ex) { Log.Debug("Request timeout renewal failed: {0}", ex.Message); }
    }, null, 10_000, 10_000);

    private Ctx? PopCtx(IDokanFileInfo info)
    {
        var cx = info.Context as Ctx;
        info.Context = null;
        if (cx is not null) _ctx.TryRemove(cx, out _);
        return cx;
    }

    // -- 文件生命周期 --------------------------------------------------------
    // ⚠️ 稳定性红线：本文件所有 Dokan 回调（CreateFile/GetFileInformation/
    // ReadFile/WriteFile/Cleanup/CloseFile/FindFiles 等）由 Dokan 驱动的
    // 多线程并发派发（SingleThread=false）。2026-09-27 曾因在 CreateFile
    // 热路径加入非线程安全的静态 Stopwatch + 静态数组累加插桩，导致回调
    // 竞争返回异常状态（DokanEndDispatchCreate STATUS_INVALID_PARAMETER），
    // 驱动进入不可恢复的坏卷状态——后续所有挂载"已挂载但 Z:\ 不可访问"，
    // 只能重启系统恢复（sc stop Dokan2 卡 STOP_PENDING，explorer 持有句柄）。
    // 因此：
    // 1. 严禁在热路径引入任何非线程安全静态/实例共享可变状态（Stopwatch、
    //    计数器、数组累加、未加锁的 DateTime.UtcNow 采样等）；
    // 2. 回调内共享数据必须用 ConcurrentDictionary/锁，或干脆不复用；
    // 3. 需要性能剖析时用独立实验进程 + 外部计时，绝不改生产回调代码。

    public NtStatus CreateFile(string fileName, FileAccess access, FileShare share,
        FileMode mode, FileOptions options, FileAttributes attributes, IDokanFileInfo info)
    {
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] ZwCreateFile {0} mode={1}", fileName, mode);
        // CreateFile 是最高频操作，绝大多数在 <1ms 内完成；KeepRequestAlive
        // 续期定时器只在命中静态 ask 规则时分配（见下方 Check 之前）。
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

                if (IsVirtualNul(vpath))
                {
                    info.Context = NewCtx(null, "NUL");
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

                var res = ResolveCached(fileName);
                var real = res.RealPath;
                _fileInfoCache.TryGetValue(vpath, out var statHit);
                // .exe 不走探测缓存：launcher 兼容 overlay 会改写 exe 的大小/属性
                // 语义（GetFileInformation 对 overlay 返回改写副本元数据），快照只
                // 反映宿主原始文件，缓存命中会让 pip 等 launcher 拿到错误尺寸被
                // Python 当脚本解析。其余路径缓存命中即与宿主一致。
                var cachedStat = !real.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                    && !(mode is FileMode.Create or FileMode.CreateNew or FileMode.Truncate)
                    && statHit.Expiry > DateTime.UtcNow;
                // 负缓存命中：300ms 内已确认该路径不存在（模块解析 ENOENT 探测
                // 风暴），跳过宿主 stat。创建类打开不走此路径——新建文件必须先
                // 真实验证宿主状态，不能因负缓存漏建。
                var cachedMissing = !cachedStat && !(mode is FileMode.Create or FileMode.CreateNew)
                    && _fileInfoNegativeCache.TryGetValue(vpath, out var negAt)
                    && negAt + NegativeCacheTtl > DateTime.UtcNow;
                FileSystemInfo? probe = cachedStat || cachedMissing ? null : ProbeFile(real);
                var exists = cachedStat || (probe is not null);
                var hostAttrs = cachedStat
                    ? statHit.Snapshot.Attributes
                    : probe?.Attributes ?? NotExists;
                var targetIsDir = cachedStat
                    ? hostAttrs.HasFlag(FileAttributes.Directory)
                    : exists && (hostAttrs & FileAttributes.Directory) != 0;
                // 负缓存命中时 exists=false，后续 FileNotFound 分支自然成立；
                // 但 Open/OpenOrCreate 不存在时仍应返回 FileNotFound（非 AccessDenied）。
                if (cachedMissing && mode is FileMode.Open) return FileNotFound;

                var creating = mode is FileMode.Create or FileMode.CreateNew or FileMode.Truncate
                               || (mode == FileMode.OpenOrCreate && !exists);
                // 新建路径条目才跟踪为"实例内创建"：Truncate / 命中已有文件的
                // OpenOrCreate 与 Create 属于覆盖写，宿主既有内容不受跟踪豁免
                var createsNewEntry =
                    (mode is FileMode.Create or FileMode.CreateNew or FileMode.OpenOrCreate) && !exists;

                // 目录上的 Execute 是 traverse 语义，按 read 管控；
                // 只有"文件 + Execute"才是执行管控（拉起进程/加载 DLL）。
                if (kinds.Contains(AccessKind.Execute) && (isDirReq || targetIsDir))
                {
                    kinds.Remove(AccessKind.Execute);
                    kinds.Add(AccessKind.Read);
                    access = WithoutExecute(access);
                }

                // 命中静态 ask 规则时，问询可能等待用户决策远超 Dokan 的 30 秒
                // IRP 超时；必须在进入阻塞问询之前安装续期定时器（ask 是低频
                // 操作，只为这一次打开付定时器分配的代价）。
                using var keepAlive = kinds.Any(kind => _policy.NeedsAsk(res.VirtualPath, kind))
                    ? KeepRequestAlive(info)
                    : null;
                if (!Check(res.VirtualPath, kinds, info)) return AccessDenied;

                if (isDirReq)
                {
                    // junction / 符号链接目录会把打开与创建重定向到根外
                    if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                    if (mode is FileMode.Create or FileMode.CreateNew or FileMode.OpenOrCreate && !exists)
                    {
                        Directory.CreateDirectory(real);
                        TrackSessionCreated(res.VirtualPath);
                        InvalidateDirListing(fileName, isDirectory: true);
                        InvalidateFileInfo(fileName);
                        NotifyCreate(fileName, isDirectory: true);
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
                    var nonRead = access & ~(ReadBits | FileAccess.GenericRead
                        | FileAccess.Synchronize | FileAccess.MaximumAllowed);
                    // rmdir / Remove-Item / fs.rmdirSync（RemoveDirectoryW）以文件句柄方式
                    // （FILE_FLAG_BACKUP_SEMANTICS，无 FILE_DIRECTORY_FILE）打开目录，实测
                    // 掩码为 DELETE | FILE_WRITE_ATTRIBUTES | 读属性位（后者用于删除后
                    // 的父目录时间戳）。若在此拒绝，删除请求永远到不了 DeleteDirectory
                    // 与 Cleanup 回调，策略放行了删除也无法删除目录（表现为 EPERM）。
                    // 放行 DELETE/WRITE_ATTRIBUTES 组合不产生额外授权：删除仍受
                    // DeleteDirectory 的策略复查与空目录检查、Cleanup 的最终删除兜底；
                    // 经由文件句柄写目录数据、改属主等无意义/特权语义继续拒绝。
                    var directoryDataWrite = nonRead & ~(FileAccess.Delete | FileAccess.WriteAttributes);
                    if ((directoryDataWrite != 0) || mode is not (FileMode.Open or FileMode.OpenOrCreate))
                        return AccessDenied;
                    if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                    info.IsDirectory = true;
                    info.Context = NewCtx(null);
                    return Success;
                }

                if (mode == FileMode.CreateNew && exists) return FileExists;
                if (mode is FileMode.Open or FileMode.Truncate && !exists)
                {
                    // ENOENT 探测写入负缓存：模块解析对同一路径反复 Open 探测，
                    // 缓存"不存在"避免每次完整 IRP 往返宿主 stat。
                    if (_fileInfoNegativeCache.Count < MaxNegativeEntries)
                        _fileInfoNegativeCache[vpath] = DateTime.UtcNow;
                    return FileNotFound;
                }

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
                    // Win32 允许 CREATE_NEW/TRUNCATE 携带只读属性位（csc 资源
                    // 临时文件等），.NET FileStream 判为非法组合并抛异常；
                    // 创建类语义必须携带写访问，调用方需要读回时补上 Read。
                    // 破坏性模式（Create/Truncate）在打开瞬间即清空目标——若 real
                    // 经文件符号链接指向根外，校验拒绝时宿主文件已被清零。因此在
                    // 打开前先做一次不跟随的落点预检，发现越界即拒绝。
                    var streamAccess = mode is FileMode.Create or FileMode.CreateNew or FileMode.Truncate
                        ? (kinds.Contains(AccessKind.Read)
                            ? System.IO.FileAccess.ReadWrite
                            : System.IO.FileAccess.Write)
                        : kinds.Contains(AccessKind.Write)
                            ? System.IO.FileAccess.ReadWrite
                            : System.IO.FileAccess.Read;
                    // 破坏性模式（Create/Truncate）在打开瞬间即清空目标——若 real
                    // 经文件符号链接指向根外，校验拒绝时宿主文件已被清零。因此在
                    // 打开前先做一次不跟随的落点预检，发现越界即拒绝。
                    if (creating && !PathLandsWithinRoot(real, res.Map))
                    {
                        Log.Info("[FS] 预检落点越界拒绝（破坏性打开） {0}", vpath);
                        return AccessDenied;
                    }
                    // 既有文件打开的落点校验在打开前完成（带父目录记忆化，
                    // 见 LandsWithinRootCached）；创建语义已由上方预检覆盖，
                    // overlay 副本在引导区内不属于该根映射，均跳过。
                    var needsLandCheck = streamPath == real && !creating;
                    if (needsLandCheck && !LandsWithinRootCached(real, res.Map, hostAttrs))
                    {
                        Log.Info("[FS] 落点越界拒绝 {0}", vpath);
                        return AccessDenied;
                    }
                    var metaOnly = streamPath == real && !creating
                        && IsMetadataOnlyOpen(access);
                    if (metaOnly)
                    {
                        // 纯元数据探测：延迟宿主打开（零宿主系统调用）。Probe 已在
                        // 上方就绪，后续 GetFileInformation 直接复用；内核保证此类
                        // 句柄不会收到读写 IRP（访问掩码不含 ReadData/WriteData）。
                        info.Context = NewCtxLazy(streamPath, FileMode.Open,
                            System.IO.FileAccess.Read,
                            FileShare.ReadWrite | FileShare.Delete, real, probe);
                        return Success;
                    }
                    var stream = WithTransientShareRetry(() => new FileStream(streamPath, mode,
                        streamAccess,
                        FileShare.ReadWrite | FileShare.Delete,
                        64 * 1024, FileOptions.None));
                    info.Context = NewCtx(stream, real);
                    if (createsNewEntry)
                    {
                        TrackSessionCreated(res.VirtualPath);
                        InvalidateDirListing(fileName);
                        InvalidateFileInfo(fileName);
                        NotifyCreate(fileName, isDirectory: false);
                    }
                    // Truncate/覆盖写改变长度与时间：即使未新建条目，stat 快照也过期
                    if (!createsNewEntry && mode is FileMode.Truncate) InvalidateFileInfo(fileName);
                }
                catch (FileNotFoundException) { return FileNotFound; }
                catch (DirectoryNotFoundException) { return PathNotFound; }
                catch (UnauthorizedAccessException ex) { Log.Warn("[FS] 打开被宿主拒绝 {0}: {1}", vpath, ex.Message); return AccessDenied; }
                catch (IOException ex) when ((uint)ex.HResult is 0x80070020u or 0x80070021u)
                {
                    // 0x80070020 = ERROR_SHARING_VIOLATION；0x80070021 = ERROR_BUSY
                    //（文件/句柄被占用）。两者都是"目标暂被占用"语义：映射为
                    // SharingViolation 让调用方按共享冲突重试/报错，而不是笼统的
                    // AccessDenied（后者会误导为权限问题）。Dokan 卷在高并发 worker
                    // 读同一缓存文件时偶发 ERROR_BUSY（宿主 NTFS 无此问题），映射后
                    // 语义与 NTFS 对齐。
                    return SharingViolation;
                }
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

    private Ctx NewCtxLazy(string openPath, System.IO.FileMode mode, System.IO.FileAccess access,
        System.IO.FileShare share, string realPath, FileSystemInfo? probe)
    {
        var cx = new Ctx
        {
            PendingOpen = true,
            OpenPath = openPath,
            OpenMode = mode,
            OpenAccess = access,
            OpenShare = share,
            RealPath = realPath,
            Probe = probe,
        };
        _ctx.TryAdd(cx, cx);
        return cx;
    }

    private Ctx NewCtx(FileStream? stream, string realPath = "")
    {
        var cx = new Ctx { Stream = stream, RealPath = realPath };
        _ctx.TryAdd(cx, cx);
        return cx;
    }

    /// <summary>虚拟 NUL 文件：部分 Windows 版本上 AppContainer 打不开 NUL
    /// 设备（cargo Stdio::null、go os/exec 默认 stdin、python os.devnull 等
    /// 都会踩中）。卷内 /dynobox/nul.file 提供等价语义：读得 EOF、写即丢弃、
    /// 无宿主文件；名称解析的通用方案见 Runner 的 DOS 设备别名与
    /// RuntimeCompatibility 的运行时预载补丁。</summary>
    private static bool IsVirtualNul(string vpath) => SandboxPaths.IsVirtualNul(vpath);

    public void Cleanup(string fileName, IDokanFileInfo info)
    {
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] Cleanup {0}", fileName);
        try
        {
            // Executable images and memory-mapped files can still issue paging IO
            // after Cleanup. Keep the authorized stream until the final CloseFile.
            var cx = GetCtx(info);
            if (cx is not null && cx.Stream is not null)
            {
                lock (cx.Gate) { cx.Stream.Flush(); }
            }
            if (info.DeletePending)
            {
                var res = ResolveCached(fileName);
                var real = res.RealPath;
                // 提前删除（DeleteFile/DeleteDirectory 内已执行）或竞态移除后，
                // 目标已不存在：不再进入回收站/直删分支，避免误报
                // "回收站删除未执行，文件保留"。
                var alreadyGone = info.IsDirectory ? !Directory.Exists(real) : !File.Exists(real);
                if (alreadyGone) return;
                // 必须用规范虚拟路径判断：原始请求名可能携带 .. 段
                // （如 /dynobox/../C/...，按原始名前缀匹配会误判为内部区域，
                // 导致开启回收站时用户文件被永久删除）。
                if (ShouldSendToTrash(res.VirtualPath))
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
                    var trashError = "";
                    var trashed = WithTransientShareRetry(() => RecycleBin.TrySend(real, out trashError));
                    if (trashed)
                    {
                        InvalidateFileInfo(fileName);
                        InvalidateDirListing(fileName, isDirectory: info.IsDirectory);
                        Log.Info("[FS] 删除 {0} (已送回收站)", Normalize(fileName));
                    }
                    else
                        Log.Warn("[FS] 回收站删除未执行，文件保留 {0}: {1}", fileName, trashError);
                }
                else
                {
                    try
                    {
                        WithDeleteRetry(() =>
                        {
                            if (info.IsDirectory) Directory.Delete(real);
                            else File.Delete(real);
                        });
                        // 删除成功后才移除跟踪：失败保留原文件时仍按"实例内新建"
                        // 处理，之后的重试删除继续直接清除
                        _sessionCreated.TryRemove(res.VirtualPath, out _);
                        InvalidateFileInfo(fileName);
                        // 回收站开启但未送回收站的删除均为刻意绕过（实例内新建或沙箱
                        // 内部区域），单独标注便于与普通直接删除区分
                        if (DeleteToTrash)
                            Log.Info("[FS] 删除 {0} (实例内新建或内部区域，未送回收站)", Normalize(fileName));
                        else
                            Log.Info("[FS] 删除 {0}", Normalize(fileName));
                    }
                    catch (FileNotFoundException) { }
                    catch (DirectoryNotFoundException) { }
                    catch (IOException ex)
                    {
                        // 仍被占用：挂入延迟队列由后台任务重试，避免视图与宿主
                        // 状态脱节形成"幽灵文件"（目录判空会把它们算作存在）
                        Log.Warn("[FS] 删除失败，挂入延迟队列 {0}: {1}", fileName, ex.Message);
                        EnqueueDeferredDelete(real);
                        InvalidateDirListing(fileName, isDirectory: false);
                    }
                }
            }
            // SetEndOfFile 最终长度兜底：Dokan 驱动部分页读改写（RMW）会在
            // ftruncate IRP 之后补发整页 WriteFile（tar 解压实测 30→4096 NUL
            // 覆盖），宿主 NTFS 无此行为。此处（句柄关闭前，所有写已完成）按
            // 提示强制截断，保证文件最终长度与 ftruncate 语义一致。
            if (!info.DeletePending && cx is not null && cx.EndOfFileHint is { } hintLen
                && cx.Stream is not null)
            {
                try
                {
                    lock (cx.Gate)
                    {
                        if (cx.Stream.Length > hintLen)
                        {
                            cx.Stream.SetLength(hintLen);
                            cx.Stream.Flush(flushToDisk: true);
                            Log.Debug("[FS] Cleanup 按 SetEndOfFile 提示截断 {0} {1} -> {2}",
                                Normalize(fileName), cx.Stream.Length, hintLen);
                            InvalidateFileInfo(fileName);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log.Debug("[FS] Cleanup 截断失败（忽略） {0}: {1}", fileName, ex.Message);
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] CloseFile {0}", fileName);
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] ReadFile {0} len={1} off={2}", fileName, buffer.Length, offset);
        try
        {
            var cx = GetCtx(info);
            if (cx is not null && cx.Stream is null && cx.RealPath == "NUL") { bytesRead = 0; return NtStatus.EndOfFile; }
            if (cx is null || (cx.Stream is null && !EnsureStream(cx))) { bytesRead = 0; return AccessDenied; }
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

    /// <summary>按规范虚拟路径的写互斥锁。tar 解压等场景下，同一个文件的
    /// WriteFile 与 SetEndOfFile 可能携带不同句柄（探测句柄 vs 写句柄），
    /// 各自持不同 Gate 不互斥，导致 Dokan IRP 顺序错乱——实测 SetEndOfFile(30)
    /// 先于 WriteFile(4096) 到达时截断被覆盖，解压文件残留 4KB NUL pad
    /// （pluginmgr/skillmgr 读取 package.json 解析失败）。按路径加锁保证
    /// 同一文件的写与截断串行、按 IRP 到达顺序执行。</summary>
    private readonly ConcurrentDictionary<string, object> _writeLocks = new();

    private object WriteLockFor(string fileName)
    {
        var key = CanonicalVirtual(fileName).TrimEnd('/');
        return _writeLocks.GetOrAdd(key, static _ => new object());
    }

    public NtStatus WriteFile(string fileName, byte[] buffer, out int bytesWritten, long offset,
        IDokanFileInfo info)
    {
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] WriteFile {0} len={1} off={2}", fileName, buffer.Length, offset);
        try
        {
            var cx = GetCtx(info);
            if (cx is not null && cx.Stream is null && cx.RealPath == "NUL") { bytesWritten = buffer.Length; return Success; }
            if (cx is null || (cx.Stream is null && !EnsureStream(cx))) { bytesWritten = 0; return AccessDenied; }
            cx.Probe = null;   // 写入改变大小/时间，探针数据作废
            InvalidateFileInfo(fileName);   // 长度/时间变化，stat 快照作废
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] Flush {0}", fileName);
        try
        {
            var cx = GetCtx(info);
            if (cx?.Stream is not null)
            {
                lock (cx.Gate)
                {
                    try { cx.Stream.Flush(flushToDisk: true); }
                    catch (Exception ex)
                    {
                        Log.Warn("[FS] FlushFileBuffers 失败 {0}: {1}", fileName, ex.Message);
                        return AccessDenied;
                    }
                }
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] GetFileInfo {0}", fileName);
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
            if (IsVirtualNul(CanonicalVirtual(fileName)))
            {
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = FileAttributes.Normal,
                    CreationTime = DateTime.Now,
                    LastAccessTime = DateTime.Now,
                    LastWriteTime = DateTime.Now,
                    Length = 0,
                };
                return Success;
            }
            // stat 缓存命中：TTL 内重复 stat 零宿主系统调用。只在"存在"且无写
            // 未失效时命中（写路径都会失效），因此快照与宿主一致。
            var statKey = CanonicalVirtual(fileName).TrimEnd('/');
            if (statKey.Length > 0 && _fileInfoCache.TryGetValue(statKey, out var hit)
                && hit.Expiry > DateTime.UtcNow)
            {
                var snap = hit.Snapshot;
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = snap.Attributes == 0 ? FileAttributes.Normal
                               : snap.Attributes & ~FileAttributes.Normal,
                    CreationTime = snap.CreationTime,
                    LastAccessTime = snap.LastAccessTime,
                    LastWriteTime = snap.LastWriteTime,
                    Length = snap.Length,
                };
                return Success;
            }
            // 负缓存命中：300ms 内已确认不存在，直接 FileNotFound（模块解析的
            // ENOENT 探测风暴免去重复宿主 stat）。创建/删除/改名已失效对应
            // 路径，创建后立即 stat 不会误判。
            if (statKey.Length > 0 && _fileInfoNegativeCache.TryGetValue(statKey, out var negAt)
                && negAt + NegativeCacheTtl > DateTime.UtcNow)
            {
                fileInfo = default;
                return FileNotFound;
            }
            // 延迟打开 ctx 自带创建时刻的探测结果（一次系统调用），查询 IRP
            // 直接复用——stat 的 QueryInformation 零宿主系统调用。写入/截断
            // 已使探针失效，长生命周期句柄的陈旧窗口仅限只读探测。
            var ctxProbe = (info.Context as Ctx)?.Probe;
            if (ctxProbe is not null && ctxProbe.Exists
                && (ctxProbe.Attributes & FileAttributes.Directory) == 0)
            {
                var probeFile = (FileInfo)ctxProbe;
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = probeFile.Attributes == 0 ? FileAttributes.Normal
                               : probeFile.Attributes & ~FileAttributes.Normal,
                    CreationTime = probeFile.CreationTime,
                    LastAccessTime = probeFile.LastAccessTime,
                    LastWriteTime = probeFile.LastWriteTime,
                    Length = probeFile.Length,
                };
                return Success;
            }
            var res = ResolveCached(fileName);
                var real = res.RealPath;
            // 文件是 stat 的大头：FileInfo 一个包装就能拿到全部元数据；目录才
            // 退回 DirectoryInfo 二次探测（原先每个路径固定两次包装/系统调用）。
            var fi = new FileInfo(real);
            if (fi.Exists)
            {
                var length = GetRuntimeOverlay(real) is { } overlay
                    ? new FileInfo(overlay).Length
                    : fi.Length;
                _fileInfoCache[statKey] = (DateTime.UtcNow + FileInfoCacheTtl,
                    new FileInfoSnapshot(fi.Attributes, fi.CreationTime, fi.LastAccessTime,
                        fi.LastWriteTime, length));
                fileInfo = new FileInformation
                {
                    FileName = fileName,
                    Attributes = fi.Attributes == 0 ? FileAttributes.Normal
                               : fi.Attributes & ~FileAttributes.Normal,
                    CreationTime = fi.CreationTime,
                    LastAccessTime = fi.LastAccessTime,
                    LastWriteTime = fi.LastWriteTime,
                    Length = length,
                };
                return Success;
            }
            var di = new DirectoryInfo(real);
            if (di.Exists)
            {
                _fileInfoCache[statKey] = (DateTime.UtcNow + FileInfoCacheTtl,
                    new FileInfoSnapshot(di.Attributes, di.CreationTime, di.LastAccessTime,
                        di.LastWriteTime, 0));
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
            fileInfo = default;
            if (statKey.Length > 0 && _fileInfoNegativeCache.Count < MaxNegativeEntries)
                _fileInfoNegativeCache[statKey] = DateTime.UtcNow;
            return FileNotFound;
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] FindFiles {0}", fileName);
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

            var resolved = Resolve(fileName);
            var dir = new DirectoryInfo(resolved.RealPath);
            if (!dir.Exists) return NotADirectory;

            // 目录枚举缓存（TTL 2s）：爬取型负载（node_modules 遍历）会对同一
            // 目录反复枚举，每次都走宿主 EnumerateFileSystemInfos 代价高。缓存
            // 以规范虚拟路径为键；本卷内的任何变更（创建/删除/改名/延后删除）
            // 立即失效对应目录，宿主侧带外变更由 TTL 兜底。条目数组跨 IRP 只读
            // 共享，无需复制。
            var cacheKey = resolved.VirtualPath;
            if (_dirListingCache.TryGetValue(cacheKey, out var cached) && cached.Expiry > DateTime.UtcNow)
            {
                files = cached.Entries;
                return Success;
            }
            var listing = new List<FileInformation>();
            foreach (var entry in dir.EnumerateFileSystemInfos())
            {
                var isDirEntry = entry is DirectoryInfo;
                var entryAttrs = isDirEntry
                    ? FileAttributes.Directory
                    : entry.Attributes & ~FileAttributes.Normal;
                // 预填 stat 缓存（紧随其后的 GetFileInformation 直接命中，免去
                // node_modules 爬取级负载的每文件宿主 stat）。.exe 例外：launcher
                // 兼容 overlay 会让 GetFileInformation 返回 overlay 副本的大小/属性
                // （AnalyzeRuntimeOverlay 生成一次性改写副本），此处枚举到的是宿主
                // 原始文件元数据，预填会覆盖 overlay 语义（pip 等 launcher 读自身
                // 拿到错误尺寸被 Python 当脚本解析）——.exe 一律不预填，走常规路径。
                if (!isDirEntry && entry.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    listing.Add(new FileInformation
                    {
                        FileName = entry.Name,
                        Attributes = entryAttrs,
                        CreationTime = entry.CreationTime,
                        LastAccessTime = entry.LastAccessTime,
                        LastWriteTime = entry.LastWriteTime,
                        Length = (entry as FileInfo)?.Length ?? 0,
                    });
                    continue;
                }
                var childKey = resolved.VirtualPath.TrimEnd('/') + "/" + entry.Name;
                _fileInfoCache[childKey] = (DateTime.UtcNow + FileInfoCacheTtl,
                    new FileInfoSnapshot(entryAttrs, entry.CreationTime, entry.LastAccessTime,
                        entry.LastWriteTime, (entry as FileInfo)?.Length ?? 0));
                listing.Add(new FileInformation
                {
                    FileName = entry.Name,
                    Attributes = entryAttrs,
                    CreationTime = entry.CreationTime,
                    LastAccessTime = entry.LastAccessTime,
                    LastWriteTime = entry.LastWriteTime,
                    Length = (entry as FileInfo)?.Length ?? 0,
                });
            }
            _dirListingCache[cacheKey] = (DateTime.UtcNow.AddSeconds(2), listing);
            files = listing;
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] FindFilesWithPattern {0} pattern={1}", fileName, searchPattern);
        // Node readdirSync(dir, { withFileTypes: true }) 走这个回调；此前返回
        // NotImplemented 被 Dokan 映射为错误，导致 scandir 刚创建目录报 ENOENT
        // （appmgr/pluginmgr/skillmgr 安装流程的共性失败）。实现：无过滤通配符
        // （"*" 或空）时等价 FindFiles（复用其缓存与预填）；否则枚举后按
        // DOS 风格通配符（* 任意、? 单字符）过滤。
        if (string.IsNullOrEmpty(searchPattern) || searchPattern == "*")
            return FindFiles(fileName, out files, info);

        var status = FindFiles(fileName, out var all, info);
        if (status != Success) { files = all; return status; }
        var filtered = new List<FileInformation>();
        foreach (var entry in all)
        {
            if (MatchesDosPattern(entry.FileName, searchPattern)) filtered.Add(entry);
        }
        files = filtered;
        return Success;
    }

    /// <summary>DOS 风格通配符匹配：* 匹配任意序列（含空），? 匹配单字符。大小写不敏感。</summary>
    private static bool MatchesDosPattern(string name, string pattern)
    {
        // cmd.exe 等系统组件用 DOS 8.3 风格通配符枚举目录找可执行文件，pattern
        // 形如 node"*（8.3 名基 node 后接 " 与扩展名通配）。此前把 " 当字面
        // 字符导致 node"* 匹配不上 node.exe，cmd 报 "'node' is not recognized"
        // （PATH 搜索在卷上失效）。" 的语义：它终止 8.3 名基；其后按通配继续。
        // 对长名文件，基匹配仍按前缀生效（NODE.EXE 的 8.3 名基为 NODE）。
        // 处理：把 " 前后段拼接成普通模式——" 前为基，去掉 " 后按 * / ? 匹配。
        var normalized = pattern.Replace("\"", "");
        return Match(name, 0, normalized, 0);

        static bool Match(string s, int si, string p, int pi)
        {
            while (pi < p.Length)
            {
                if (p[pi] == '*')
                {
                    // 跳过连续 *，贪心匹配剩余 pattern
                    while (pi < p.Length && p[pi] == '*') pi++;
                    if (pi == p.Length) return true;
                    for (var k = si; k <= s.Length; k++)
                    {
                        if (Match(s, k, p, pi)) return true;
                    }
                    return false;
                }
                if (si >= s.Length) return false;
                if (p[pi] == '?' || char.ToUpperInvariant(p[pi]) == char.ToUpperInvariant(s[si]))
                {
                    si++;
                    pi++;
                    continue;
                }
                return false;
            }
            return si == s.Length;
        }
    }

    public NtStatus SetFileAttributes(string fileName, FileAttributes attributes,
        IDokanFileInfo info)
    {
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] SetAttr {0} {1}", fileName, attributes);
        try
        {
            try
            {
                var res = ResolveCached(fileName);
                var real = res.RealPath;
                if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
                var cur = File.GetAttributes(real);
                if (attributes.HasFlag(FileAttributes.ReadOnly))
                    File.SetAttributes(real, cur | FileAttributes.ReadOnly);
                else
                    File.SetAttributes(real, cur & ~FileAttributes.ReadOnly);
                InvalidateFileInfo(fileName);
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] SetTime {0}", fileName);
        try
        {
            var res = ResolveCached(fileName);
                var real = res.RealPath;
            if (!PathLandsWithinRoot(real, res.Map)) return AccessDenied;
            if (creationTime.HasValue) File.SetCreationTime(real, creationTime.Value);
            if (lastAccessTime.HasValue) File.SetLastAccessTime(real, lastAccessTime.Value);
            if (lastWriteTime.HasValue) File.SetLastWriteTime(real, lastWriteTime.Value);
            InvalidateFileInfo(fileName);
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] DeleteFile {0}", fileName);
        try
        {
            var res = ResolveCached(fileName);
                var real = res.RealPath;
            if (!File.Exists(real)) return FileNotFound;
            if (!info.DeletePending) return Success;
            var (allowed, _) = CheckCached(res.VirtualPath, AccessKind.Write);
            if (!allowed) return AccessDenied;
            // 回收站语义要求句柄全部关闭后整体移动，仍延后到 Cleanup 执行
            if (ShouldSendToTrash(res.VirtualPath)) return Success;
            // 尽早执行真实删除：若推迟到 Cleanup，宿主端的删除失败（文件被宿主
            // 进程占用等）会被吞成"删除成功"——条目随即从虚拟视图消失，父目录
            // 再报误导性的 ENOTEMPTY（幽灵空目录）。此处失败能以准确的
            // NtStatus 回给调用方；删除成功后 Cleanup 的重复删除按缺失静默处理。
            try
            {
                WithDeleteRetry(() => File.Delete(real));
                _sessionCreated.TryRemove(res.VirtualPath, out _);
                InvalidateDirListing(fileName);
                InvalidateFileInfo(fileName);
                NotifyDelete(fileName, isDirectory: false);
                // 与 Cleanup 的删除日志保持同一形态，回收站开启时标注绕过原因
                if (DeleteToTrash)
                    Log.Info("[FS] 删除 {0} (实例内新建或内部区域，未送回收站)", Normalize(fileName));
                else
                    Log.Info("[FS] 删除 {0}", Normalize(fileName));
                return Success;
            }
            catch (FileNotFoundException) { return FileNotFound; }
            catch (DirectoryNotFoundException) { return PathNotFound; }
            catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException)
            {
                // 重试耗尽仍删不掉（调用方刚关闭的写句柄在卷侧尚未完全释放、
                // 镜像节未拆完等瞬态占用）：退回 delete-on-close——保留
                // DeletePending 由 Cleanup 在末个句柄关闭时再删，仍失败则入
                // 挂起队列由后台任务重试。与 NTFS 的行为一致；此处过早报错
                // 会让 go RemoveAll 这类调用方看到误导性的 ENOTEMPTY。
                Log.Warn("[FS] 删除延迟到 Cleanup {0}: {1}", fileName, ex.Message);
                EnqueueDeferredDelete(res.RealPath);
                return Success;
            }
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] DeleteDirectory {0}", fileName);
        try
        {
            var res = ResolveCached(fileName);
                var real = res.RealPath;
            if (!Directory.Exists(real)) return PathNotFound;
            if (!info.DeletePending) return Success;
            var (allowed, _) = CheckCached(res.VirtualPath, AccessKind.Write);
            if (!allowed) return AccessDenied;
            // 目录内刚 unlink 的文件经卷上 Cleanup 异步完成删除（delete-on-close），
            // 立即判空会短暂看到"非空"（go 的 RemoveAll 收尾即此形态）。短退避等待
            // 删除落地；仍有残留才是真非空，按原语义拒绝。判空时排除挂起删除
            // 队列中的"幽灵"条目——它们在宿主侧尚存但视图上已删除。
            // 退避窗口：Dokan 卷上递归删除（rmSync recursive）时子目录的
            // Cleanup 完成可能跨越数百 ms（appmgr 大目录树实测），5 次不够；
            // 拉长到 ~2.5s，同时每次退避后主动清理 deferred 幽灵条目。
            var viewEmpty = false;
            for (var attempt = 0; ; attempt++)
            {
                viewEmpty = !Directory.EnumerateFileSystemEntries(real)
                    .Any(entry => !IsDeferredDelete(entry));
                if (viewEmpty) break;
                if (attempt >= 12) return DirectoryNotEmpty;
                Thread.Sleep(50 + attempt * 30);
            }
            // 与 DeleteFile 相同：尽早执行真实删除，避免 Cleanup 失败被吞成
            // "删除成功"后视图与宿主状态脱节（目录被占用时报准确错误）
            if (ShouldSendToTrash(res.VirtualPath)) return Success;
            try
            {
                WithTransientShareRetry(() => Directory.Delete(real));
                _sessionCreated.TryRemove(res.VirtualPath, out _);
                InvalidateDirListing(fileName, isDirectory: true);
                InvalidateFileInfo(fileName);
                NotifyDelete(fileName, isDirectory: true);
                if (DeleteToTrash)
                    Log.Info("[FS] 删除 {0} (实例内新建或内部区域，未送回收站)", Normalize(fileName));
                else
                    Log.Info("[FS] 删除 {0}", Normalize(fileName));
                return Success;
            }
            catch (FileNotFoundException) { return PathNotFound; }
            catch (DirectoryNotFoundException) { return PathNotFound; }
            catch (UnauthorizedAccessException) { return AccessDenied; }
            catch (IOException) when (Directory.EnumerateFileSystemEntries(real).Any()
                && Directory.EnumerateFileSystemEntries(real).All(entry => IsDeferredDelete(entry)))
            {
                // 视图已空、宿主侧只剩挂起删除的幽灵条目：目录挂入队列由后台
                // 任务清尾，返回成功——调用方（go RemoveAll 等）不应为幽灵
                // 条目承担失败。空目录不适用本分支：宿主占用（如进程 CWD 句柄）
                // 导致的删除失败必须如实上报，不得吞成"删除成功"。
                Log.Warn("[FS] 删除目录（仅剩幽灵条目，宿主侧延后清理） {0}", fileName);
                EnqueueDeferredDelete(real);
                _sessionCreated.TryRemove(res.VirtualPath, out _);
                InvalidateDirListing(fileName, isDirectory: true);
                InvalidateFileInfo(fileName);
                NotifyDelete(fileName, isDirectory: true);
                return Success;
            }
            catch (IOException ex) when (Directory.EnumerateFileSystemEntries(real).Any())
            {
                // 判空与删除之间被并发写入：按真实原因返回而非笼统的拒绝
                Log.Warn("[FS] 删除目录失败（非空） {0}: {1}", fileName, ex.Message);
                return DirectoryNotEmpty;
            }
            catch (IOException ex) { Log.Warn("[FS] 删除目录失败 {0}: {1}", fileName, ex.Message); return AccessDenied; }
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] MoveFile {0} -> {1}", oldName, newName);
            // 先做策略检查（可能触发 ask → 用户决策 → 阻塞），必须在 _life 锁外
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
            try
            {
                lock (_life)
                {

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
                var targetExistedBefore = replace && File.Exists(newReal);
                // 仅大小写 rename（skill.md → SKILL.md）：Windows/NTFS 语义下是
                // 同文件的 case 变更。宿主 Node fs.renameSync（MoveFileExW）成功，
                // 但 .NET File.Move 会因目标"已存在"（大小写不敏感匹配）报共享
                // 冲突；skillmgr 安装流程的 lowercase-skill.md → SKILL.md 即此场景。
                // 走 MoveFileExW（与 Node/Windows 语义一致）而非 File.Move 预检查。
                var caseOnlyRename =
                    !string.Equals(oldReal, newReal, StringComparison.Ordinal)
                    && Path.GetFileName(oldReal).Equals(Path.GetFileName(newReal), StringComparison.OrdinalIgnoreCase)
                    && File.Exists(oldReal)
                    && !Directory.Exists(oldReal);
                try
                {
                    if (caseOnlyRename)
                        WithTransientShareRetry(() => MoveFileExCaseRename(oldReal, newReal));
                    else if (replace && File.Exists(newReal))
                        WithTransientShareRetry(() => File.Replace(oldReal, newReal, null));
                    else if (Directory.Exists(oldReal))
                        WithTransientShareRetry(() => Directory.Move(oldReal, newReal));
                    else
                        WithTransientShareRetry(() => File.Move(oldReal, newReal, replace));
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
                FollowSessionCreatedMove(oldVp, newVp, targetExistedBefore);
                InvalidateDirListing(oldName);
                InvalidateDirListing(newName);
                InvalidateFileInfo(oldName);
                InvalidateFileInfo(newName);
                NotifyRename(oldName, newName, Directory.Exists(newReal));
                if (cx is not null && cx.Stream is null && cx.PendingOpen)
                {
                    // 延迟打开的 ctx：仅更新路径，宿主句柄在首个读写回调时按
                    // 新路径打开。
                    cx.RealPath = newReal;
                    cx.OpenPath = newReal;
                    cx.Probe = null;
                }
                else if (cx is not null && cx.Stream is null)
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
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] SetEndOfFile {0} {1}", fileName, length);
        try
        {
            // 与 WriteFile 同路径串行（见 _writeLocks 说明）：同一文件的写与
            // 截断按 IRP 到达顺序执行。若此处不拿锁，tar 解压时 SetEndOfFile
            // 会与并发 WriteFile(4096) 竞态——截断先到则被后到写覆盖，解压
            // 文件残留 4KB NUL pad（pluginmgr 读 package.json 解析失败）。
            lock (WriteLockFor(fileName))
            {
                return SetEndOfFileCore(fileName, length, info);
            }
        }
        catch (Exception ex)
        {
            Log.Error("SetEndOfFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    private NtStatus SetEndOfFileCore(string fileName, long length, IDokanFileInfo info)
    {
        try
        {
            var cx = GetCtx(info);
            // 流句柄可能是只读打开的（tar 解压先用只读句柄再 ftruncate），对只读
            // FileStream 调 SetLength 会抛 NotSupportedException——此时改用独立
            // Write 句柄完成截断。无论流路径是否成功，最终都以宿主实际长度为准校验。
            var truncatedByStream = false;
            if (cx is not null)
            {
                if (cx.Stream is null && cx.PendingOpen && !EnsureStream(cx))
                    return AccessDenied;
                if (cx.Stream is not null)
                {
                    try
                    {
                        lock (cx.Gate)
                        {
                            cx.Stream.SetLength(length);
                            cx.Stream.Flush(flushToDisk: true);
                            truncatedByStream = true;
                            // 记录最终长度提示：Dokan 驱动部分页读改写（RMW）会
                            // 在 SetEndOfFile 之后补发整页 WriteFile（tar 解压实测
                            // 30→4096 覆盖），CloseFile 时按此提示兜底截断。
                            cx.EndOfFileHint = length;
                        }
                        cx.Probe = null;
                    }
                    catch (Exception ex) when (ex is NotSupportedException or IOException)
                    {
                        // 只读流无法截断（tar 解压的 ftruncate 形态）：落到
                        // 独立 Write 句柄路径。
                        Log.Debug("[FS] SetEndOfFile 流不可写({0})，改用独立句柄", ex.GetType().Name);
                    }
                }
            }
            InvalidateFileInfo(fileName);
            // 流路径失败或压根无流时，用独立 Write 句柄截断（Windows 上只读句柄
            // 不阻止其他 Write 句柄打开同文件——FileShare.ReadWrite|Delete）。
            if (!truncatedByStream)
            {
                var res = ResolveCached(fileName);
                var (allowed, _) = CheckCached(res.VirtualPath, AccessKind.Write);
                if (!allowed) return AccessDenied;
                if (!PathLandsWithinRoot(res.RealPath, res.Map)) return AccessDenied;
                try
                {
                    using var fs = new FileStream(res.RealPath, FileMode.Open, System.IO.FileAccess.Write,
                        FileShare.ReadWrite | FileShare.Delete);
                    // .NET FileStream.SetLength 依赖当前位置：从文件尾截短时，
                    // 若当前位置不在目标位置，SetLength 只更新逻辑长度、宿主
                    // 磁盘长度不变（Dokan 卷实测 4096 残留）。先 Seek(0) 使
                    // 截断按从头计算，Flush 落盘后宿主长度才真正更新。
                    fs.Seek(0, SeekOrigin.Begin);
                    fs.SetLength(length);
                    fs.Flush(flushToDisk: true);
                }
                catch (Exception ex)
                {
                    Log.Warn("[FS] SetEndOfFile 独立句柄截断失败 {0}: {1} ({2})", Normalize(fileName), ex.Message,
                        unchecked((uint)ex.HResult).ToString("X8"));
                    throw;
                }
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

    public NtStatus LockFile(string fileName, long offset, long length, IDokanFileInfo info)
    {
        var cx = GetCtx(info);
        if (cx is null || (cx.Stream is null && !EnsureStream(cx))) return AccessDenied;
        try
        {
            lock (cx.Gate) { cx.Stream!.Lock(offset, length); }
            return Success;
        }
        catch (Exception ex)
        {
            Log.Warn("[FS] LockFile {0} [{1}+{2}]: {3}", fileName, offset, length, ex.Message);
            return AccessDenied;
        }
    }

    public NtStatus UnlockFile(string fileName, long offset, long length, IDokanFileInfo info)
    {
        var cx = GetCtx(info);
        if (cx is null || (cx.Stream is null && !EnsureStream(cx))) return AccessDenied;
        try
        {
            lock (cx.Gate) { cx.Stream!.Unlock(offset, length); }
            return Success;
        }
        catch (Exception ex)
        {
            Log.Warn("[FS] UnlockFile {0} [{1}+{2}]: {3}", fileName, offset, length, ex.Message);
            return AccessDenied;
        }
    }

    // -- 卷信息 ---------------------------------------------------------------

    public NtStatus GetDiskFreeSpace(out long freeBytesAvailable, out long totalNumberOfBytes,
        out long totalNumberOfFreeBytes, IDokanFileInfo info)
    {
        if (Log.VerboseEnabled) Log.Debug("[ENTRY] DiskFree");
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

    // -- 目录缓存一致性 --------------------------------------------------------
    // MirrorFs 直接在宿主侧增删文件，Dokan 驱动的目录枚举缓存并不知情，
    // 重新枚举可能拿到过期列表（go 的 RemoveAll 因此删不到枚举之后新建的
    // 文件，报 ENOTEMPTY）。挂载后 Runner 注入 DokanInstance，凡回调里做了
    // 宿主侧变更，就通过 Dokan.Notify.* 让驱动同步缓存。
    //
    // 关键约束：Notify 本身是一次阻塞的控制设备 IRP。在 Dokan 分发线程内同步
    // 发起时，高并发负载（jest worker 风暴）下全部分发线程可能同时卡在
    // Notify 上 → 卷整体死锁、sandbox.exe 卡在内核不可终止（26220 实测）。
    // 因此 Notify 必须异步投递：专用后台线程消费有界队列；队列满则丢弃
    // （缓存陈旧是可恢复的代价，卷死锁不是）。

    private DokanInstance? _notifyInstance;
    private System.Collections.Concurrent.BlockingCollection<Action>? _notifyQueue;
    private int _notifyWorkerStarted;

    /// <summary>挂载完成后由 Runner 调用，启用 Dokan 目录缓存通知。</summary>
    public void AttachNotify(DokanInstance instance)
    {
        _notifyInstance = instance;
        _notifyQueue = new System.Collections.Concurrent.BlockingCollection<Action>(
            new System.Collections.Concurrent.ConcurrentQueue<Action>(), boundedCapacity: 1024);
        if (Interlocked.Exchange(ref _notifyWorkerStarted, 1) == 0)
        {
            var worker = new Thread(NotifyWorkerLoop)
            {
                IsBackground = true,
                Name = "dynobox-notify",
            };
            worker.Start();
        }
    }

    private void NotifyWorkerLoop()
    {
        // 进程生命周期内常驻；Unmount 后 _notifyInstance 为 null，排队项
        // 直接走 catch 分支丢弃。
        foreach (var notify in _notifyQueue!.GetConsumingEnumerable())
        {
            try { notify(); }
            catch (Exception ex) { Log.Debug("[FS] Notify 投递失败: {0}", ex.Message); }
        }
    }

    private string? VirtualFullPath(string fileName) =>
        MountedPoint is { } mount ? mount + fileName : null;

    private void QueueNotify(Action notify)
    {
        // 未挂载 / 队列未初始化 / 已满：直接丢弃（fail-open，只损失缓存一致性）
        try { _notifyQueue?.TryAdd(notify); } catch (Exception) { /* 已关闭则丢弃 */ }
    }

    private void NotifyCreate(string fileName, bool isDirectory)
    {
        if (_notifyInstance is not { } instance) return;
        if (VirtualFullPath(fileName) is not { } path) return;
        QueueNotify(() =>
        {
            try { Dokan.Notify.Create(instance, path, isDirectory); }
            catch (Exception ex) { Log.Debug("[FS] Notify.Create 失败 {0}: {1}", path, ex.Message); }
        });
    }

    private void NotifyDelete(string fileName, bool isDirectory)
    {
        if (_notifyInstance is not { } instance) return;
        if (VirtualFullPath(fileName) is not { } path) return;
        QueueNotify(() =>
        {
            try { Dokan.Notify.Delete(instance, path, isDirectory); }
            catch (Exception ex) { Log.Debug("[FS] Notify.Delete 失败 {0}: {1}", path, ex.Message); }
        });
    }

    private void NotifyRename(string oldFileName, string newFileName, bool isDirectory)
    {
        if (_notifyInstance is not { } instance) return;
        if (VirtualFullPath(oldFileName) is not { } oldPath
            || VirtualFullPath(newFileName) is not { } newPath) return;
        QueueNotify(() =>
        {
            try { Dokan.Notify.Rename(instance, oldPath, newPath, isDirectory, false); }
            catch (Exception ex) { Log.Debug("[FS] Notify.Rename 失败 {0}: {1}", newPath, ex.Message); }
        });
    }


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
