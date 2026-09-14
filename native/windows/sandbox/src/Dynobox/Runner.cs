/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.Diagnostics;
using System.ComponentModel;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using DokanNet;

namespace Dynobox;

/// <summary>沙箱运行器：挂载 -> 拉起子进程（Job 容器）-> 等待 -> 卸载。</summary>
public sealed class Sandbox : IDisposable
{
    private DokanInstance? _instance;
    private readonly Dokan _dokan = new(new DokanNet.Logging.NullLogger());
    private IntPtr _job = IntPtr.Zero;
    private string? _bootstrapDir;
    private MountLease? _mountLease;
    private readonly Dictionary<string, string> _bootstrapExecutables = new(StringComparer.OrdinalIgnoreCase);

    public Sandbox(Policy policy, bool automount, string? letter = null)
    {
        Policy = policy;
        Security = new SandboxSecurity();
        // Fail closed if the host cannot create the AppContainer identity. The
        // child must never fall back to the manager's unrestricted token.
        Security.PrepareAppContainer();

        var roots = new List<(string Virtual, string Real)>();
        foreach (var r in policy.Roots)
        {
            if (automount && r.Virtual == "/")
                throw new ArgumentException(
                    "--automount 与映射到卷根 / 的 [[roots]] 冲突（/ 会吞掉所有盘符）");
            roots.Add((r.Virtual, r.Real));
        }
        if (automount)
        {
            // 枚举全部本机盘符（本地盘、可移动盘、映射的网络驱动器），
            // 以盘符名为虚拟目录挂进卷根：C:\ -> /C、E:\ -> /E ...
            var declared = new HashSet<string>(
                roots.Select(r => r.Virtual.TrimStart('/')), StringComparer.OrdinalIgnoreCase);
            foreach (var d in DriveInfo.GetDrives())
            {
                if (d.Name.Length < 3 || d.Name[1] != ':') continue;
                var driveLetter = char.ToUpperInvariant(d.Name[0]);
                // 其他运行实例的虚拟卷不能再次镜像，否则会串接其权限端点和生命周期。
                if (MountLease.IsReserved(driveLetter)) continue;
                if (!d.IsReady)
                {
                    Log.Info("[AUTOMOUNT] 跳过未就绪的驱动器 {0}:", driveLetter);
                    continue;
                }
                if (!declared.Add(driveLetter.ToString()))
                    continue;   // 用户已在 [[roots]] 里手动声明，不覆盖
                roots.Add(("/" + driveLetter, driveLetter + ":\\"));
                Log.Info("[AUTOMOUNT] {0}: -> /{1} ({2})", driveLetter, driveLetter, d.DriveType);
            }
        }

        // 子进程引导区：存放 AppContainer 无法从宿主原生目录读取的 exe 副本
        _bootstrapDir = Path.Combine(Path.GetTempPath(), "dynobox-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(_bootstrapDir);
        roots.Add(("/dynobox", _bootstrapDir));

        Fs = new MirrorFs(roots, policy);
        _mountLease = MountLease.Acquire(letter);
        Letter = _mountLease.Letter;
        MountPoint = Letter + ":";
        // 排除挂载盘符自身，避免 Y:\ -> /Y -> Y:\ 的自引用循环
        roots.RemoveAll(r => r.Virtual.Equals("/" + Letter, StringComparison.OrdinalIgnoreCase));
        Fs.RebuildRoots(roots);
    }

    public string Src => Fs.Src;
    public Policy Policy { get; }
    public MirrorFs Fs { get; }
    public SandboxSecurity Security { get; }
    public string Letter { get; }
    public string MountPoint { get; }

    /// <summary>启动期路径映射（旧前缀 -> 新前缀），作用于子进程命令行与环境变量。</summary>
    public List<(string From, string To)> PathMaps { get; } = new();

    public static string PickFreeLetter()
    {
        var drives = DriveInfo.GetDrives().Select(d => d.Name[0]).ToHashSet();
        for (var c = 'Z'; c >= 'C'; c--)
            if (!drives.Contains(c))
                return c.ToString();
        throw new InvalidOperationException("没有空闲盘符");
    }

    public void Mount(int waitTimeoutMs = 15_000)
    {
        var instance = new DokanInstanceBuilder(_dokan)
            .ConfigureOptions(o =>
            {
                o.MountPoint = MountPoint;
                o.Options = DokanOptions.MountManager | DokanOptions.CurrentSession;
                o.TimeOut = TimeSpan.FromSeconds(30);
                o.AllocationUnitSize = 4096;
                o.SectorSize = 512;
                // Dokan applies this descriptor to the mounted volume itself,
                // allowing the AppContainer child to traverse the virtual disk.
                o.VolumeSecurityDescriptor = Security.CreateVolumeSecurityDescriptor();
                o.VolumeSecurityDescriptorLength = Security.VolumeSecurityDescriptorLength;
            })
            .Build(Fs);

        _instance = instance;
        Security.HideDriveLetter(Letter[0]);
        var deadline = DateTime.UtcNow.AddMilliseconds(waitTimeoutMs);
        var i = 0;
        while (DateTime.UtcNow < deadline)
        {
            i++;
            var viaDir = Directory.Exists(MountPoint + Path.DirectorySeparatorChar);
            var viaInfo = new DirectoryInfo(MountPoint + Path.DirectorySeparatorChar).Exists;
            if (viaDir && viaInfo && IsRunning &&
                string.Equals(Fs.MountedPoint?.TrimEnd('\\', '/'), MountPoint, StringComparison.OrdinalIgnoreCase))
            {
                Log.Info("[RUN] 沙箱卷就绪: {0}\\  (镜像自 {1}) [polls={2}]", Letter, Src, i);
                return;
            }
            Log.Info("[RUN] 等待卷就绪... poll={0} viaDir={1} viaInfo={2}", i, viaDir, viaInfo);
            Thread.Sleep(100);
        }
        throw new TimeoutException("挂载超时：卷未就绪");
    }

    public void Unmount()
    {
        if (_instance is null) return;
        try
        {
            _instance.Dispose();
            Log.Info("[RUN] 已卸载 {0}:", Letter);
        }
        finally
        {
            _instance = null;
            Security.RestoreDriveLetters();
        }
    }

    public bool IsRunning => _instance?.IsFileSystemRunning() ?? false;

    public int Run(string cmdline, IDictionary<string, string>? envExtra = null)
    {
        // 用 Mounted 回调回报的实际挂载点（MountManager 可能改派盘符）
        var actual = (Fs.MountedPoint ?? MountPoint).TrimEnd('\\', '/');

        var envVars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables())
            envVars[(string)e.Key!] = (string)e.Value!;
        envVars["SBX_ROOT"] = actual + "\\";
        envVars["SBX_REAL_SRC"] = Src;
        envVars["DYNOBOX_SANDBOX"] = "1";
        if (envExtra is not null)
            foreach (var (k, v) in envExtra)
                envVars[k] = v;

        // 某些运行时会使用宿主命名对象命名空间创建子进程通信管道。
        // 先由统一兼容层准备私有可执行文件，再做盘符映射；这样子进程
        // 及其后代继承同一套 AppContainer 可见的命名对象语义。
        cmdline = BootstrapExecutable(cmdline);

        // 多根模式：按声明的映射根自动翻译（C:\ -> Z:\C\ 等），
        // 使子进程命令行/环境变量中的绝对路径指向沙箱视图
        var maps = new List<(string From, string To)>(PathMaps);
        foreach (var root in Fs.RootMaps)
        {
            if (root.Prefix == "/") continue;
            var target = actual + root.Prefix.Replace('/', '\\');   // Z:\C
            var real = root.RealTrim;                                   // C:
            maps.Add((real + "\\", target + "\\"));
            maps.Add((real + "/", target + "\\"));
            maps.Add((real, target));
        }
        if (maps.Count > 0)
        {
            // 长前缀优先，避免 C: 抢先命中 C:\ 的前缀
            maps.Sort((a, b) => b.From.Length.CompareTo(a.From.Length));
            cmdline = ReplaceLiteralAll(cmdline, maps);
            foreach (var k in envVars.Keys.ToList())
            {
                // These describe the Windows installation, not user data paths.
                // .NET Framework requires a drive designator in SystemDrive and
                // native system paths during initialization and shutdown.
                if (k.Equals("SystemDrive", StringComparison.OrdinalIgnoreCase) ||
                    k.Equals("SystemRoot", StringComparison.OrdinalIgnoreCase) ||
                    k.Equals("windir", StringComparison.OrdinalIgnoreCase)) continue;
                if (k.Equals("PSModulePath", StringComparison.OrdinalIgnoreCase))
                {
                    // Windows PowerShell 的内置模块由系统 ACL/GAC 提供。将其原生路径
                    // 改为虚拟卷路径会触发额外的授权管理器检查，AppContainer 无权读取其注册表。
                    var systemModules = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                        @"System32\WindowsPowerShell\v1.0\Modules");
                    envVars[k] = string.Join(';', envVars[k].Split(';').Select(entry =>
                        entry.Replace('/', '\\').TrimEnd('\\').Equals(systemModules, StringComparison.OrdinalIgnoreCase)
                            ? entry : ReplaceLiteralAll(entry, maps)));
                }
                else envVars[k] = ReplaceLiteralAll(envVars[k], maps);
            }
        }



