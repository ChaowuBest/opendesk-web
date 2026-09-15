/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;

namespace OpenDesk.Bootstrapper
{
    /// <summary>
    /// 覆盖安装时由 bundle 内的 ExePackage（CleanupRelatedBundles）在 OpenDeskMsi 安装之后、
    /// burn 引擎启动 related bundle 子进程之前执行（此时运行在提权引擎内，无需再弹 UAC）。
    ///
    /// 引擎对 related bundle 的卸载固定以 "&lt;旧缓存 exe&gt; -uninstall -quiet ..." 启动旧版
    /// 安装器并无限等待其退出；而 0.3.5 及更早版本的 BA 在静默模式下存在 apply 完成后进程
    /// 不退出的缺陷，会让整个覆盖安装永远卡住（或在旧版非静默时弹出用户看不见的卸载窗口）。
    /// 本程序改为主动静默卸载旧版本 bundle 并兜底强杀，保证引擎随后启动 related child 时
    /// 旧缓存 exe 已不存在：child 启动失败但 related bundle 是非 vital 包，引擎会记录
    /// "Continuing (non-vital package)" 并继续完成安装。
    ///
    /// 用法：CleanupRelatedBundles.exe [当前 bundle 版本] [当前 bundle ID]，例如
    /// "0.3.6.0 {7092ef85-a098-4405-a520-1a1e04babddb}"。
    /// 只处理 DisplayVersion 低于当前版本的 OpenDesk bundle；同版本/更高版本条目
    /// （包括本安装自身的会话条目）与共享 MSI ProductCode 相关，一律不碰。
    /// 任何异常都以 0 退出：本程序失败绝不能阻断安装。
    /// </summary>
    internal static class CleanupProgram
    {
        private const string UninstallKeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
        private const string BundleUpgradeCode = "e7b412c3-02cc-4ed8-9fcb-5d33fe3390e4";
        private const string LogFileName = "OpenDeskCleanup.log";
        private const int EntryRemovalTimeoutMs = 120000;
        private const int CacheRemovalTimeoutMs = 15000;
        private const int PollIntervalMs = 500;

        private static readonly object LogLock = new object();

        private static int Main(string[] args)
        {
            try
            {
                Log("cleanup started, args: " + string.Join(" ", args));

                uint[] currentVersion;
                if (args.Length < 2 || !TryParseVersion(args[0], out currentVersion))
                {
                    Log("no usable version argument, nothing to do");
                    return 0;
                }

                string currentBundleId = args[1];
                if (string.IsNullOrWhiteSpace(currentBundleId))
                {
                    Log("no current bundle id, nothing to do");
                    return 0;
                }

                CleanupOldBundles(currentVersion, currentBundleId);
            }
            catch (Exception ex)
            {
                Log("unexpected error: " + ex);
            }

            Log("cleanup finished");
            return 0;
        }

        private static void CleanupOldBundles(uint[] currentVersion, string currentBundleId)
        {
            using (RegistryKey base64 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey base32 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32))
            {
                CleanupOldBundlesInView(base64, "64", currentVersion, currentBundleId);
                CleanupOldBundlesInView(base32, "32", currentVersion, currentBundleId);
            }
        }

        private static void CleanupOldBundlesInView(
            RegistryKey baseKey,
            string viewLabel,
            uint[] currentVersion,
            string currentBundleId
        )
        {
            using (RegistryKey uninstallKey = baseKey.OpenSubKey(UninstallKeyPath, false))
            {
                if (uninstallKey == null)
                {
                    return;
                }

                string[] entryNames = uninstallKey.GetSubKeyNames();
                for (int i = 0; i < entryNames.Length; i++)
                {
                    try
                    {
                        CleanupBundleEntry(baseKey, viewLabel, entryNames[i], currentVersion, currentBundleId);
                    }
                    catch (Exception ex)
                    {
                        Log("failed to clean entry " + entryNames[i] + ": " + ex.Message);
                    }
                }
            }
        }

