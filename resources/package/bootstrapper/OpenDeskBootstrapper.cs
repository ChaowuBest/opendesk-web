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
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Xml.Linq;
using Microsoft.Tools.WindowsInstallerXml.Bootstrapper;
using Microsoft.Win32;

[assembly: BootstrapperApplication(typeof(OpenDesk.Installer.OpenDeskBootstrapperApplication))]

namespace OpenDesk.Installer
{
    public sealed class OpenDeskBootstrapperApplication : BootstrapperApplication
    {
        private const string PackageId = "OpenDeskMsi";
        private const string CleanupRelatedBundlesPackageId = "CleanupRelatedBundles";
        private const int ErrorFailNoActionReboot = unchecked((int)0x8007015E);
        private InstallerForm form;
        private PackageState packageState = PackageState.Unknown;
        private LaunchAction activeAction = LaunchAction.Unknown;
        private bool relatedMsiUpgradeDetected;
        private readonly Dictionary<string, Version> relatedBundleVersions =
            new Dictionary<string, Version>(StringComparer.OrdinalIgnoreCase);
        private bool cancelRequested;
        private volatile bool elevationRequested;
        private int exitCode;
        private string lastError;
        private string activeInstallFolder;

        public OpenDeskBootstrapperApplication()
        {
            DetectRelatedBundle += OnDetectRelatedBundle;
            PlanRelatedBundle += OnPlanRelatedBundle;
            DetectRelatedMsiPackage += OnDetectRelatedMsiPackage;
            DetectPackageComplete += OnDetectPackageComplete;
            DetectComplete += OnDetectComplete;
            PlanComplete += OnPlanComplete;
            CacheAcquireBegin += delegate
            {
                Post(delegate
                {
                    form.SetProgressStatus("ProgressCaching", "ProgressRepairCaching", "ProgressUninstallPreparing");
                });
            };
            ExecutePackageBegin += OnExecutePackageBegin;
            ExecutePackageComplete += OnExecutePackageComplete;
            Progress += OnProgress;
            ExecuteProgress += OnExecuteProgress;
            Error += OnError;
            ApplyComplete += OnApplyComplete;
            Elevate += delegate
            {
                // 提权已发起。UAC 安全桌面期间抢前台注定失败，所以这里只置标志，
                // 由窗口侧的轮询在提权结束后把窗口抢回来。
                elevationRequested = true;
            };
            ApplyBegin += delegate
            {
                // Apply 阶段引擎会启动提权的 companion 进程，UAC 结束后本窗口会被压到后台。
                // 从这里开始看护窗口的前台状态：需要的是"失去前台后再抢回来"的持续观察，
                // 单个事件里做一次恢复赶不上系统压后台的时机。
                Post(delegate
                {
                    form.KeepVisibleThroughElevation();
                });
            };
        }

        /// <summary>
        /// 是否已经发起过提权。由引擎线程置位、UI 线程读取，故标记为 volatile。
        /// 窗口侧据此判断"现在失去前台"是否可能由 UAC 造成，避免在提权发生之前
        /// 就把用户主动切走的焦点抢回来。
        /// </summary>
        public bool ElevationRequested
        {
            get { return elevationRequested; }
        }

        protected override void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            form = new InstallerForm(this, new Localizer(GetPayloadPath("zh-cn.wxl")));
            form.Shown += delegate
            {
                if (RunsWithoutUserInteraction)
                {
                    form.Opacity = 0;
                    form.ShowInTaskbar = false;
                }

                Engine.Detect(form.Handle);
            };
            Application.Run(form);
            Engine.Quit(exitCode);
        }

        /// <summary>
        /// 本次运行是否不应展示交互界面。
        ///
        /// 除了显式的静默/嵌入式命令行，关键场景是 <c>Command.Relation != None</c>：
        /// 升级时 Burn 会启动旧版本自带的 Setup.exe 来卸载它，并把当前显示级别一并传下去。
        /// 旧版 BA 若仍按 Display.Full 弹出维护页等用户点"卸载"，这个窗口会落在主安装程序
        /// 后面，用户只看到进度条一直不动。作为 related bundle 被调起时必须全程静默自动执行。
        /// </summary>
        /// <summary>
        /// 是否应全程静默（供 InstallerForm 关闭逻辑复用）。
        /// </summary>
        public bool RunsWithoutUserInteraction
        {
            get
            {
                return Command.Display == Display.None ||
                    Command.Display == Display.Embedded ||
                    Command.Relation != RelationType.None;
            }
        }

        public string GetInstallFolder()
        {
            if (!string.IsNullOrEmpty(activeInstallFolder))
            {
                return activeInstallFolder;
            }

            string folder = Engine.FormatString(Engine.StringVariables["InstallFolder"]);
            return InstallerPath.ResolveInitialDirectory(folder, GetSavedInstallPathCustomized());
        }