        // 使用 per-run AppContainer primary token 启动。这个 token 没有普通
        // 用户文件系统权限；只有 Dokan 卷的安全描述符显式授予它访问权。
        var envBytes = Encoding.Unicode.GetBytes(
            string.Join("\0", envVars.Select(kv => $"{kv.Key}={kv.Value}")) + "\0\0");
        var envBlock = Marshal.AllocHGlobal(envBytes.Length);
        Marshal.Copy(envBytes, 0, envBlock, envBytes.Length);

        Log.Info("[RUN] 拉起子进程: {0} (cwd={1}\\)", cmdline, actual);
        var si = new STARTUPINFOW();
        // STARTUPINFO.cb must include the trailing attribute-list pointer when
        // EXTENDED_STARTUPINFO_PRESENT is used.
        si.cb = (uint)Marshal.SizeOf<STARTUPINFOEXW>();
        var cmd = new StringBuilder(cmdline);
        var baseToken = Security.OpenBaseToken();
        try
        {
            return Security.WithPackageSid(packageSid =>
            {
                var attrBytes = IntPtr.Zero;
                var handleList = IntPtr.Zero;
                var stdinHandle = IntPtr.Zero;
                AnonymousPipeServerStream? stdoutPipe = null;
                AnonymousPipeServerStream? stderrPipe = null;
                Task? stdoutRelay = null;
                Task? stderrRelay = null;
                try
                {
                    // Keep stdin inherited, but relay stdout/stderr through the
                    // sandbox process. This keeps sandbox-specific compatibility
                    // diagnostics out of OpenDesk's generic shell layer while
                    // preserving the child's actual stdout/stderr streams.
                    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10), GetCurrentProcess(),
                            out stdinHandle, 0, true, 2 /* DUPLICATE_SAME_ACCESS */))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Duplicate standard input failed");
                    stdoutPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
                    stderrPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
                    var childHandles = new[]
                    {
                        stdinHandle,
                        stdoutPipe.ClientSafePipeHandle.DangerousGetHandle(),
                        stderrPipe.ClientSafePipeHandle.DangerousGetHandle()
                    };
                    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
                    si.hStdInput = childHandles[0];
                    si.hStdOutput = childHandles[1];
                    si.hStdError = childHandles[2];
                    handleList = Marshal.AllocHGlobal(IntPtr.Size * childHandles.Length);
                    Marshal.Copy(childHandles, 0, handleList, childHandles.Length);
                    nuint attrSize = 0;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attrSize);
                    attrBytes = Marshal.AllocHGlobal(checked((int)attrSize));
                    if (!InitializeProcThreadAttributeList(attrBytes, 2, 0, ref attrSize))
                        throw new Win32Exception(Marshal.GetLastWin32Error(),
                            "InitializeProcThreadAttributeList 失败");

