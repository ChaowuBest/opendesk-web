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
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;
using Microsoft.Win32;

namespace OpenDesk.UpdateService
{
    [DataContract]
    internal sealed class PersistedUpdateState
    {
        [DataMember(Name = "lastRequestId")]
        public string LastRequestId { get; set; }

        [DataMember(Name = "status")]
        public string Status { get; set; }

        [DataMember(Name = "code")]
        public string Code { get; set; }

        [DataMember(Name = "targetVersion")]
        public string TargetVersion { get; set; }

        [DataMember(Name = "sha256")]
        public string Sha256 { get; set; }

        [DataMember(Name = "protectedPackagePath")]
        public string ProtectedPackagePath { get; set; }

        [DataMember(Name = "installerExitCode")]
        public int? InstallerExitCode { get; set; }

        [DataMember(Name = "cleanupExitCode")]
        public int? CleanupExitCode { get; set; }

        [DataMember(Name = "message")]
        public string Message { get; set; }

        [DataMember(Name = "healthyVersion")]
        public string HealthyVersion { get; set; }

        [DataMember(Name = "updatedAtUtc")]
        public string UpdatedAtUtc { get; set; }

        public static PersistedUpdateState Idle()
        {
            return new PersistedUpdateState
            {
                Status = "idle",
                Code = "idle",
                UpdatedAtUtc = DateTime.UtcNow.ToString("o")
            };
        }
    }

    internal interface IUpdateStateStore
    {
        PersistedUpdateState Load();
        void Save(PersistedUpdateState state);
    }

    internal sealed class FileUpdateStateStore : IUpdateStateStore
    {
        private readonly string path;

        public FileUpdateStateStore(string path)
        {
            this.path = path;
        }

        public PersistedUpdateState Load()
        {
            try
            {
                if (!File.Exists(path)) return PersistedUpdateState.Idle();
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(PersistedUpdateState));
                using (FileStream stream = File.OpenRead(path))
                {
                    return serializer.ReadObject(stream) as PersistedUpdateState ?? PersistedUpdateState.Idle();
                }
            }
            catch
            {
                return PersistedUpdateState.Idle();
            }
        }