        private static void CleanupBundleEntry(
            RegistryKey baseKey,
            string viewLabel,
            string entryName,
            uint[] currentVersion,
            string currentBundleId
        )
        {
            string cachePath = null;
            using (RegistryKey entryKey = baseKey.OpenSubKey(UninstallKeyPath + "\\" + entryName, false))
            {
                if (entryKey == null)
                {
                    return;
                }

                // BundleCachePath 值是 burn bundle 在应用列表（Uninstall 键）里的标志。
                cachePath = entryKey.GetValue("BundleCachePath") as string;
                if (string.IsNullOrEmpty(cachePath))
                {
                    return;
                }

                if (!IsOpenDeskBundle(entryKey))
                {
                    return;
                }

                string versionText = entryKey.GetValue("DisplayVersion") as string;
                uint[] entryVersion;
                if (!TryParseVersion(versionText, out entryVersion))
                {
                    Log("skip " + entryName + ": unreadable version");
                    return;
                }

                // 只处理更低版本。同版本条目（含本次安装自身的会话条目）与更高版本
                // 共享 MSI ProductCode，动了会导致修复安装卸掉在用的 MSI。
                if (CompareVersions(entryVersion, currentVersion) >= 0)
                {
                    return;
                }

                Log("found older OpenDesk bundle " + entryName + " version " + versionText +
                    " cache: " + cachePath + " (view " + viewLabel + ")");
            }

            CleanupBundle(entryName, cachePath, currentBundleId);
        }

