/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.Diagnostics;
using System.Security.AccessControl;
using DokanNet;
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

    private sealed class Ctx
    {
        public FileStream? Stream;
        public readonly object Gate = new();
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
    }

    private static readonly char Sep = Path.DirectorySeparatorChar;

    /// <summary>单源模式返回镜像源；多根模式为空串。</summary>
    public string Src =>
        _roots.Count == 1 && _roots[0].Prefix == "/" ? _roots[0].RealRoot : "";

    /// <summary>暴露根映射供启动期路径翻译（prefix / realTrim）。</summary>
    public IReadOnlyList<(string Prefix, string RealTrim)> RootMaps =>
        _roots.Select(r => (r.Prefix, r.RealTrim)).ToList();

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

    private Resolved Resolve(string name)
    {
        var vpath = Normalize(name);
        var best = FindMapping(vpath) ?? throw new UnauthorizedAccessException($"未映射的路径: {name}");
        if (best.Prefix == "/")
        {
            var rel = vpath[1..].Replace('/', Sep);
            var real = rel.Length == 0 ? best.RealRoot : Path.GetFullPath(Path.Combine(best.RealRoot, rel));
            GuardWithin(real, best);
            return new Resolved { RealPath = real };
        }
        if (vpath.Equals(best.Prefix, StringComparison.OrdinalIgnoreCase))
            return new Resolved { RealPath = best.RealRoot };
        var rest = vpath[(best.Prefix.Length + 1)..].Replace('/', Sep);
        var rp = Path.GetFullPath(Path.Combine(best.RealRoot, rest));
        GuardWithin(rp, best);
        return new Resolved { RealPath = rp };
    }

    private static void GuardWithin(string real, RootMap map)
    {
        if (!real.Equals(map.RealTrim, StringComparison.OrdinalIgnoreCase) &&
            !real.StartsWith(map.RealTrim + Sep, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"路径越界: {real}");
    }

    private static string Normalize(string name) => "/" + name.Replace('\\', '/').TrimStart('/');

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
                var vpath = Normalize(fileName);
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

                if (!Check(vpath, kinds, info)) return AccessDenied;

                if (isDirReq)
                {
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
                    info.IsDirectory = true;
                    info.Context = NewCtx(null);
                    return Success;
                }

                if (mode == FileMode.CreateNew && exists) return FileExists;
                if (mode is FileMode.Open or FileMode.Truncate && !exists) return FileNotFound;

                try
                {
                    var stream = new FileStream(real, mode,
                        kinds.Contains(AccessKind.Write) ? System.IO.FileAccess.ReadWrite : System.IO.FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete,
                        64 * 1024, FileOptions.None);
                    info.Context = NewCtx(stream);
                }
                catch (FileNotFoundException) { return FileNotFound; }
                catch (DirectoryNotFoundException) { return PathNotFound; }
                catch (UnauthorizedAccessException) { return AccessDenied; }
                catch (IOException ex) when ((uint)ex.HResult == 0x80070020u) { return SharingViolation; }
                catch (IOException ex) { Log.Warn("[FS] 打开失败 {0}: {1}", vpath, ex.Message); return AccessDenied; }
                return Success;
            }
        }
        catch (Exception ex)
        {
            Log.Error("ZwCreateFile 内部异常: {0}", ex);
            return AccessDenied;
        }
    }

    private Ctx NewCtx(FileStream? stream)
    {
        var cx = new Ctx { Stream = stream };
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
                cx.Stream.Seek(info.WriteToEndOfFile ? 0 : offset,
                    info.WriteToEndOfFile ? SeekOrigin.End : SeekOrigin.Begin);
                cx.Stream.Write(buffer, 0, buffer.Length);
                cx.Stream.Flush(flushToDisk: false);
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
            if (IsSyntheticContainer(Normalize(fileName)))
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
                Length = fi.Length,
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
            var vpath = Normalize(fileName);

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
            if (creationTime.HasValue) File.SetCreationTime(real, creationTime.Value);
            if (lastAccessTime.HasValue) File.SetLastAccessTime(real, lastAccessTime.Value);
            if (lastWriteTime.HasValue) File.SetLastWriteTime(real, lastWriteTime.Value);
            return Success;
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
            var (allowed, _) = _policy.Check(Normalize(fileName), AccessKind.Write);
            return allowed ? Success : AccessDenied;
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
            var (allowed, _) = _policy.Check(Normalize(fileName), AccessKind.Write);
            if (!allowed) return AccessDenied;
            if (Directory.EnumerateFileSystemEntries(real).Any()) return DirectoryNotEmpty;
            return Success;
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
                var oldVp = Normalize(oldName);
                var newVp = Normalize(newName);
                var oldReal = Resolve(oldName).RealPath;
                var newReal = Resolve(newName).RealPath;
                if (!Check(oldVp, new[] { AccessKind.Write }, info) ||
                    !Check(newVp, new[] { AccessKind.Write }, info))
                    return AccessDenied;

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
                using var fs = new FileStream(Resolve(fileName).RealPath, FileMode.Open, System.IO.FileAccess.Write);
                fs.SetLength(length);
            }
            return Success;
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
            var di = new DriveInfo(_roots[0].RealRoot != "" ? _roots[0].RealRoot : _roots[0].RealTrim);
            freeBytesAvailable = di.AvailableFreeSpace;
            totalNumberOfBytes = di.TotalSize;
            totalNumberOfFreeBytes = di.AvailableFreeSpace;
            return Success;
        }
        catch (Exception ex)
        {
            Log.Error("GetDiskFreeSpace 内部异常: {0}", ex);
            freeBytesAvailable = totalNumberOfBytes = totalNumberOfFreeBytes = 0;
            return AccessDenied;
        }
    }

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