        public void Save(PersistedUpdateState state)
        {
            string directory = Path.GetDirectoryName(path);
            ProtectedDirectory.Ensure(directory);
            string temporaryPath = path + ".tmp";
            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(PersistedUpdateState));
            using (
                FileStream stream = new FileStream(
                    temporaryPath,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.None,
                    4096,
                    FileOptions.WriteThrough
                )
            )
            {
                serializer.WriteObject(stream, state);
                stream.Flush(true);
            }
            if (File.Exists(path)) File.Replace(temporaryPath, path, null);
            else File.Move(temporaryPath, path);
        }
    }

    internal interface IMachineOperationLock : IDisposable
    {
        bool TryAcquire();
        void Release();
    }

    internal sealed class MachineOperationLock : IMachineOperationLock
    {
        private readonly Mutex mutex;
        private bool acquired;

        public MachineOperationLock(string name)
        {
            mutex = new Mutex(false, name);
        }

        public bool TryAcquire()
        {
            if (acquired) return true;
            try
            {
                acquired = mutex.WaitOne(0, false);
            }
            catch (AbandonedMutexException)
            {
                acquired = true;
            }
            return acquired;
        }

        public void Release()
        {
            if (!acquired) return;
            acquired = false;
            mutex.ReleaseMutex();
        }

        public void Dispose()
        {
            Release();
            mutex.Dispose();
        }
    }

    internal interface IInstallerRunner
    {
        int Run(string protectedPackagePath);
    }

    internal sealed class QuietBurnInstallerRunner : IInstallerRunner
    {
        public int Run(string protectedPackagePath)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = protectedPackagePath,
                Arguments = "/quiet /norestart",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(protectedPackagePath)
            };
            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
    }

    internal interface ICleanupRunner
    {
        int Run(string protectedPackagePath);
    }

    internal sealed class QuietBurnCleanupRunner : ICleanupRunner
    {
        public int Run(string protectedPackagePath)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = protectedPackagePath,
                Arguments = "/repair /quiet /norestart CleanupOldVersions=1",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Path.GetDirectoryName(protectedPackagePath)
            };
            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
    }

    internal interface IPostInstallVerifier
    {
        bool Verify(string targetVersion);
    }

    internal sealed class PrototypePostInstallVerifier : IPostInstallVerifier
    {
        public bool Verify(string targetVersion)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey state = root.OpenSubKey(@"SOFTWARE\OpenDesk\SilentUpdatePrototype"))
            {
                string installRoot = state == null ? null : state.GetValue("InstallRoot") as string;
                string activeVersion = state == null ? null : state.GetValue("ActiveVersion") as string;
                if (!string.Equals(activeVersion, targetVersion, StringComparison.Ordinal)) return false;
                if (string.IsNullOrWhiteSpace(installRoot)) return false;
                return File.Exists(Path.Combine(installRoot, "app-" + targetVersion, "opendesk.exe"));
            }
        }
    }

    internal interface IHealthVerifier
    {
        bool Verify(UpdateRequest request, CallerContext caller);
    }

    internal sealed class PrototypeHealthVerifier : IHealthVerifier
    {
        public bool Verify(UpdateRequest request, CallerContext caller)
        {
            if (caller == null || request.ProcessId != caller.ClientProcessId) return false;
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey state = root.OpenSubKey(@"SOFTWARE\OpenDesk\SilentUpdatePrototype"))
                {
                    string installRoot = state == null ? null : state.GetValue("InstallRoot") as string;
                    if (string.IsNullOrWhiteSpace(installRoot)) return false;
                    string expected = Path.GetFullPath(
                        Path.Combine(installRoot, "app-" + request.TargetVersion, "opendesk.exe")
                    );
                    using (Process process = Process.GetProcessById(request.ProcessId))
                    {
                        string actual = NativeProcess.GetExecutablePath(process);
                        return string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch
            {
                return false;
            }
        }
    }

    internal interface IOldVersionProcessWaiter
    {
        bool WaitUntilExited(string targetVersion, TimeSpan timeout);
    }

    internal sealed class PrototypeOldVersionProcessWaiter : IOldVersionProcessWaiter
    {
        public bool WaitUntilExited(string targetVersion, TimeSpan timeout)
        {
            DateTime deadline = DateTime.UtcNow.Add(timeout);
            do
            {
                if (!HasOldVersionProcess(targetVersion)) return true;
                Thread.Sleep(1000);
            }
            while (DateTime.UtcNow < deadline);
            return !HasOldVersionProcess(targetVersion);
        }

        private static bool HasOldVersionProcess(string targetVersion)
        {
            string installRoot = PrototypeInstallState.GetInstallRoot();
            if (string.IsNullOrWhiteSpace(installRoot)) return true;
            string appRoot = Path.GetFullPath(Path.Combine(installRoot, "app-"));
            string targetRoot = Path.GetFullPath(Path.Combine(installRoot, "app-" + targetVersion)) + Path.DirectorySeparatorChar;
            foreach (Process process in Process.GetProcessesByName("opendesk"))
            {
                using (process)
                {
                    try
                    {
                        string executablePath = NativeProcess.GetExecutablePath(process);
                        if (string.IsNullOrWhiteSpace(executablePath)) continue;
                        string fullPath = Path.GetFullPath(executablePath);
                        if (
                            fullPath.StartsWith(appRoot, StringComparison.OrdinalIgnoreCase) &&
                            !fullPath.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase)
                        )
                        {
                            return true;
                        }
                    }
                    catch
                    {
                    }
                }
            }
            return false;
        }
    }

    internal interface IPostCleanupVerifier
    {
        bool Verify(string targetVersion);
    }

    internal sealed class PrototypePostCleanupVerifier : IPostCleanupVerifier
    {
        public bool Verify(string targetVersion)
        {
            string installRoot = PrototypeInstallState.GetInstallRoot();
            if (string.IsNullOrWhiteSpace(installRoot)) return false;
            string targetDirectory = Path.GetFullPath(Path.Combine(installRoot, "app-" + targetVersion));
            if (!File.Exists(Path.Combine(targetDirectory, "opendesk.exe"))) return false;

            foreach (string directory in Directory.GetDirectories(installRoot, "app-*", SearchOption.TopDirectoryOnly))
            {
                if (!string.Equals(Path.GetFullPath(directory), targetDirectory, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey versions = root.OpenSubKey(@"SOFTWARE\OpenDesk\SilentUpdatePrototype\Versions"))
            {
                if (versions == null) return false;
                foreach (string version in versions.GetSubKeyNames())
                {
                    if (!string.Equals(version, targetVersion, StringComparison.Ordinal)) return false;
                }
            }
            return true;
        }
    }

    internal static class PrototypeInstallState
    {
        public static string GetInstallRoot()
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey state = root.OpenSubKey(@"SOFTWARE\OpenDesk\SilentUpdatePrototype"))
            {
                return state == null ? null : state.GetValue("InstallRoot") as string;
            }
        }
    }

    internal interface IBackgroundScheduler
    {
        void Schedule(Action action);
    }

    internal sealed class ThreadBackgroundScheduler : IBackgroundScheduler
    {
        public void Schedule(Action action)
        {
            Thread thread = new Thread(new ThreadStart(action))
            {
                IsBackground = true,
                Name = "OpenDesk old-version cleanup"
            };
            thread.Start();
        }
    }

    internal sealed class UpdateEngine
    {
        private readonly object sync = new object();
        private readonly IUpdatePackageSecurity packageSecurity;
        private readonly IInstallerRunner installerRunner;
        private readonly IPostInstallVerifier postInstallVerifier;
        private readonly IHealthVerifier healthVerifier;
        private readonly ICleanupRunner cleanupRunner;
        private readonly IOldVersionProcessWaiter oldVersionProcessWaiter;
        private readonly IPostCleanupVerifier postCleanupVerifier;
        private readonly IBackgroundScheduler backgroundScheduler;
        private readonly IUpdateStateStore stateStore;
        private readonly IMachineOperationLock operationLock;
        private readonly string protectedPackageRoot;
        private PersistedUpdateState state;

        public UpdateEngine(
            IUpdatePackageSecurity packageSecurity,
            IInstallerRunner installerRunner,
            IPostInstallVerifier postInstallVerifier,
            IHealthVerifier healthVerifier,
            ICleanupRunner cleanupRunner,
            IOldVersionProcessWaiter oldVersionProcessWaiter,
            IPostCleanupVerifier postCleanupVerifier,
            IBackgroundScheduler backgroundScheduler,
            IUpdateStateStore stateStore,
            IMachineOperationLock operationLock,
            string protectedPackageRoot
        )
        {
            this.packageSecurity = packageSecurity;
            this.installerRunner = installerRunner;
            this.postInstallVerifier = postInstallVerifier;
            this.healthVerifier = healthVerifier;
            this.cleanupRunner = cleanupRunner;
            this.oldVersionProcessWaiter = oldVersionProcessWaiter;
            this.postCleanupVerifier = postCleanupVerifier;
            this.backgroundScheduler = backgroundScheduler;
            this.stateStore = stateStore;
            this.operationLock = operationLock;
            this.protectedPackageRoot = protectedPackageRoot;
            state = stateStore.Load() ?? PersistedUpdateState.Idle();
            if (state.Status == "installing")
            {
                state.Status = "failed";
                state.Code = "service_restarted_during_install";
                state.Message = "Previous install did not finish before the service stopped.";
                SaveState();
            }
            else if (state.Status == "cleaning" || state.Status == "cleanup_pending")
            {
                state.Status = "cleanup_failed";
                state.Code = "service_restarted_during_cleanup";
                state.Message = "Previous cleanup did not finish before the service stopped.";
                SaveState();
            }
        }

        public UpdateResponse Handle(UpdateRequest request, CallerContext caller)
        {
            string validationError = UpdateProtocol.Validate(request);
            if (validationError != null) return UpdateResponse.Create(request == null ? null : request.RequestId, "rejected", validationError);
            if (request.Action == UpdateProtocol.QueryStatus) return Snapshot(request.RequestId);
            if (request.Action == UpdateProtocol.ReportHealthy) return RecordHealth(request, caller);

            lock (sync)
            {
                if (string.Equals(state.LastRequestId, request.RequestId, StringComparison.OrdinalIgnoreCase))
                {
                    return Snapshot(request.RequestId);
                }
                if (state.Status == "installing" || state.Status == "cleaning" || state.Status == "cleanup_pending")
                {
                    UpdateResponse busy = Snapshot(request.RequestId);
                    busy.Status = "busy";
                    busy.Code = "install_in_progress";
                    return busy;
                }
                if (!operationLock.TryAcquire())
                {
                    return UpdateResponse.Create(request.RequestId, "busy", "machine_install_lock_busy");
                }
                state = new PersistedUpdateState
                {
                    LastRequestId = request.RequestId,
                    Status = "installing",
                    Code = "installing",
                    TargetVersion = request.TargetVersion,
                    Sha256 = request.Sha256.ToLowerInvariant(),
                    UpdatedAtUtc = DateTime.UtcNow.ToString("o")
                };
                SaveState();
            }

            try
            {
                string protectedPath = packageSecurity.PrepareTrustedPackage(request, caller, protectedPackageRoot);
                lock (sync)
                {
                    state.ProtectedPackagePath = protectedPath;
                    SaveState();
                }
                int exitCode = installerRunner.Run(protectedPath);
                state.InstallerExitCode = exitCode;
                if (exitCode == 3010 || exitCode == 1641)
                {
                    return Finish("failed", "restart_required", "Installer requires a system restart before the update can be used.");
                }
                if (exitCode != 0)
                {
                    return Finish("failed", "installer_failed", "Installer exited with code " + exitCode + ".");
                }
                if (!postInstallVerifier.Verify(request.TargetVersion))
                {
                    return Finish("failed", "post_install_verification_failed", "Installed product state does not match the target version.");
                }
                return Finish("installed", "installed", string.Empty);
            }
            catch (UnauthorizedAccessException exception)
            {
                return Finish("rejected", "package_not_trusted", exception.Message);
            }
            catch (InvalidDataException exception)
            {
                return Finish("rejected", exception.Message, exception.Message);
            }
            catch (Exception exception)
            {
                return Finish("failed", "service_error", exception.Message);
            }
            finally
            {
                operationLock.Release();
            }
        }

        private UpdateResponse RecordHealth(UpdateRequest request, CallerContext caller)
        {
            if (!healthVerifier.Verify(request, caller))
            {
                return UpdateResponse.Create(request.RequestId, "rejected", "health_process_mismatch");
            }
            UpdateResponse response;
            string protectedPackagePath;
            lock (sync)
            {
                if (!string.Equals(state.TargetVersion, request.TargetVersion, StringComparison.Ordinal))
                {
                    return UpdateResponse.Create(request.RequestId, "rejected", "health_not_pending");
                }
                if (state.Status == "cleaned")
                {
                    response = Snapshot(request.RequestId);
                    response.Code = "cleanup_completed";
                    return response;
                }
                if (state.Status == "cleanup_pending" || state.Status == "cleaning")
                {
                    response = Snapshot(request.RequestId);
                    response.Code = "cleanup_in_progress";
                    return response;
                }
                if (state.Status != "installed" && state.Status != "cleanup_failed")
                {
                    return UpdateResponse.Create(request.RequestId, "rejected", "health_not_pending");
                }
                state.HealthyVersion = request.TargetVersion;
                state.Status = "cleanup_pending";
                state.Code = "health_recorded";
                state.Message = string.Empty;
                state.UpdatedAtUtc = DateTime.UtcNow.ToString("o");
                SaveState();
                protectedPackagePath = state.ProtectedPackagePath;
                response = Snapshot(request.RequestId);
                response.Code = "health_recorded";
            }
            backgroundScheduler.Schedule(delegate { RunCleanup(request.TargetVersion, protectedPackagePath); });
            return response;
        }

        private void RunCleanup(string targetVersion, string protectedPackagePath)
        {
            bool acquired = false;
            try
            {
                if (!oldVersionProcessWaiter.WaitUntilExited(targetVersion, TimeSpan.FromMinutes(5)))
                {
                    FinishCleanup("cleanup_failed", "old_version_still_running", "An old OpenDesk process is still running.");
                    return;
                }
                if (!operationLock.TryAcquire())
                {
                    FinishCleanup("cleanup_failed", "machine_install_lock_busy", "Another machine install operation is running.");
                    return;
                }
                acquired = true;
                lock (sync)
                {
                    if (
                        state.Status != "cleanup_pending" ||
                        !string.Equals(state.TargetVersion, targetVersion, StringComparison.Ordinal)
                    )
                    {
                        return;
                    }
                    state.Status = "cleaning";
                    state.Code = "cleaning_old_versions";
                    state.UpdatedAtUtc = DateTime.UtcNow.ToString("o");
                    SaveState();
                }

                if (string.IsNullOrWhiteSpace(protectedPackagePath) || !File.Exists(protectedPackagePath))
                {
                    FinishCleanup("cleanup_failed", "cleanup_package_missing", "The protected update package is unavailable.");
                    return;
                }
                int exitCode = cleanupRunner.Run(protectedPackagePath);
                lock (sync)
                {
                    state.CleanupExitCode = exitCode;
                    SaveState();
                }
                if (exitCode != 0)
                {
                    FinishCleanup("cleanup_failed", "cleanup_installer_failed", "Cleanup installer exited with code " + exitCode + ".");
                    return;
                }
                if (!postCleanupVerifier.Verify(targetVersion))
                {
                    FinishCleanup("cleanup_failed", "post_cleanup_verification_failed", "Old version products or files remain installed.");
                    return;
                }
                FinishCleanup("cleaned", "cleanup_completed", string.Empty);
                try
                {
                    File.Delete(protectedPackagePath);
                }
                catch
                {
                }
            }
            catch (Exception exception)
            {
                FinishCleanup("cleanup_failed", "cleanup_service_error", exception.Message);
            }
            finally
            {
                if (acquired) operationLock.Release();
            }
        }

        private void FinishCleanup(string status, string code, string message)
        {
            lock (sync)
            {
                state.Status = status;
                state.Code = code;
                state.Message = message;
                state.UpdatedAtUtc = DateTime.UtcNow.ToString("o");
                SaveState();
            }
        }

        private UpdateResponse Finish(string status, string code, string message)
        {
            lock (sync)
            {
                state.Status = status;
                state.Code = code;
                state.Message = message;
                state.UpdatedAtUtc = DateTime.UtcNow.ToString("o");
                SaveState();
                return Snapshot(state.LastRequestId);
            }
        }

        private UpdateResponse Snapshot(string requestId)
        {
            lock (sync)
            {
                return new UpdateResponse
                {
                    ProtocolVersion = UpdateProtocol.Version,
                    RequestId = requestId ?? string.Empty,
                    Status = state.Status ?? "idle",
                    Code = state.Code ?? "idle",
                    TargetVersion = state.TargetVersion,
                    InstallerExitCode = state.InstallerExitCode,
                    CleanupExitCode = state.CleanupExitCode,
                    Message = state.Message,
                    UpdatedAtUtc = state.UpdatedAtUtc ?? DateTime.UtcNow.ToString("o")
                };
            }
        }

        private void SaveState()
        {
            stateStore.Save(state);
        }
    }

    internal static class NativeProcess
    {
        private const uint QueryLimitedInformation = 0x1000;

        public static string GetExecutablePath(Process process)
        {
            IntPtr handle = OpenProcess(QueryLimitedInformation, false, process.Id);
            if (handle == IntPtr.Zero) return null;
            try
            {
                int capacity = 32768;
                System.Text.StringBuilder path = new System.Text.StringBuilder(capacity);
                return QueryFullProcessImageName(handle, 0, path, ref capacity) ? path.ToString() : null;
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, int flags, System.Text.StringBuilder path, ref int size);

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