        private static bool IsOpenDeskBundle(RegistryKey entryKey)
        {
            string[] upgradeCodes = entryKey.GetValue("BundleUpgradeCode") as string[];
            if (upgradeCodes != null)
            {
                for (int i = 0; i < upgradeCodes.Length; i++)
                {
                    if (string.Equals(upgradeCodes[i], BundleUpgradeCode, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }

            string displayName = entryKey.GetValue("DisplayName") as string;
            return displayName != null && displayName.Trim().StartsWith("OpenDesk", StringComparison.OrdinalIgnoreCase);
        }

        private static void CleanupBundle(string entryName, string cachePath, string currentBundleId)
        {
            // 上一次卡死的安装可能留下仍在运行的旧安装进程并锁住缓存 exe，
            // 必须先清掉，否则旧缓存删不掉、引擎的 related child 仍会被拉起挂死。
            KillProcessesUsingFile(cachePath);

            if (!File.Exists(cachePath))
            {
                Log("cached setup missing, removing orphan ARP entry " + entryName);
                TryDeleteEntry(entryName);
                return;
            }

            Process stub = LaunchCachedUninstall(cachePath, currentBundleId);
            if (!WaitForEntryRemoval(entryName, EntryRemovalTimeoutMs))
            {
                if (stub != null && !stub.HasExited)
                {
                    Log("old setup did not finish in time, killing process tree " + stub.Id);
                    KillProcessTree(stub.Id);
                }

                WaitForEntryRemoval(entryName, 5000);
                if (EntryExists(entryName))
                {
                    Log("ARP entry still present, removing registry key " + entryName);
                    TryDeleteEntry(entryName);
                }
            }

            if (stub != null)
            {
                if (!stub.HasExited)
                {
                    Log("killing leftover old setup process tree " + stub.Id);
                    KillProcessTree(stub.Id);
                }

                stub.Dispose();
            }

            // 缓存目录以 bundle 自身的 PackageId 命名，而 WiX v3 的 <Bundle> 不支持固定 Id、
            // 每次编译 PackageId 随机（见 bundle.wxs 顶部说明），各版本的缓存目录互不相同，
            // 因此整目录删除不会波及其他版本。前提约束：若将来固定了 Bundle Id，新旧版本会
            // 共享同一缓存目录，此处必须改为只删旧条目文件，否则会删掉正在运行的引擎
            // （当前安装）自己的载荷。
            string cacheDirectory = Path.GetDirectoryName(cachePath);
            if (!string.IsNullOrEmpty(cacheDirectory) && Directory.Exists(cacheDirectory))
            {
                WaitForDirectoryRemoval(cacheDirectory, CacheRemovalTimeoutMs);
                if (Directory.Exists(cacheDirectory))
                {
                    TryDeleteDirectory(cacheDirectory);
                }
            }

            Log("cleanup for bundle " + entryName + " done");
        }

        private static Process LaunchCachedUninstall(string cachePath, string currentBundleId)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = cachePath;
                // 保留升级关系并声明当前 bundle 为祖先。旧 BA 在规划 related bundle 时会跳过祖先，
                // 避免旧版本安装器反向卸载刚安装的当前版本。
                startInfo.Arguments =
                    "/uninstall /quiet -burn.related.upgrade -burn.ancestors=" + currentBundleId;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                return Process.Start(startInfo);
            }
            catch (Exception ex)
            {
                Log("failed to launch cached setup: " + ex.Message);
                return null;
            }
        }

        private static void KillProcessesUsingFile(string filePath)
        {
            Process[] processes = Process.GetProcesses();
            try
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    string imagePath = null;
                    try
                    {
                        imagePath = processes[i].MainModule == null ? null : processes[i].MainModule.FileName;
                    }
                    catch
                    {
                        // 部分系统进程/已退出进程不允许访问 MainModule，直接跳过。
                    }

                    if (!string.IsNullOrEmpty(imagePath) && string.Equals(imagePath, filePath, StringComparison.OrdinalIgnoreCase))
                    {
                        Log("killing stale setup process " + processes[i].Id + " (" + imagePath + ")");
                        KillProcessTree(processes[i].Id);
                    }
                }
            }
            finally
            {
                for (int i = 0; i < processes.Length; i++)
                {
                    processes[i].Dispose();
                }
            }
        }

        private static void KillProcessTree(int processId)
        {
            try
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = "taskkill.exe";
                startInfo.Arguments = "/PID " + processId + " /T /F";
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                using (Process taskkill = Process.Start(startInfo))
                {
                    if (taskkill != null && !taskkill.WaitForExit(10000))
                    {
                        taskkill.Kill();
                    }
                }
            }
            catch (Exception ex)
            {
                Log("failed to kill process tree " + processId + ": " + ex.Message);
            }
        }

        private static bool EntryExists(string entryName)
        {
            using (RegistryKey base64 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey base32 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32))
            {
                return EntryExistsInView(base64, entryName) || EntryExistsInView(base32, entryName);
            }
        }

        private static bool EntryExistsInView(RegistryKey baseKey, string entryName)
        {
            using (RegistryKey entryKey = baseKey.OpenSubKey(UninstallKeyPath + "\\" + entryName, false))
            {
                return entryKey != null;
            }
        }

        private static bool WaitForEntryRemoval(string entryName, int timeoutMs)
        {
            int waited = 0;
            while (EntryExists(entryName) && waited < timeoutMs)
            {
                Thread.Sleep(PollIntervalMs);
                waited += PollIntervalMs;
            }

            return !EntryExists(entryName);
        }

        private static void TryDeleteEntry(string entryName)
        {
            using (RegistryKey base64 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey base32 = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32))
            {
                TryDeleteEntryInView(base64, "64", entryName);
                TryDeleteEntryInView(base32, "32", entryName);
            }
        }

        private static void TryDeleteEntryInView(RegistryKey baseKey, string viewLabel, string entryName)
        {
            try
            {
                if (!EntryExistsInView(baseKey, entryName))
                {
                    return;
                }

                using (RegistryKey uninstallKey = baseKey.OpenSubKey(UninstallKeyPath, true))
                {
                    if (uninstallKey != null)
                    {
                        uninstallKey.DeleteSubKeyTree(entryName, false);
                        Log("removed registry key " + entryName + " (view " + viewLabel + ")");
                    }
                }
            }
            catch (Exception ex)
            {
                Log("failed to remove registry key " + entryName + " (view " + viewLabel + "): " + ex.Message);
            }
        }

        private static void WaitForDirectoryRemoval(string directoryPath, int timeoutMs)
        {
            int waited = 0;
            while (Directory.Exists(directoryPath) && waited < timeoutMs)
            {
                Thread.Sleep(PollIntervalMs);
                waited += PollIntervalMs;
            }
        }

        private static void TryDeleteDirectory(string directoryPath)
        {
            for (int attempt = 0; attempt < 3 && Directory.Exists(directoryPath); attempt++)
            {
                try
                {
                    Directory.Delete(directoryPath, true);
                    Log("removed cache directory " + directoryPath);
                }
                catch (Exception ex)
                {
                    Log("failed to remove cache directory: " + ex.Message);
                    Thread.Sleep(1000);
                }
            }
        }

        private static bool TryParseVersion(string text, out uint[] version)
        {
            version = new uint[4];
            if (string.IsNullOrEmpty(text))
            {
                return false;
            }

            string[] parts = text.Split('.');
            if (parts.Length < 1 || parts.Length > 4)
            {
                return false;
            }

            for (int i = 0; i < parts.Length; i++)
            {
                uint value;
                if (!uint.TryParse(parts[i].Trim(), out value))
                {
                    return false;
                }

                version[i] = value;
            }

            return true;
        }

        private static int CompareVersions(uint[] left, uint[] right)
        {
            for (int i = 0; i < 4; i++)
            {
                if (left[i] < right[i])
                {
                    return -1;
                }

                if (left[i] > right[i])
                {
                    return 1;
                }
            }

            return 0;
        }

        private static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    string line = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}", DateTime.Now, message);
                    File.AppendAllText(Path.Combine(Path.GetTempPath(), LogFileName), line + Environment.NewLine);
                }
            }
            catch
            {
                // 日志失败不能影响清理流程。
            }
        }
    }
}