        public bool GetSavedPreference(string name)
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = root.OpenSubKey("SOFTWARE\\OpenDesk\\Installer"))
                {
                    object value = key == null ? null : key.GetValue(name);
                    return value == null || Convert.ToInt32(value) != 0;
                }
            }
            catch
            {
                return true;
            }
        }

        public bool GetSavedInstallPathCustomized()
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = root.OpenSubKey("SOFTWARE\\OpenDesk\\Installer"))
                {
                    object value = key == null ? null : key.GetValue("InstallPathCustomized");
                    return value != null && Convert.ToInt32(value) != 0;
                }
            }
            catch
            {
                return false;
            }
        }

        public void Install(string folder, bool desktopShortcut, bool startMenuShortcut, bool installPathCustomized)
        {
            activeInstallFolder = InstallerPath.Normalize(folder);
            Engine.StringVariables["InstallFolder"] = activeInstallFolder;
            Engine.NumericVariables["CreateDesktopShortcut"] = desktopShortcut ? 1 : 0;
            Engine.NumericVariables["CreateStartMenuShortcut"] = startMenuShortcut ? 1 : 0;
            Engine.NumericVariables["InstallPathCustomized"] = installPathCustomized ? 1 : 0;
            StartAction(LaunchAction.Install);
        }

        /// <summary>
        /// 安装开始前对用户选择的目标盘做空间预检查（issue #288）。
        ///
        /// 背景：Windows Installer 的磁盘空间检查（OutOfDiskSpace）只针对本次安装的目标卷，
        /// 而安装过程还会在系统盘消耗额外空间（%TEMP% 提权工作目录、C:\ProgramData\Package Cache
        /// 中的 bundle/MSI 缓存）。旧版安装器没有任何预检查：C 盘剩余空间不足时，用户即使把安装
        /// 位置切到 D 盘，也会在复制文件阶段以"空间不足"失败，报错还可能指错盘符。
        ///
        /// 这里在用户点击"开始安装"时立即校验所选目录所在卷的剩余空间是否装得下安装内容
        /// （RequiredInstallSize，构建期由 staged 应用目录体积乘以安全系数注入），不足则弹窗提示并中止，
        /// 用户可以换盘重试，而不是等到复制一半才失败。
        /// </summary>
        public bool HasEnoughSpaceForInstall(string folder)
        {
            try
            {
                long required = GetRequiredInstallSize();
                long available = InstallerPath.GetAvailableFreeSpace(folder);
                // required 为 0 表示构建脚本未注入（异常场景），不做拦截交由 Windows Installer 兜底。
                if (required > 0 && available >= 0 && available < required)
                {
                    Engine.Log(
                        LogLevel.Error,
                        string.Format(
                            "OpenDesk: not enough disk space on target drive: required {0} bytes, available {1} bytes, folder: {2}",
                            required,
                            available,
                            folder
                        )
                    );
                    form.ShowInsufficientDiskSpace(required, available);
                    return false;
                }
            }
            catch (Exception exception)
            {
                // 预检查失败不阻断安装：读不到可用空间时交由 Windows Installer 的正式检查兜底。
                Engine.Log(LogLevel.Error, "OpenDesk: disk space pre-check failed: " + exception.Message);
            }
            return true;
        }

        private long GetRequiredInstallSize()
        {
            try
            {
                return Convert.ToInt64(Engine.NumericVariables["RequiredInstallSize"]);
            }
            catch
            {
                return 0;
            }
        }

        public void Repair()
        {
            StartAction(LaunchAction.Repair);
        }

        public void Uninstall()
        {
            StartAction(LaunchAction.Uninstall);
        }

        public void RequestCancel()
        {
            cancelRequested = true;
            Post(delegate
            {
                form.SetProgressStatus("ProgressCanceling", "ProgressRepairCanceling", "ProgressUninstallCanceling");
            });
        }

        public void LaunchInstalledApplication()
        {
            string executable = Path.Combine(GetInstallFolder(), "opendesk.exe");
            if (File.Exists(executable))
            {
                Process.Start(executable);
            }
        }

        private void StartAction(LaunchAction action)
        {
            if (!EnsureOpenDeskIsNotRunning())
            {
                return;
            }

            activeAction = action;
            cancelRequested = false;
            lastError = null;
            form.ShowProgress(action);
            // 清掉引擎无法接管的历史孤儿注册键（缓存丢失的 bundle、0.3.3 遗留的 *.msq、
            // 直接双击旧版 MSI 留下的可见展示键）。修复与升级一样要把应用列表清到只剩
            // 当前实例，能正常卸载的历史 bundle 由 OnPlanRelatedBundle 计划 Absent 交给引擎。
            if (action == LaunchAction.Install || action == LaunchAction.Repair)
            {
                CleanupStaleInstallations();
            }
            // 仅用户直接发起的卸载才忽略 MSI 依赖登记。作为 related bundle 被调起卸载时
            // （升级/修复中清理旧实例），共享的 MSI 往往仍被新安装依赖，必须让引擎正常
            // 做依赖检查、跳过 MSI 卸载、只注销自己的登记，否则会把新装的应用一并删掉。
            if (action == LaunchAction.Uninstall && Command.Relation == RelationType.None)
            {
                IgnorePackageDependencies();
            }
            Engine.Plan(action);
        }

        /// <summary>
        /// 卸载时忽略 MSI 包的 dependency provider 登记。
        ///
        /// MSI 包注册了 dependency provider，每个安装过的 bundle 都会在它下面登记为 dependent。
        /// 历史上重复安装留下的 bundle 条目仍挂在那里时，引擎卸载当前 bundle 会认为"包还被别人
        /// 依赖"，于是跳过 MSI 卸载、只注销自己的登记，并报告成功——用户看到"卸载瞬间完成，
        /// 但应用还在"。对应日志：w327 "Will not uninstall package ... found dependents"，
        /// 以及该包的 "execute: None"。
        ///
        /// 注意：引擎的 MSI 依赖检查读取的是经 bundle.wxs 中 MsiProperty 映射后的包属性
        /// IGNOREDEPENDENCIES（burn 的 GetIgnoredDependents 从包属性取值），仅设置 bundle
        /// 字符串变量不会生效，两处必须配套（见 bundle.wxs 的 MsiProperty 定义）。
        ///
        /// dependency provider 的用途是防止被多个产品共享的包被误删。OpenDesk 的 MSI 只被
        /// OpenDesk 自己的 bundle 引用，不存在共享，因此忽略登记是安全的：卸载 OpenDesk 就该
        /// 真正卸掉它的包。残留的历史 bundle 条目由 OnPlanRelatedBundle 一并计划 Absent 清理。
        /// </summary>
        private void IgnorePackageDependencies()
        {
            Engine.StringVariables["IGNOREDEPENDENCIES"] = "ALL";
        }

        private bool EnsureOpenDeskIsNotRunning()
        {
            string installFolder = GetInstallFolder();
            while (HasRunningOpenDeskProcess(installFolder))
            {
                if (RunsWithoutUserInteraction || Command.Display != Display.Full)
                {
                    exitCode = unchecked((int)0x80070643);
                    form.Close();
                    return false;
                }

                if (form.PromptForRunningOpenDesk(installFolder) != DialogResult.Retry)
                {
                    return false;
                }
            }

            return true;
        }

        private static bool HasRunningOpenDeskProcess(string installFolder)
        {
            Process[] processes = Process.GetProcessesByName("opendesk");
            try
            {
                foreach (Process process in processes)
                {
                    try
                    {
                        string runningExecutablePath = NativeMethods.GetProcessExecutablePath(process);
                        if (!process.HasExited && IsExecutableInsideInstallFolder(runningExecutablePath, installFolder))
                        {
                            return true;
                        }
                    }
                    catch
                    {
                    }
                }
            }
            finally
            {
                foreach (Process process in processes)
                {
                    process.Dispose();
                }
            }

            return false;
        }

        private static bool IsExecutableInsideInstallFolder(string executablePath, string installFolder)
        {
            if (string.IsNullOrWhiteSpace(executablePath) || string.IsNullOrWhiteSpace(installFolder))
            {
                return false;
            }

            string normalizedExecutablePath = Path.GetFullPath(executablePath);
            if (!string.Equals(Path.GetFileName(normalizedExecutablePath), "opendesk.exe", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            string normalizedInstallFolder = Path.GetFullPath(installFolder).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            ) + Path.DirectorySeparatorChar;
            return normalizedExecutablePath.StartsWith(normalizedInstallFolder, StringComparison.OrdinalIgnoreCase);
        }

        private void OnDetectPackageComplete(object sender, DetectPackageCompleteEventArgs e)
        {
            if (e.PackageId == PackageId)
            {
                packageState = e.State;
            }
        }

        private void OnDetectRelatedBundle(object sender, DetectRelatedBundleEventArgs e)
        {
            // 检测到任何历史 bundle（同 UpgradeCode 的其他安装）都视为"更新"，欢迎页展示更新文案。
            // 引擎不会为当前安装自身触发该事件，无需排除自己。实际卸载在 OnPlanRelatedBundle 里计划。
            relatedMsiUpgradeDetected = true;

            // WiX v3 的 DetectRelatedBundleEventArgs 用 ProductCode 承载 related bundle ID。
            // 记录版本，供 Plan 阶段阻止旧 BA/异常调用路径误卸载更高版本。
            string bundleId = NormalizeBundleId(e.ProductCode);
            if (!string.IsNullOrEmpty(bundleId) && e.Version != null)
            {
                relatedBundleVersions[bundleId] = e.Version;
            }
        }

        /// <summary>
        /// 让 Burn 引擎在本次安装/修复/卸载中卸载所有检测到的历史 bundle。
        ///
        /// 引擎默认只对 RelationType=Upgrade（版本更低）的 related bundle 计划 Absent；
        /// 同版本重装（Operation=None，WiX v3 的 &lt;Bundle&gt; 不支持固定 Id，每次编译 PackageId 随机）
        /// 默认 State=None，旧条目会一直留在应用列表里，装几次就有几个 OpenDesk。
        /// 这里统一改写为 Absent，交由引擎在 Apply 阶段按正确顺序（先完成当前包操作、
        /// 再卸载历史 bundle）执行，比 BA 自己起卸载子进程更可靠：不会与引擎计划冲突，
        /// 也能正确处理提升与回滚。修复场景同样处理：用户点"修复"时应用列表往往已积累
        /// 多个历史条目，修复完成后必须只剩当前一个实例。
        ///
        /// 历史 bundle 卸载时若与当前安装共享同一个 MSI 产品（同版本不同构建各自内嵌
        /// 的 MSI ProductCode 可能相同），依赖检查会让它跳过 MSI 卸载、只注销自己的
        /// dependent 登记与 ARP 条目——正是期望的行为：MSI 留给当前安装继续使用。
        ///
        /// 卸载时同样把残留 bundle 计划 Absent：它们的历史 ARP 条目连同 dependency 登记
        /// 一并清掉。若只删 ARP 键而不卸载，MSI 包的 dependency provider 上会一直挂着
        /// 残留的 dependent，引擎卸载当前包时误判"还有别的产品在用"，跳过 MSI 卸载
        /// （日志 w327 "Will not uninstall package ... found dependents"）。
        ///
        /// 缓存安装器已丢失的 bundle 无法执行卸载，强行计划 Absent 会让整个安装失败，
        /// 因此显式退回 None，由 DeleteStaleRegistryEntries 直接清掉其孤儿注册键。
        /// </summary>
        private void OnPlanRelatedBundle(object sender, PlanRelatedBundleEventArgs e)
        {
            if (
                activeAction != LaunchAction.Install &&
                activeAction != LaunchAction.Repair &&
                activeAction != LaunchAction.Uninstall
            )
            {
                return;
            }

            if (IsProtectedRelatedBundle(e.BundleId))
            {
                e.State = RequestState.None;
                return;
            }

            string cachePath = FindBundleCachePath(e.BundleId);
            e.State = string.IsNullOrWhiteSpace(cachePath) || !File.Exists(cachePath)
                ? RequestState.None
                : RequestState.Absent;
        }

        /// <summary>
        /// 防止 Plan 阶段把当前 bundle 或更高版本的 related bundle 计划为 Absent。
        /// 同版本的其他 bundle 仍允许清理，以保留去重历史安装条目的行为。
        /// </summary>
        private bool IsProtectedRelatedBundle(string bundleId)
        {
            string normalizedBundleId = NormalizeBundleId(bundleId);
            if (string.IsNullOrEmpty(normalizedBundleId))
            {
                return false;
            }

            if (string.Equals(normalizedBundleId, NormalizeBundleId(GetCurrentBundleId()), StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            Version relatedVersion;
            if (!relatedBundleVersions.TryGetValue(normalizedBundleId, out relatedVersion))
            {
                return false;
            }

            Version currentVersion;
            if (!Version.TryParse(Engine.FormatString("[WixBundleVersion]"), out currentVersion))
            {
                return false;
            }

            return relatedVersion > currentVersion;
        }

        private static string NormalizeBundleId(string bundleId)
        {
            return string.IsNullOrWhiteSpace(bundleId) ? string.Empty : bundleId.Trim().Trim('{', '}');
        }

        private void OnDetectRelatedMsiPackage(object sender, DetectRelatedMsiPackageEventArgs e)
        {
            if (
                e.PackageId == PackageId &&
                (e.Operation == RelatedOperation.MajorUpgrade ||
                    e.Operation == RelatedOperation.MinorUpdate ||
                    e.Operation == RelatedOperation.Downgrade)
            )
            {
                relatedMsiUpgradeDetected = true;
                RestoreRelatedMsiInstallFolder(e.ProductCode);
            }
        }

        /// <summary>
        /// 清理引擎无法接管的历史安装残留，确保"应用列表"中只剩本次安装的唯一条目：
        /// 1. 缓存安装器已丢失的 bundle 条目：引擎无法卸载（没有可执行的缓存包），直接删注册键。
        /// 2. 0.3.3 时代遗留的 *.msq 展示键：对应的老 MSI 产品文件早已被新版覆盖，
        ///    只删展示键，不调用 msiexec 以免误删新版共享文件。
        /// 3. 直接双击旧版 MSI 安装留下的可见展示键：正常升级时产品由 MajorUpgrade 卸载、
        ///    条目随之消失，残留只在降级安装等病态场景出现，删展示键恢复列表干净。
        /// bundle 安装的 MSI 产品自身的注册键（UninstallString 指向 msiexec）不删：产品记录
        /// 仍被 Windows Installer 数据库引用，这些键已被 ARPSYSTEMCOMPONENT 隐藏，卸载由
        /// MajorUpgrade 负责。
        ///
        /// 权限说明：BA 进程始终以调用者权限运行（Burn 只提升 Apply 阶段的独立进程），
        /// 因此 DeleteStaleRegistryEntries 采用"先只读枚举、有目标才申请写权限"的策略——
        /// 没有残留时完全不碰 HKLM 写句柄，首次安装不会撞上 SecurityException；
        /// 未提权而确有残留时，写句柄申请失败也只是跳过清理。
        ///
        /// 整体是尽力而为的收尾：真正的卸载由 OnPlanRelatedBundle（历史 bundle）
        /// 与 MajorUpgrade（旧 MSI）负责，这里任何失败都只记日志，不影响安装。
        /// </summary>
        private void CleanupStaleInstallations()
        {
            try
            {
                DeleteStaleRegistryEntries(GetCurrentBundleId());
            }
            catch (Exception exception)
            {
                Engine.Log(LogLevel.Error, "OpenDesk: stale registry cleanup failed: " + exception.Message);
            }
        }

        /// <summary>
        /// 当前安装的 bundle Id。WiX v3 的 &lt;Bundle&gt; 不支持固定 Id，PackageId 每次编译随机，
        /// 只能运行时从引擎变量读。取不到时返回空串：清理逻辑只删缓存缺失的孤儿键，
        /// 而本次安装的注册键要到 Apply 阶段才写入，此刻尚不存在，因此不影响正确性。
        /// </summary>
        private string GetCurrentBundleId()
        {
            try
            {
                return Engine.FormatString("[WixBundleProviderKey]");
            }
            catch
            {
                return string.Empty;
            }
        }

        private static string FindBundleCachePath(string bundleId)
        {
            // Burn 传入的 related bundle id 与其注册表键名一致（带花括号的 GUID，即
            // Uninstall 键下 "Session begin, registration key" 里的键名）。绝不能先 Trim
            // 花括号：注册表键名带花括号，Trim 后必然查不到，所有历史 bundle 都会被误判
            // 为"缓存丢失"而退回 RequestState.None，永远不被卸载（日志表现为
            // "Planned related bundle ... ba requested: None"，哪怕缓存文件实际存在）。
            // 同时查询不带花括号的形态，防御未来 burn 行为变化。
            string[] keyNames =
            {
                bundleId,
                bundleId.Trim('{', '}')
            };
            string uninstallKeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\";
            RegistryView[] views = { RegistryView.Registry32, RegistryView.Registry64 };
            foreach (RegistryView view in views)
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                {
                    if (baseKey == null) continue;
                    foreach (string keyName in keyNames)
                    {
                        if (string.IsNullOrWhiteSpace(keyName)) continue;
                        using (RegistryKey key = baseKey.OpenSubKey(uninstallKeyPath + keyName))
                        {
                            if (key == null) continue;
                            string cachePath = key.GetValue("BundleCachePath") as string;
                            if (!string.IsNullOrWhiteSpace(cachePath)) return cachePath;
                        }
                    }
                }
            }
            return null;
        }

        private static void DeleteStaleRegistryEntries(string currentBundleId)
        {
            string[] uninstallKeyPaths =
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };
            RegistryView[] views = { RegistryView.Registry64, RegistryView.Registry32 };
            foreach (RegistryView view in views)
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                {
                    if (baseKey == null) continue;
                    foreach (string uninstallKeyPath in uninstallKeyPaths)
                    {
                        // 先只读枚举：BA 进程未提权时以写权限打开 HKLM 会抛 SecurityException。
                        // 只有确实有孤儿键要删时才申请写权限，让"无残留可清"的首次安装完全不碰写句柄。
                        List<string> staleKeyNames = new List<string>();
                        using (RegistryKey uninstallKey = baseKey.OpenSubKey(uninstallKeyPath))
                        {
                            if (uninstallKey == null) continue;
                            foreach (string subKeyName in uninstallKey.GetSubKeyNames())
                            {
                                if (IsCurrentBundleKey(subKeyName, currentBundleId)) continue;
                                using (RegistryKey subKey = uninstallKey.OpenSubKey(subKeyName))
                                {
                                    if (subKey == null) continue;
                                    if (!IsOpenDeskEntry(subKey)) continue;
                                    if (!IsDeletableStaleEntry(subKey, subKeyName)) continue;
                                }
                                staleKeyNames.Add(subKeyName);
                            }
                        }

                        if (staleKeyNames.Count == 0) continue;

                        using (RegistryKey writableKey = baseKey.OpenSubKey(uninstallKeyPath, true))
                        {
                            if (writableKey == null) continue;
                            foreach (string staleKeyName in staleKeyNames)
                            {
                                try { writableKey.DeleteSubKeyTree(staleKeyName, false); } catch { }
                            }
                        }
                    }
                }
            }
        }

        private static bool IsCurrentBundleKey(string keyName, string currentBundleId)
        {
            return !string.IsNullOrEmpty(currentBundleId) &&
                string.Equals(
                    keyName.Trim('{', '}'),
                    currentBundleId.Trim('{', '}'),
                    StringComparison.OrdinalIgnoreCase
                );
        }

        private static bool IsOpenDeskEntry(RegistryKey subKey)
        {
            string displayName = subKey.GetValue("DisplayName") as string;
            return !string.IsNullOrWhiteSpace(displayName) &&
                displayName.StartsWith("OpenDesk", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsDeletableStaleEntry(RegistryKey subKey, string keyName)
        {
            // 0.3.3 时代遗留的 *.msq 展示键（老 MSI 的 Burn 标记，产品文件早被新版覆盖）。
            if (keyName.EndsWith(".msq", StringComparison.OrdinalIgnoreCase)) return true;

            // Burn bundle 条目：缓存安装器已丢失时无法再走正规卸载，按孤儿处理直接删键。
            // 缓存仍在的 bundle 不在这里删——它们已由 OnPlanRelatedBundle 计划为 Absent，
            // 由引擎在 Apply 阶段正常卸载（先当前包操作、后卸历史 bundle）。
            string bundleCachePath = subKey.GetValue("BundleCachePath") as string;
            if (bundleCachePath != null) return !File.Exists(bundleCachePath);

            // 直接双击 MSI 安装留下的可见展示键（UninstallString 指向 msiexec、未被
            // ARPSYSTEMCOMPONENT 隐藏）：正常升级时该产品由 MajorUpgrade 卸载、条目随之
            // 消失，残留只出现在"已装新版后又双击装了旧版 MSI"这类降级场景。产品记录仍被
            // Windows Installer 引用、文件与当前安装共享，不能执行卸载，删展示键即可。
            if (IsVisibleMsiProductEntry(subKey)) return true;

            // 其余（bundle 安装的 MSI 产品注册键，已被 ARPSYSTEMCOMPONENT 隐藏）不删：
            // 不会出现在应用列表，卸载由 MajorUpgrade 或 bundle 卸载负责。
            return false;
        }

        private static bool IsVisibleMsiProductEntry(RegistryKey subKey)
        {
            // REG_DWORD 在 RegistryKey 中读出即 boxed int；其他类型一律按可见处理
            // （只删展示键，无破坏性）。不使用 try/catch：本文件由 .NET Framework 4.0 的
            // csc.exe 编译，仅支持 C# 5 语法（catch when 过滤器不可用）。
            object systemComponent = subKey.GetValue("SystemComponent");
            if (systemComponent is int && (int)systemComponent != 0)
            {
                return false;
            }

            string uninstallString = subKey.GetValue("UninstallString") as string;
            return !string.IsNullOrWhiteSpace(uninstallString) &&
                uninstallString.TrimStart().StartsWith("MsiExec.exe", StringComparison.OrdinalIgnoreCase);
        }

        private void RestoreRelatedMsiInstallFolder(string productCode)
        {
            string folder = FindRelatedMsiInstallFolder(productCode);
            if (string.IsNullOrWhiteSpace(folder))
            {
                return;
            }

            activeInstallFolder = InstallerPath.Normalize(folder);
            Engine.StringVariables["InstallFolder"] = activeInstallFolder;
        }

        private static string FindRelatedMsiInstallFolder(string productCode)
        {
            if (string.IsNullOrWhiteSpace(productCode))
            {
                return null;
            }

            string uninstallKey = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\";
            string[] keyPaths = { uninstallKey + productCode + ".msq", uninstallKey + productCode };
            RegistryView[] views = { RegistryView.Registry32, RegistryView.Registry64 };
            RegistryHive[] hives = { RegistryHive.LocalMachine, RegistryHive.CurrentUser };

            foreach (RegistryHive hive in hives)
            {
                foreach (RegistryView view in views)
                {
                    try
                    {
                        using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                        {
                            foreach (string keyPath in keyPaths)
                            {
                                using (RegistryKey key = root.OpenSubKey(keyPath))
                                {
                                    if (key == null)
                                    {
                                        continue;
                                    }

                                    object value = key.GetValue("InstallPath") ?? key.GetValue("InstallLocation");
                                    string folder = value as string;
                                    if (!string.IsNullOrWhiteSpace(folder))
                                    {
                                        return folder;
                                    }
                                }
                            }
                        }
                    }
                    catch
                    {
                    }
                }
            }

            return null;
        }

        private void OnDetectComplete(object sender, DetectCompleteEventArgs e)
        {
            if (e.Status < 0)
            {
                exitCode = e.Status;
                Post(delegate
                {
                    if (RunsWithoutUserInteraction)
                    {
                        form.Close();
                    }
                    else if (e.Status == ErrorFailNoActionReboot)
                    {
                        form.ShowRestartRequired(false);
                        form.Reveal();
                    }
                    else
                    {
                        form.ShowFailure(e.Status, null);
                        form.Reveal();
                    }
                });
                return;
            }

            Post(delegate
            {
                bool maintenanceRequested =
                    Command.Action == LaunchAction.Uninstall ||
                    Command.Action == LaunchAction.Repair ||
                    Command.Action == LaunchAction.Modify;
                form.ShowDetected(
                    packageState == PackageState.Present || maintenanceRequested,
                    relatedMsiUpgradeDetected,
                    !RunsWithoutUserInteraction
                );
                if (RunsWithoutUserInteraction || Command.Display != Display.Full)
                {
                    LaunchAction action = Command.Action == LaunchAction.Unknown ? LaunchAction.Install : Command.Action;
                    StartAction(action);
                }
            });
        }

        private void OnPlanComplete(object sender, PlanCompleteEventArgs e)
        {
            if (e.Status < 0)
            {
                exitCode = e.Status;
                Post(delegate
                {
                    if (RunsWithoutUserInteraction)
                    {
                        form.Close();
                    }
                    else if (e.Status == ErrorFailNoActionReboot)
                    {
                        form.ShowRestartRequired(false);
                    }
                    else
                    {
                        form.ShowFailure(e.Status, lastError);
                    }
                });
                return;
            }

            Post(delegate
            {
                form.SetProgressStatus("ProgressInstalling", "ProgressRepairing", "ProgressUninstalling");
                Engine.Apply(form.Handle);
            });
        }

        private void OnProgress(object sender, ProgressEventArgs e)
        {
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
            Post(delegate { form.UpdateProgress(e.OverallPercentage); });
        }

        private void OnExecuteProgress(object sender, ExecuteProgressEventArgs e)
        {
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
            Post(delegate { form.UpdateProgress(e.OverallPercentage); });
        }

        private void OnExecutePackageBegin(object sender, ExecutePackageBeginEventArgs e)
        {
            // CleanupRelatedBundles 是普通 ExePackage，引擎无法跟踪其内部进度；升级/修复场景下
            // 它可能静默运行一两分钟（等旧版安装器退出、兜底强杀、删缓存目录）。此时把进度页
            // 文案切到"正在清理旧版本"，避免用户误以为安装卡死。仅在 detect 阶段发现过历史
            // bundle 时才切换：全新安装中该包也会执行但秒退，不该展示清理文案。
            if (e.PackageId == CleanupRelatedBundlesPackageId && relatedMsiUpgradeDetected)
            {
                Post(delegate
                {
                    form.SetProgressStatus(
                        "ProgressCleaningOldBundles",
                        "ProgressCleaningOldBundles",
                        "ProgressCleaningOldBundles"
                    );
                });
                return;
            }

            Post(delegate
            {
                form.SetProgressStatus("ProgressInstalling", "ProgressRepairing", "ProgressUninstalling");
            });
        }

        private void OnExecutePackageComplete(object sender, ExecutePackageCompleteEventArgs e)
        {
            if (e.PackageId != CleanupRelatedBundlesPackageId)
            {
                return;
            }

            // 清理包结束后恢复常规文案：若之后没有其他包的 ExecutePackageBegin（例如没有
            // related bundle 需要引擎处理），不让"正在清理旧版本"一直停留到完成页。
            Post(delegate
            {
                form.SetProgressStatus("ProgressInstalling", "ProgressRepairing", "ProgressUninstalling");
            });
        }

        private void OnError(
            object sender,
            Microsoft.Tools.WindowsInstallerXml.Bootstrapper.ErrorEventArgs e
        )
        {
            lastError = e.ErrorMessage;
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
        }

        private void OnApplyComplete(object sender, ApplyCompleteEventArgs e)
        {
            exitCode = e.Status;
            Post(delegate
            {
                if (RunsWithoutUserInteraction)
                {
                    form.Close();
                }
                else if (e.Status == ErrorFailNoActionReboot)
                {
                    form.ShowRestartRequired(false);
                }
                else if (e.Restart != ApplyRestart.None)
                {
                    form.UpdateProgress(100);
                    form.ShowRestartRequired(e.Status >= 0);
                }
                else if (e.Status >= 0)
                {
                    form.UpdateProgress(100);
                    form.ShowSuccess(activeAction);
                }
                else
                {
                    form.ShowFailure(e.Status, lastError);
                }
            });
        }

        private void Post(MethodInvoker action)
        {
            if (form == null || form.IsDisposed)
            {
                return;
            }

            if (form.InvokeRequired)
            {
                form.BeginInvoke(action);
            }
            else
            {
                action();
            }
        }

        private static string GetPayloadPath(string fileName)
        {
            return Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), fileName);
        }
    }

    internal sealed class InstallerForm : Form
    {
        private static readonly Color Surface = Color.FromArgb(248, 250, 250);
        private static readonly Color TextColor = Color.FromArgb(23, 32, 37);
        private static readonly Color MutedColor = Color.FromArgb(102, 115, 122);
        private static readonly Color Teal = Color.FromArgb(8, 127, 114);
        private static readonly Color LightTeal = Color.FromArgb(229, 243, 240);
        private static readonly Color LineColor = Color.FromArgb(221, 230, 231);
        private static readonly Color SidebarText = Color.FromArgb(226, 224, 216);
        private static readonly Font BrandFont = new Font("Segoe UI", 19F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font HeadingFont = new Font("Microsoft YaHei UI", 27F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font BodyFont = new Font("Microsoft YaHei UI", 15F, FontStyle.Regular, GraphicsUnit.Pixel);
        private static readonly Font LabelFont = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font SmallFont = new Font("Microsoft YaHei UI", 12F, FontStyle.Regular, GraphicsUnit.Pixel);
        private static readonly Font ButtonFont = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Pixel);

        private readonly OpenDeskBootstrapperApplication application;
        private readonly Localizer localizer;
        private readonly Panel rightBody;
        private readonly Panel footer;
        private readonly Label[] stepLabels = new Label[3];
        private ProgressBar progressBar;
        private Label progressStatus;
        private Label progressPercent;
        private TextBox folderTextBox;
        private CheckBox desktopShortcutCheckBox;
        private CheckBox startMenuShortcutCheckBox;
        private Label installLocationLabel;
        private Button installOptionsButton;
        private Button startInstallButton;
        private string selectedFolder;
        private bool selectedDesktopShortcut;
        private bool selectedStartMenuShortcut;
        private bool selectedInstallPathCustomized;
        private bool editingInstallPathCustomized;
        private bool upgradeDetected;
        private LaunchAction progressAction = LaunchAction.Unknown;
        private bool busy;
        // UAC 提权前后把窗口拉回可见状态的看护定时器（见 KeepVisibleThroughElevation）。
        private Timer elevationVisibilityTimer;
        private const int ElevationVisibilityPollInterval = 200;
        // UAC 授权框可能停留很久，看护窗口给足 3 分钟；成功恢复一次即提前停表。
        private const int ElevationVisibilityWatchDuration = 180000;

        public InstallerForm(OpenDeskBootstrapperApplication application, Localizer localizer)
        {
            this.application = application;
            this.localizer = localizer;

            Name = "OpenDeskInstallerWindow";
            Text = T("Caption");
            ClientSize = new Size(920, 600);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            Opacity = 0D;
            ShowInTaskbar = false;
            BackColor = Surface;
            BackgroundImage = LoadImage("background.png");
            BackgroundImageLayout = ImageLayout.None;
            Icon = new Icon(GetPayloadPath("opendesk.ico"));
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint,
                true
            );
            UpdateStyles();

            selectedFolder = application.GetInstallFolder();
            selectedDesktopShortcut = application.GetSavedPreference("CreateDesktopShortcut");
            selectedStartMenuShortcut = application.GetSavedPreference("CreateStartMenuShortcut");
            selectedInstallPathCustomized = application.GetSavedInstallPathCustomized();

            BuildSidebar();

            rightBody = new BufferedPanel();
            rightBody.Name = "RightContentPanel";
            rightBody.SetBounds(284, 0, 636, 516);
            rightBody.BackColor = Surface;
            Controls.Add(rightBody);

            footer = new BufferedPanel();
            footer.Name = "FooterPanel";
            footer.SetBounds(284, 516, 636, 84);
            footer.BackColor = Color.FromArgb(252, 253, 253);
            Controls.Add(footer);

            FormClosing += OnFormClosing;
            ShowWelcome(false);
        }

        public void ShowDetected(bool installed, bool relatedUpgradeDetected, bool reveal)
        {
            selectedFolder = application.GetInstallFolder();
            selectedDesktopShortcut = application.GetSavedPreference("CreateDesktopShortcut");
            selectedStartMenuShortcut = application.GetSavedPreference("CreateStartMenuShortcut");
            selectedInstallPathCustomized = application.GetSavedInstallPathCustomized();
            upgradeDetected = relatedUpgradeDetected;
            if (installed)
            {
                ShowMaintenance();
            }
            else
            {
                ShowWelcome(true);
            }

            if (reveal)
            {
                Reveal();
            }
        }

        public void Reveal()
        {
            ShowInTaskbar = true;
            Opacity = 1D;
        }

        /// <summary>
        /// 抵消 UAC 提权对窗口 z-order 的副作用。
        ///
        /// 引擎在 Apply 阶段用 ShellExecute 启动提权的 companion 进程，UAC 结束后
        /// Windows 会把发起提权的窗口压到别的窗口后面（有时还会最小化），用户授权完
        /// 看不到安装界面。
        ///
        /// 恢复必须靠持续观察，而不是在某个事件里做一次：UAC 安全桌面期间夺取前台注定
        /// 失败，而"何时被压后台"由系统决定，用户还可能在授权框上停留很久。这里从 Apply
        /// 开始轮询，只在本窗口既非前台、且前台窗口不属于本进程时才尝试抢回；成功一次
        /// 即停表，因此最多只打扰用户一次。看护窗口到期也会自行停止。
        /// </summary>
        public void KeepVisibleThroughElevation()
        {
            if (elevationVisibilityTimer != null)
            {
                return;
            }

            int elapsedMilliseconds = 0;
            elevationVisibilityTimer = new Timer();
            elevationVisibilityTimer.Interval = ElevationVisibilityPollInterval;
            elevationVisibilityTimer.Tick += delegate
            {
                elapsedMilliseconds += ElevationVisibilityPollInterval;
                bool restored = BringBackToForegroundIfDisplaced();
                if (restored || elapsedMilliseconds >= ElevationVisibilityWatchDuration)
                {
                    StopElevationVisibilityWatch();
                }
            };
            elevationVisibilityTimer.Start();
        }

        /// <summary>
        /// 若本窗口已被其他进程的窗口挤到后台，则恢复并抢回前台；返回是否成功抢回。
        ///
        /// 几个判断上的注意点：
        /// - 不能用"是否最小化"提前退出：UAC 之后窗口通常没被最小化，只是被压在后面。
        /// - 前台窗口属于本进程时不动作：那可能是我们自己的 MessageBox（如"OpenDesk 正在
        ///   运行"提示），抢前台会把它盖掉。
        /// - 提权尚未发起时不动作：此时失去前台只可能是用户主动切走的，不该打扰他。
        /// </summary>
        private bool BringBackToForegroundIfDisplaced()
        {
            if (IsDisposed || !IsHandleCreated)
            {
                return false;
            }

            if (!application.ElevationRequested)
            {
                return false;
            }

            if (NativeMethods.IsForegroundWindowInCurrentProcess())
            {
                return false;
            }

            if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
            }
            // UAC 结束后前台归属别的进程，SetForegroundWindow 会被系统忽略，
            // 必须借 AttachThreadInput 拿到前台权限（见 NativeMethods.ForceForeground）。
            return NativeMethods.ForceForeground(this);
        }

        private void StopElevationVisibilityWatch()
        {
            if (elevationVisibilityTimer == null)
            {
                return;
            }

            elevationVisibilityTimer.Stop();
            elevationVisibilityTimer.Dispose();
            elevationVisibilityTimer = null;
        }

        public void ShowProgress(LaunchAction action)
        {
            busy = true;
            progressAction = action;
            RenderPage(delegate
            {
                SetActiveStep(1);
                string headerId = action == LaunchAction.Repair
                    ? "ProgressRepairHeader"
                    : action == LaunchAction.Uninstall ? "ProgressUninstallHeader" : "ProgressHeader";
                string messageId = action == LaunchAction.Repair
                    ? "ProgressRepairMessage"
                    : action == LaunchAction.Uninstall ? "ProgressUninstallMessage" : "ProgressMessage";
                AddLabel(rightBody, "ProgressHeader", T(headerId), 46, 86, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "ProgressMessage", T(messageId), 46, 145, 540, 44, BodyFont, MutedColor);
                AddLabel(rightBody, "ProgressLabel", T("ProgressLabel"), 46, 244, 540, 24, LabelFont, TextColor);
                progressStatus = AddLabel(
                    rightBody,
                    "ProgressStatusLabel",
                    T(GetProgressLocalizationId(
                        "ProgressPreparing",
                        "ProgressRepairPreparing",
                        "ProgressUninstallPreparing"
                    )),
                    46,
                    282,
                    500,
                    24,
                    BodyFont,
                    MutedColor
                );
                progressBar = new ProgressBar();
                progressBar.Name = "InstallProgressBar";
                progressBar.SetBounds(46, 322, 530, 18);
                progressBar.Style = ProgressBarStyle.Continuous;
                rightBody.Controls.Add(progressBar);
                progressPercent = AddLabel(
                    rightBody,
                    "ProgressPercentLabel",
                    "0%",
                    46,
                    350,
                    530,
                    22,
                    SmallFont,
                    MutedColor
                );
                progressPercent.TextAlign = ContentAlignment.MiddleRight;
                AddFooterButton(
                    "CancelInstallButton",
                    T(GetProgressLocalizationId(
                        "ProgressCancelButton",
                        "ProgressRepairCancelButton",
                        "ProgressUninstallCancelButton"
                    )),
                    470,
                    delegate
                    {
                        application.RequestCancel();
                    }
                );
            });
        }

        public DialogResult PromptForRunningOpenDesk(string executablePath)
        {
            return MessageBox.Show(
                this,
                string.Format(T("OpenDeskRunningMessage"), executablePath),
                T("OpenDeskRunningTitle"),
                MessageBoxButtons.RetryCancel,
                MessageBoxIcon.Warning
            );
        }

        /// <summary>
        /// 磁盘空间不足提示页。展示目标盘所需空间与当前可用空间，用户点击"返回"后
        /// 回到"安装选项"页更换目录重试（选项页里的输入在空间检查前已记录）。
        /// </summary>
        public void ShowInsufficientDiskSpace(long requiredBytes, long availableBytes)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(-1);
                AddLabel(
                    rightBody,
                    "InsufficientSpaceHeader",
                    T("InsufficientSpaceHeader"),
                    46,
                    110,
                    540,
                    58,
                    HeadingFont,
                    Color.FromArgb(178, 59, 49)
                );
                string message = string.Format(
                    T("InsufficientSpaceMessage"),
                    FormatSize(requiredBytes),
                    FormatSize(availableBytes)
                );
                AddLabel(rightBody, "InsufficientSpaceMessage", message, 46, 190, 540, 60, BodyFont, MutedColor);
                AddLabel(rightBody, "InsufficientSpaceHint", T("InsufficientSpaceHint"), 46, 265, 540, 60, SmallFont, MutedColor);
                AddFooterButton("InsufficientSpaceBackButton", T("InsufficientSpaceBackButton"), 470, ShowOptions);
            });
        }

        private static string FormatSize(long bytes)
        {
            const long MB = 1024 * 1024;
            const long GB = 1024 * MB;
            return bytes >= GB
                ? string.Format("{0:F1} GB", (double)bytes / GB)
                : string.Format("{0:F0} MB", (double)bytes / MB);
        }

        public void ShowRestartRequired(bool operationCompleted)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(operationCompleted ? 2 : -1);
                AddLabel(
                    rightBody,
                    "RestartRequiredHeader",
                    T("RestartRequiredHeader"),
                    46,
                    110,
                    540,
                    58,
                    HeadingFont,
                    operationCompleted ? Teal : Color.FromArgb(178, 59, 49)
                );
                AddLabel(
                    rightBody,
                    "RestartRequiredMessage",
                    T(operationCompleted ? "RestartRequiredCompletedMessage" : "RestartRequiredPendingMessage"),
                    46,
                    190,
                    540,
                    90,
                    BodyFont,
                    MutedColor
                );
                AddFooterButton("RestartRequiredCloseButton", T("RestartRequiredCloseButton"), 470, Close);
            });
        }

        public void SetProgressStatus(
            string installLocalizationId,
            string repairLocalizationId,
            string uninstallLocalizationId
        )
        {
            if (progressStatus != null)
            {
                progressStatus.Text = T(GetProgressLocalizationId(
                    installLocalizationId,
                    repairLocalizationId,
                    uninstallLocalizationId
                ));
            }
        }

        private string GetProgressLocalizationId(
            string installLocalizationId,
            string repairLocalizationId,
            string uninstallLocalizationId
        )
        {
            return progressAction == LaunchAction.Repair
                ? repairLocalizationId
                : progressAction == LaunchAction.Uninstall ? uninstallLocalizationId : installLocalizationId;
        }

        public void UpdateProgress(int percentage)
        {
            if (progressBar == null)
            {
                return;
            }

            int value = Math.Max(0, Math.Min(100, percentage));
            progressBar.Value = value;
            progressPercent.Text = value.ToString() + "%";
            if (value >= 95)
            {
                SetProgressStatus("ProgressFinishing", "ProgressRepairFinishing", "ProgressUninstallFinishing");
            }
        }

        public void ShowSuccess(LaunchAction action)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(2);
                string header = action == LaunchAction.Uninstall
                    ? T("SuccessUninstallHeader")
                    : action == LaunchAction.Repair ? T("SuccessRepairHeader") : T("SuccessInstallHeader");
                AddLabel(rightBody, "SuccessHeader", header, 46, 110, 540, 58, HeadingFont, Teal);
                AddLabel(rightBody, "SuccessMessage", T("SuccessMessage"), 46, 190, 540, 44, BodyFont, MutedColor);

                if (action != LaunchAction.Uninstall)
                {
                    AddFooterButton("LaunchOpenDeskButton", T("SuccessLaunchButton"), 336, delegate
                    {
                        application.LaunchInstalledApplication();
                        Close();
                    });
                }
                AddFooterButton("FinishButton", T("SuccessCloseButton"), 470, Close);
            });
        }

        public void ShowFailure(int status, string detail)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(-1);
                AddLabel(
                    rightBody,
                    "FailureHeader",
                    T("FailureHeader"),
                    46,
                    110,
                    540,
                    58,
                    HeadingFont,
                    Color.FromArgb(178, 59, 49)
                );
                string message = string.Format(T("FailureMessage"), "0x" + status.ToString("X8"));
                AddLabel(rightBody, "FailureMessage", message, 46, 190, 540, 60, BodyFont, MutedColor);
                if (!string.IsNullOrWhiteSpace(detail))
                {
                    AddLabel(rightBody, "FailureDetail", detail, 46, 265, 540, 100, SmallFont, MutedColor);
                }
                AddFooterButton("FailureCloseButton", T("FailureCloseButton"), 470, Close);
            });
        }

        private void ShowWelcome(bool enabled)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(0);
                string version = application.Engine.FormatString(T("InstallEyebrow"));
                string headerId = upgradeDetected ? "UpgradeHeader" : "InstallHeader";
                string messageId = upgradeDetected ? "UpgradeMessage" : "InstallMessage";
                string installButtonId = upgradeDetected ? "UpgradeInstallButton" : "InstallInstallButton";
                AddLabel(rightBody, "InstallEyebrow", version, 46, 58, 540, 22, SmallFont, Teal).Font = LabelFont;
                AddLabel(rightBody, "InstallHeader", T(headerId), 46, 88, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "InstallMessage", T(messageId), 46, 143, 540, 50, BodyFont, MutedColor);
                AddFeatureRow(206, "01", T("FeatureWorkspaceTitle"), T("FeatureWorkspaceText"));
                AddFeatureRow(280, "02", T("FeatureLocalTitle"), T("FeatureLocalText"));
                AddFeatureRow(354, "03", T("FeatureExtendTitle"), T("FeatureExtendText"));
                installLocationLabel = AddLabel(
                    rightBody,
                    "InstallLocationHint",
                    string.Format(T("SelectedInstallLocation"), selectedFolder),
                    46,
                    455,
                    540,
                    22,
                    SmallFont,
                    MutedColor
                );
                installLocationLabel.AutoEllipsis = true;

                AddFooterButton("ExitInstallerButton", T("InstallCloseButton"), 38, Close);
                installOptionsButton = AddFooterButton(
                    "InstallOptionsButton",
                    T("InstallOptionsButton"),
                    336,
                    ShowOptions
                );
                startInstallButton = AddFooterButton(
                    "StartInstallButton",
                    T(installButtonId),
                    470,
                    StartInstallFromWelcome
                );
                installOptionsButton.Enabled = enabled;
                startInstallButton.Enabled = enabled;
            });
        }

        private void ShowOptions()
        {
            RenderPage(delegate
            {
                SetActiveStep(0);
                AddLabel(rightBody, "OptionsEyebrow", T("OptionsEyebrow"), 46, 58, 540, 22, LabelFont, Teal);
                AddLabel(rightBody, "OptionsHeader", T("OptionsHeader"), 46, 88, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "OptionsMessage", T("OptionsMessage"), 46, 143, 540, 50, BodyFont, MutedColor);
                AddLabel(
                    rightBody,
                    "OptionsLocationLabel",
                    T("OptionsLocationLabel"),
                    46,
                    214,
                    540,
                    24,
                    LabelFont,
                    TextColor
                );

                folderTextBox = new TextBox();
                folderTextBox.Name = "InstallFolderTextBox";
                folderTextBox.Font = BodyFont;
                folderTextBox.SetBounds(46, 249, 416, 34);
                folderTextBox.Text = selectedFolder;
                editingInstallPathCustomized = selectedInstallPathCustomized;
                folderTextBox.TextChanged += delegate { editingInstallPathCustomized = true; };
                rightBody.Controls.Add(folderTextBox);

                Button browse = AddButton(rightBody, "BrowseFolderButton", T("OptionsBrowseButton"), 468, 247, 128, 38);
                browse.Click += delegate
                {
                    using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                    {
                        dialog.Description = T("FolderBrowseDescription");
                        dialog.SelectedPath = folderTextBox.Text;
                        if (dialog.ShowDialog(this) == DialogResult.OK)
                        {
                            folderTextBox.Text = InstallerPath.AppendDefaultDirectory(dialog.SelectedPath);
                            editingInstallPathCustomized = false;
                        }
                    }
                };

                desktopShortcutCheckBox = AddCheckBox(
                    "CreateDesktopShortcutCheckBox",
                    T("CreateDesktopShortcut"),
                    46,
                    318,
                    selectedDesktopShortcut
                );
                startMenuShortcutCheckBox = AddCheckBox(
                    "CreateStartMenuShortcutCheckBox",
                    T("CreateStartMenuShortcut"),
                    46,
                    356,
                    selectedStartMenuShortcut
                );
                AddLabel(rightBody, "OptionsDriveHint", T("OptionsDriveHint"), 46, 407, 540, 24, SmallFont, MutedColor);
                AddLabel(
                    rightBody,
                    "ShortcutOptionsHint",
                    T("ShortcutOptionsHint"),
                    46,
                    435,
                    540,
                    24,
                    SmallFont,
                    MutedColor
                );

                AddFooterButton("OptionsBackButton", T("OptionsCancelButton"), 336, delegate { ShowWelcome(true); });
                AddFooterButton("OptionsSaveButton", T("OptionsOkButton"), 470, SaveOptions);
            });
        }

        private void ShowMaintenance()
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(0);
                AddLabel(rightBody, "ModifyHeader", T("ModifyHeader"), 46, 92, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "ModifyMessage", T("ModifyMessage"), 46, 150, 540, 48, BodyFont, MutedColor);
                AddFeatureRow(236, "01", T("ModifyRepairButton"), T("ModifyRepairDescription"));
                AddFeatureRow(324, "02", T("ModifyUninstallButton"), T("ModifyUninstallDescription"));
                AddFooterButton("ModifyCloseButton", T("ModifyCloseButton"), 202, Close);
                AddFooterButton("RepairButton", T("ModifyRepairButton"), 336, application.Repair);
                AddFooterButton("UninstallButton", T("ModifyUninstallButton"), 470, application.Uninstall);
            });
        }

        private void StartInstallFromWelcome()
        {
            // 空间预检查失败时保持当前页面，用户可换目录重试（issue #288）。
            if (!application.HasEnoughSpaceForInstall(selectedFolder))
            {
                return;
            }

            application.Install(
                selectedFolder,
                selectedDesktopShortcut,
                selectedStartMenuShortcut,
                selectedInstallPathCustomized
            );
        }

        private void SaveOptions()
        {
            string folder = InstallerPath.Normalize(folderTextBox.Text);
            if (!IsUsableInstallPath(folder))
            {
                MessageBox.Show(
                    this,
                    T("InvalidInstallPathMessage"),
                    T("InvalidInstallPathTitle"),
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            // 先记录用户输入再校验空间：空间不足会切换到提示页并销毁选项页，
            // 返回选项页时由这些字段重建输入框，避免用户刚填的目录与勾选项丢失。
            selectedFolder = folder;
            selectedDesktopShortcut = desktopShortcutCheckBox.Checked;
            selectedStartMenuShortcut = startMenuShortcutCheckBox.Checked;
            selectedInstallPathCustomized = editingInstallPathCustomized;

            if (!application.HasEnoughSpaceForInstall(folder))
            {
                return;
            }

            ShowWelcome(true);
        }

        private static bool IsUsableInstallPath(string folder)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder))
                {
                    return false;
                }

                string root = Path.GetPathRoot(folder);
                DriveInfo drive = new DriveInfo(root);
                return drive.IsReady;
            }
            catch
            {
                return false;
            }
        }

        private void BuildSidebar()
        {
            AddLabel(this, "BrandName", "OpenDesk", 40, 36, 180, 38, BrandFont, Color.White);
            AddLabel(this, "BrandTagline", "AI WORKSTATION", 40, 73, 180, 22, SmallFont, Color.FromArgb(153, 148, 134));
            AddLabel(this, "BrandCopy", T("BrandCopy"), 40, 138, 200, 88, BodyFont, SidebarText);
            stepLabels[0] = AddLabel(this, "StepPrepare", "01  " + T("StepPrepare"), 40, 275, 200, 28, LabelFont, SidebarText);
            stepLabels[1] = AddLabel(this, "StepInstall", "02  " + T("StepInstall"), 40, 323, 200, 28, BodyFont, Color.FromArgb(153, 148, 134));
            stepLabels[2] = AddLabel(this, "StepComplete", "03  " + T("StepComplete"), 40, 371, 200, 28, BodyFont, Color.FromArgb(153, 148, 134));
        }

        private void AddFeatureRow(int y, string number, string title, string description)
        {
            Label badge = AddLabel(rightBody, "FeatureBadge" + number, number, 46, y, 36, 36, LabelFont, Teal);
            badge.BackColor = LightTeal;
            badge.TextAlign = ContentAlignment.MiddleCenter;
            AddLabel(rightBody, "FeatureTitle" + number, title, 96, y, 440, 25, LabelFont, TextColor);
            AddLabel(rightBody, "FeatureDescription" + number, description, 96, y + 25, 440, 24, SmallFont, MutedColor);
            Panel line = new Panel();
            line.BackColor = LineColor;
            line.SetBounds(46, y + 57, 530, 1);
            rightBody.Controls.Add(line);
        }

        private CheckBox AddCheckBox(string name, string text, int x, int y, bool isChecked)
        {
            CheckBox checkBox = new CheckBox();
            checkBox.Name = name;
            checkBox.Text = text;
            checkBox.Checked = isChecked;
            checkBox.Font = BodyFont;
            checkBox.ForeColor = TextColor;
            checkBox.BackColor = Color.Transparent;
            checkBox.SetBounds(x, y, 530, 28);
            rightBody.Controls.Add(checkBox);
            return checkBox;
        }

        private Button AddFooterButton(string name, string text, int x, MethodInvoker action)
        {
            Button button = AddButton(footer, name, text, x, 20, 128, 38);
            button.Click += delegate { action(); };
            return button;
        }

        private static Button AddButton(Control parent, string name, string text, int x, int y, int width, int height)
        {
            Button button = new Button();
            button.Name = name;
            button.Text = text;
            button.Font = ButtonFont;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.FlatStyle = FlatStyle.System;
            button.SetBounds(x, y, width, height);
            parent.Controls.Add(button);
            return button;
        }

        private static Label AddLabel(
            Control parent,
            string name,
            string text,
            int x,
            int y,
            int width,
            int height,
            Font font,
            Color color
        )
        {
            Label label = new Label();
            label.Name = name;
            label.Text = text;
            label.Font = font;
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.TextAlign = ContentAlignment.MiddleLeft;
            label.UseCompatibleTextRendering = true;
            label.SetBounds(x, y, width, height);
            parent.Controls.Add(label);
            return label;
        }

        private void SetActiveStep(int activeStep)
        {
            for (int index = 0; index < stepLabels.Length; index += 1)
            {
                bool active = index == activeStep;
                stepLabels[index].Font = active ? LabelFont : BodyFont;
                stepLabels[index].ForeColor = active ? Color.White : Color.FromArgb(153, 148, 134);
            }
        }

        private void RenderPage(MethodInvoker buildPage)
        {
            bool redrawLocked = IsHandleCreated;
            if (redrawLocked)
            {
                NativeMethods.SetRedraw(this, false);
                NativeMethods.SetRedraw(rightBody, false);
                NativeMethods.SetRedraw(footer, false);
            }

            SuspendLayout();
            rightBody.SuspendLayout();
            footer.SuspendLayout();
            try
            {
                ClearPage();
                buildPage();
            }
            finally
            {
                footer.ResumeLayout(false);
                rightBody.ResumeLayout(false);
                ResumeLayout(false);

                if (redrawLocked)
                {
                    NativeMethods.SetRedraw(footer, true);
                    NativeMethods.SetRedraw(rightBody, true);
                    NativeMethods.SetRedraw(this, true);
                    Invalidate(true);
                    Update();
                }
            }
        }

        private void ClearPage()
        {
            DisposeChildren(rightBody);
            DisposeChildren(footer);
            progressBar = null;
            progressStatus = null;
            progressPercent = null;
            folderTextBox = null;
            desktopShortcutCheckBox = null;
            startMenuShortcutCheckBox = null;
            installLocationLabel = null;
            installOptionsButton = null;
            startInstallButton = null;
        }

        private static void DisposeChildren(Control parent)
        {
            while (parent.Controls.Count > 0)
            {
                parent.Controls[0].Dispose();
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            StopElevationVisibilityWatch();

            if (application.RunsWithoutUserInteraction)
            {
                // 静默模式/被父 bundle 调起：apply 完成后这里直接放行关闭。
                // 若还走 busy 守卫，会 e.Cancel + 弹确认框——在 /quiet 下窗体是隐藏的，
                // 这个 MessageBox 永远没人点，进程不退出，卸载就"卡住"。
                return;
            }

            if (!busy)
            {
                return;
            }

            e.Cancel = true;
            DialogResult result = MessageBox.Show(
                this,
                T("CancelConfirmMessage"),
                T("CancelConfirmTitle"),
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (result == DialogResult.Yes)
            {
                application.RequestCancel();
            }
        }

        private string T(string id)
        {
            return localizer.Text(id);
        }

        private static Image LoadImage(string fileName)
        {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            using (Image source = Image.FromFile(Path.Combine(directory, fileName)))
            {
                return new Bitmap(source);
            }
        }

        private static string GetPayloadPath(string fileName)
        {
            return Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), fileName);
        }
    }

    internal static class InstallerPath
    {
        /// <summary>
        /// 目标目录所在卷的可用剩余空间（字节）。目录不存在时按其根盘符查询
        /// （DriveInfo 挂载即可读取）；读不到返回 -1，由调用方决定是否放行。
        /// </summary>
        public static long GetAvailableFreeSpace(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder))
            {
                return -1;
            }

            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(folder.Trim()));
                DriveInfo drive = new DriveInfo(root);
                return drive.IsReady ? drive.AvailableFreeSpace : -1;
            }
            catch
            {
                return -1;
            }
        }

        public static string Normalize(string folder)
        {
            if (string.IsNullOrWhiteSpace(folder))
            {
                return folder;
            }

            try
            {
                string fullPath = Path.GetFullPath(folder.Trim());
                string root = Path.GetPathRoot(fullPath);
                string normalized = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (string.Equals(normalized, root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                {
                    return root;
                }
                return normalized;
            }
            catch
            {
                return folder.Trim();
            }
        }

        public static string AppendDefaultDirectory(string folder)
        {
            string normalized = Normalize(folder);
            if (string.IsNullOrWhiteSpace(normalized))
            {
                return normalized;
            }

            string leaf = Path.GetFileName(normalized.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            return string.Equals(leaf, "opendesk", StringComparison.OrdinalIgnoreCase)
                ? normalized
                : Path.Combine(normalized, "opendesk");
        }

        public static string ResolveInitialDirectory(string folder, bool pathCustomized)
        {
            return pathCustomized ? Normalize(folder) : AppendDefaultDirectory(folder);
        }
    }

    internal sealed class BufferedPanel : Panel
    {
        public BufferedPanel()
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint,
                true
            );
            UpdateStyles();
        }
    }

    internal static class NativeMethods
    {
        private const int WM_SETREDRAW = 0x000B;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wordParameter, IntPtr longParameter);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr window);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentProcessId();

        /// <summary>
        /// 当前前台窗口是否属于本进程（例如我们自己弹的 MessageBox）。
        /// 这种情况下不应该抢前台，否则会把自己的对话框盖掉。
        /// </summary>
        public static bool IsForegroundWindowInCurrentProcess()
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero)
            {
                return false;
            }

            uint processId;
            GetWindowThreadProcessId(foreground, out processId);
            return processId == GetCurrentProcessId();
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process,
            int flags,
            StringBuilder executablePath,
            ref int size
        );

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public static string GetProcessExecutablePath(Process process)
        {
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process.Id);
            if (handle == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                int capacity = 32768;
                StringBuilder executablePath = new StringBuilder(capacity);
                return QueryFullProcessImageName(handle, 0, executablePath, ref capacity)
                    ? executablePath.ToString()
                    : null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        public static void SetRedraw(Control control, bool enabled)
        {
            if (control.IsHandleCreated)
            {
                SendMessage(control.Handle, WM_SETREDRAW, enabled ? new IntPtr(1) : IntPtr.Zero, IntPtr.Zero);
            }
        }

        /// <summary>
        /// 把窗口强行带回前台，返回结束时本窗口是否已成为前台窗口。
        ///
        /// SetForegroundWindow 只在调用线程拥有前台窗口时才生效；UAC 结束后前台归属别的进程
        /// （consent.exe 退出后通常是 explorer 或提权的 companion 进程），直接调用会被系统忽略。
        /// 标准绕法是先用 AttachThreadInput 把本线程的输入队列附加到当前前台窗口所属线程，
        /// 借到前台权限后再 SetForegroundWindow，最后解除附加。
        ///
        /// 不能只看 SetForegroundWindow 的返回值：它在部分场景会返回成功但前台并未真正切换
        /// （例如 UAC 安全桌面仍在，或前台锁定超时未过）。这里以 GetForegroundWindow 的实际
        /// 结果为准，让调用方据此决定是否继续重试。
        /// </summary>
        public static bool ForceForeground(Control control)
        {
            if (!control.IsHandleCreated)
            {
                return false;
            }

            IntPtr handle = control.Handle;
            ShowWindow(handle, SW_RESTORE);

            if (GetForegroundWindow() == handle)
            {
                return true;
            }

            IntPtr foreground = GetForegroundWindow();
            uint currentThreadId = GetCurrentThreadId();
            uint foregroundThreadId = foreground == IntPtr.Zero
                ? 0
                : GetWindowThreadProcessId(foreground, IntPtr.Zero);
            bool attached = foregroundThreadId != 0 &&
                foregroundThreadId != currentThreadId &&
                AttachThreadInput(currentThreadId, foregroundThreadId, true);
            try
            {
                BringWindowToTop(handle);
                SetForegroundWindow(handle);
            }
            finally
            {
                if (attached)
                {
                    AttachThreadInput(currentThreadId, foregroundThreadId, false);
                }
            }

            return GetForegroundWindow() == handle;
        }
    }

    internal sealed class Localizer
    {
        private readonly Dictionary<string, string> strings = new Dictionary<string, string>(StringComparer.Ordinal);

        public Localizer(string localizationPath)
        {
            XNamespace wix = "http://schemas.microsoft.com/wix/2006/localization";
            XDocument document = XDocument.Load(localizationPath);
            foreach (XElement element in document.Root.Elements(wix + "String"))
            {
                XAttribute id = element.Attribute("Id");
                if (id != null)
                {
                    strings[id.Value] = element.Value;
                }
            }
        }

        public string Text(string id)
        {
            string value;
            return strings.TryGetValue(id, out value) ? value : id;
        }
    }
}