                    var caps = new SECURITY_CAPABILITIES
                    {
                        AppContainerSid = packageSid,
                        Capabilities = IntPtr.Zero,
                        CapabilityCount = 0,
                        Reserved = 0,
                    };
                    if (!UpdateProcThreadAttribute(attrBytes, 0,
                            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, ref caps,
                            (nuint)Marshal.SizeOf<SECURITY_CAPABILITIES>(), IntPtr.Zero, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute 失败");

                    if (!UpdateProcThreadAttribute(attrBytes, 0, new IntPtr(0x20002), handleList,
                            (nuint)(IntPtr.Size * childHandles.Length), IntPtr.Zero, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Set inherited stream handles failed");

                    var siex = new STARTUPINFOEXW
                    {
                        StartupInfo = si,
                        lpAttributeList = attrBytes,
                    };
                    if (!CreateProcessAsUserW(baseToken, null, cmd, IntPtr.Zero, IntPtr.Zero,
                            true, CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                            envBlock, actual + "\\", ref siex, out var pi))
                    {
                        var err = Marshal.GetLastWin32Error();
                        throw new InvalidOperationException(
                            $"AppContainer 子进程启动失败: WinError {err}");
                    }
                    // The child inherited its own copies. Close the manager's
                    // client ends so EOF reaches the relay tasks on child exit.
                    stdoutPipe.DisposeLocalCopyOfClientHandle();
                    stderrPipe.DisposeLocalCopyOfClientHandle();
                    CloseHandle(stdinHandle);
                    stdinHandle = IntPtr.Zero;
                    try
                    {
                        // Assign before the first instruction so cancellation cannot
                        // leave a child outside the job or holding the pipes open.
                        AssignToJob(pi.hProcess);
                        if (ResumeThread(pi.hThread) == uint.MaxValue)
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume child failed");
                        stdoutRelay = RelayOutputAsync(stdoutPipe, Console.OpenStandardOutput(), filterPythonWarning: false);
                        stderrRelay = RelayOutputAsync(stderrPipe, Console.OpenStandardError(), filterPythonWarning: true);
                        _ = WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
                        stdoutRelay.GetAwaiter().GetResult();
                        stderrRelay.GetAwaiter().GetResult();
                        if (!GetExitCodeProcess(pi.hProcess, out var code))
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "Read child exit code failed");
                        return unchecked((int)code);
                    }
                    catch
                    {
                        TerminateProcess(pi.hProcess, 1);
                        throw;
                    }
                    finally
                    {
                        CloseHandle(pi.hProcess);
                        CloseHandle(pi.hThread);
                    }
                }
                finally
                {
                    if (attrBytes != IntPtr.Zero)
                    {
                        DeleteProcThreadAttributeList(attrBytes);
                        Marshal.FreeHGlobal(attrBytes);
                    }
                    if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                    if (stdinHandle != IntPtr.Zero) CloseHandle(stdinHandle);
                    stdoutPipe?.DisposeLocalCopyOfClientHandle();
                    stderrPipe?.DisposeLocalCopyOfClientHandle();
                    stdoutPipe?.Dispose();
                    stderrPipe?.Dispose();
                }
            });
        }
        finally
        {
            Marshal.FreeHGlobal(envBlock);
            CloseHandle(baseToken);
        }
    }

    private static async Task RelayOutputAsync(Stream source, Stream target, bool filterPythonWarning)
    {
        try
        {
            var buffer = new byte[16 * 1024];
            if (!filterPythonWarning)
            {
                int count;
                while ((count = await source.ReadAsync(buffer)) > 0)
                    await target.WriteAsync(buffer.AsMemory(0, count));
                return;
            }

            using var pending = new MemoryStream();
            int read;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                pending.Write(buffer, 0, read);
                var bytes = pending.GetBuffer();
                var length = checked((int)pending.Length);
                var start = 0;
                for (var i = 0; i < length; i++)
                {
                    if (bytes[i] != (byte)'\n') continue;
                    var lineLength = i - start + 1;
                    if (!IsPythonVirtualPathWarning(bytes.AsSpan(start, lineLength)))
                        await target.WriteAsync(bytes.AsMemory(start, lineLength));
                    start = i + 1;
                }
                if (start > 0)
                {
                    var remaining = length - start;
                    if (remaining > 0) Buffer.BlockCopy(bytes, start, bytes, 0, remaining);
                    pending.SetLength(remaining);
                    pending.Position = remaining;
                }
            }
            if (pending.Length > 0 && !IsPythonVirtualPathWarning(pending.GetBuffer().AsSpan(0, checked((int)pending.Length))))
                await target.WriteAsync(pending.GetBuffer().AsMemory(0, checked((int)pending.Length)));
        }
        catch (IOException)
        {
            // OpenDesk may close its terminal pipe while the child is still
            // shutting down. The sandbox must still return the child's exit code.
        }
        catch (ObjectDisposedException)
        {
            // Same lifecycle race as above.
        }
    }

    private static bool IsPythonVirtualPathWarning(ReadOnlySpan<byte> line)
    {
        const string prefix = "Failed to find real location of ";
        if (line.Length < prefix.Length + 4) return false;
        for (var i = 0; i < prefix.Length; i++)
            if (line[i] != prefix[i]) return false;
        var drive = prefix.Length;
        return ((line[drive] >= (byte)'A' && line[drive] <= (byte)'Z') ||
                (line[drive] >= (byte)'a' && line[drive] <= (byte)'z')) &&
            line[drive + 1] == (byte)':' &&
            (line[drive + 2] == (byte)'\\' || line[drive + 2] == (byte)'/');
    }

    /// <summary>
    /// 受限子进程的 exe 引导：命令行第一个 token 是要执行的程序。
    ///   - 程序已在沙箱卷内 → 卷安全描述符已授予沙箱 SID，直接可用；
    ///   - Windows 系统目录中的程序 → 使用系统为 AppContainer 提供的基础 ACL；
    ///   - 其他宿主路径 → 需要兼容补丁时复制进引导区，否则保留安装目录的映射。
    /// </summary>
    private string BootstrapExecutable(string cmdline)
    {
        var (exe, rest) = SplitFirstToken(cmdline);
        if (exe.Length == 0) return cmdline;

        var direct = exe;
        if (!Path.IsPathRooted(direct) && !direct.Contains(':'))
            direct = FindOnPath(direct) ?? direct;

        // 情形 1：已在沙箱卷上
        if (direct.StartsWith(MountPoint + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            (_bootstrapDir is not null && direct.StartsWith(_bootstrapDir, StringComparison.OrdinalIgnoreCase)))
            return cmdline;

        // 情形 2：Windows 自带程序可由 AppContainer 的系统 ACL 读取。
        if (Path.IsPathRooted(direct) && File.Exists(direct))
        {
            var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows)
                .TrimEnd('\\');
            if (direct.StartsWith(windows + "\\", StringComparison.OrdinalIgnoreCase))
                return cmdline;
        }

        // 情形 3：裸名（如 python）→ PATH 搜索后授予
        var found = Path.IsPathRooted(direct) && File.Exists(direct)
            ? direct
            : FindOnPath(direct);
        if (found is null) return cmdline;   // 找不到就保持原样（子进程自己报错）
        // 其他宿主程序复制进卷内引导区，避免给 AppContainer 开放原生目录。
        if (_bootstrapExecutables.TryGetValue(found, out var cached))
            return cmdline.Replace(exe, cached, StringComparison.OrdinalIgnoreCase);
        var bootstrapName = Path.GetFileName(found);
        var volumeCopy = MountPoint + Path.DirectorySeparatorChar + "dynobox"
            + Path.DirectorySeparatorChar + "bin" + Path.DirectorySeparatorChar + bootstrapName;
        Directory.CreateDirectory(MountPoint + Path.DirectorySeparatorChar + "dynobox"
            + Path.DirectorySeparatorChar + "bin");
        if (!RuntimeCompatibility.PrepareExecutable(found, volumeCopy))
        {
            // 无需修改的程序保留相邻 DLL/运行时文件；例如 pwsh.exe 必须与 pwsh.dll 同目录。
            File.Delete(volumeCopy);
            return '"' + found + '"' + (rest.Length > 0 && !char.IsWhiteSpace(rest[0]) ? " " : "") + rest;
        }
        _bootstrapExecutables[found] = volumeCopy;
        Log.Info("[BOOT] {0} 已复制进卷内引导区", bootstrapName);
        return cmdline.Replace(exe, volumeCopy, StringComparison.OrdinalIgnoreCase);
    }


    private static (string Exe, string tail) SplitFirstToken(string cmdline)
    {
        cmdline = cmdline.TrimStart();
        if (cmdline.StartsWith('"'))
        {
            var end = cmdline.IndexOf('"', 1);
            return end < 0 ? (cmdline, "") : (cmdline[1..end], cmdline[(end + 1)..]);
        }
        var sp = cmdline.IndexOf(' ');
        return sp < 0 ? (cmdline, "") : (cmdline[..sp], cmdline[(sp + 1)..]);
    }

    private static string? FindOnPath(string name)
    {
        if (name.Contains(Path.DirectorySeparatorChar) || name.Contains(':')) return null;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim(), name);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
        }
        return null;
    }

    /// <summary>大小写不敏感地把命令行/环境变量中的旧路径前缀替换为沙箱内前缀
    /// （同时匹配正/反斜杠两种写法）。</summary>
    internal static string ApplyMaps(string text, IEnumerable<(string From, string To)> maps)
    {
        foreach (var (from, to) in maps)
        {
            if (string.IsNullOrEmpty(from)) continue;
            foreach (var variant in new[] { from, from.Replace('\\', '/'), from.Replace('/', '\\') })
            {
                if (variant.Length == 0) continue;
                var idx = 0;
                while (true)
                {
                    idx = text.IndexOf(variant, idx, StringComparison.OrdinalIgnoreCase);
                    if (idx < 0) break;
                    text = text[..idx] + to + text[(idx + variant.Length)..];
                    idx += to.Length;
                }
            }
        }
        return text;
    }

    private string ApplyMaps(string text) => ApplyMaps(text, PathMaps);

    /// <summary>按字面量（忽略大小写）做全量替换，无变体推导。</summary>
    internal static string ReplaceLiteralAll(
        string text, IEnumerable<(string From, string To)> maps)
    {
        foreach (var (from, to) in maps)
        {
            if (from.Length == 0) continue;
            var idx = 0;
            while (true)
            {
                idx = text.IndexOf(from, idx, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) break;
                text = text[..idx] + to + text[(idx + from.Length)..];
                idx += to.Length;
            }
        }
        return text;
    }

    /// <summary>子进程放入 Job：管理进程退出 -> 整树被杀；禁止 breakaway。</summary>
    private void AssignToJob(IntPtr hProcess)
    {
        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }
        var limit = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */,
                ref limit, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
        {
            var error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "SetInformationJobObject failed");
        }
        if (!AssignProcessToJobObject(job, hProcess))
        {
            var error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error, "AssignProcessToJobObject failed");
        }
        _job = job; // Job 随管理进程存活；进程退出或 Dispose 时杀掉整棵子进程树
    }

    public void Dispose()
    {
        if (_job != IntPtr.Zero)
        {
            CloseHandle(_job);
            _job = IntPtr.Zero;
        }
        try
        {
            Unmount();
            _dokan.Dispose();
            Security.Dispose();
        }
        finally
        {
            _mountLease?.Dispose();
            _mountLease = null;
        }
    }

    // ------------------------------------------------------------------
    // P/Invoke
    // ------------------------------------------------------------------

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    private const uint CREATE_SUSPENDED = 0x4;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES =
        new(0x20009);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW
    {
        public uint cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEXW
    {
        public STARTUPINFOW StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(
        IntPtr hToken,
        string? lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFOEXW lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList, uint attributeCount, uint flags, ref nuint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute, ref SECURITY_CAPABILITIES value,
        nuint size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value,
        nuint size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int id);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);


    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);


    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize;
        public nuint MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public nuint ProcessMemoryLimit;
        public nuint JobMemoryLimit;
        public nuint PeakProcessMemoryUsed;
        public nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpInfo, int cbInfo);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
}
