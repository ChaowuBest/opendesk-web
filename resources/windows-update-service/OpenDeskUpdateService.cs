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
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

[assembly: System.Reflection.AssemblyTitle("OpenDesk Update Service")]
[assembly: System.Reflection.AssemblyCompany("OpenDesk Team, Openharmony")]
[assembly: System.Reflection.AssemblyProduct("OpenDesk Update Service")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace OpenDesk.UpdateService
{
    internal sealed class OpenDeskUpdateWindowsService : ServiceBase
    {
        public const string WindowsServiceName = "OpenDeskUpdateService";
        private UpdatePipeHost host;

        public OpenDeskUpdateWindowsService()
        {
            ServiceName = WindowsServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            host = ServiceComposition.CreateHost();
            host.Start();
        }

        protected override void OnStop()
        {
            if (host != null) host.Stop();
        }

        protected override void OnShutdown()
        {
            OnStop();
            base.OnShutdown();
        }
    }

    internal static class ServiceComposition
    {
        public static UpdatePipeHost CreateHost()
        {
            string dataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "OpenDesk",
                "UpdateService"
            );
            string packages = Path.Combine(dataRoot, "packages");
            string statePath = Path.Combine(dataRoot, "state.json");
            string logPath = Path.Combine(dataRoot, "service.log");
            ProtectedDirectory.Ensure(dataRoot);
            ProtectedDirectory.Ensure(packages);
            UpdateEngine engine = new UpdateEngine(
                // This test release trusts packages from the configured update website. The
                // strict hash and Authenticode implementation remains available for re-enabling.
                new UpdatePackageSecurity(new RegistryTrustPolicy(), new WindowsDirectoryProtector(), false),
                new QuietBurnInstallerRunner(),
                new PrototypePostInstallVerifier(),
                new PrototypeHealthVerifier(),
                new QuietBurnCleanupRunner(),
                new PrototypeOldVersionProcessWaiter(),
                new PrototypePostCleanupVerifier(),
                new ThreadBackgroundScheduler(),
                new FileUpdateStateStore(statePath),
                new MachineOperationLock(@"Global\OpenDeskUpdateService.Install.v1"),
                packages
            );
            return new UpdatePipeHost(engine, logPath);
        }
    }

    internal sealed class UpdatePipeHost
    {
        public const string PipeName = "OpenDesk.UpdateService.v1";
        private readonly UpdateEngine engine;
        private readonly string logPath;
        private readonly object logSync = new object();
        private volatile bool stopping;
        private Thread listener;

        public UpdatePipeHost(UpdateEngine engine, string logPath)
        {
            this.engine = engine;
            this.logPath = logPath;
        }

        public void Start()
        {
            listener = new Thread(ListenLoop) { IsBackground = true, Name = "OpenDesk update pipe listener" };
            listener.Start();
            Log("service_started");
        }

        public void Stop()
        {
            stopping = true;
            try
            {
                using (NamedPipeClientStream wake = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    wake.Connect(250);
                }
            }
            catch
            {
            }
            if (listener != null) listener.Join(2000);
            Log("service_stopped");
        }

        private void ListenLoop()
        {
            while (!stopping)
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = CreatePipe();
                    pipe.WaitForConnection();
                    if (stopping)
                    {
                        pipe.Dispose();
                        break;
                    }
                    NamedPipeServerStream accepted = pipe;
                    pipe = null;
                    ThreadPool.QueueUserWorkItem(delegate { HandleConnection(accepted); });
                }
                catch (Exception exception)
                {
                    if (!stopping) Log("pipe_accept_failed " + exception.Message);
                    if (pipe != null) pipe.Dispose();
                    Thread.Sleep(250);
                }
            }
        }

        private static NamedPipeServerStream CreatePipe()
        {
            PipeSecurity security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(
                new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    PipeAccessRights.FullControl,
                    AccessControlType.Allow
                )
            );
            security.AddAccessRule(
                new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                    PipeAccessRights.FullControl,
                    AccessControlType.Allow
                )
            );
            security.AddAccessRule(
                new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                    PipeAccessRights.ReadWrite,
                    AccessControlType.Allow
                )
            );
            security.AddAccessRule(
                new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                    PipeAccessRights.ReadWrite,
                    AccessControlType.Deny
                )
            );
            return new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                16384,
                16384,
                security
            );
        }

        private void HandleConnection(NamedPipeServerStream pipe)
        {
            using (pipe)
            {
                try
                {
                    CallerContext caller = ResolveCaller(pipe);
                    string json = ReadBoundedLine(pipe);
                    UpdateRequest request = UpdateProtocol.Deserialize(json);
                    UpdateResponse response = engine.Handle(request, caller);
                    Log(
                        "request_completed requestId=" + response.RequestId +
                        " status=" + response.Status +
                        " code=" + response.Code +
                        " installerExitCode=" + (response.InstallerExitCode.HasValue ? response.InstallerExitCode.Value.ToString() : "none")
                    );
                    byte[] payload = Encoding.UTF8.GetBytes(UpdateProtocol.Serialize(response) + "\n");
                    pipe.Write(payload, 0, payload.Length);
                    pipe.Flush();
                }
                catch (Exception exception)
                {
                    Log("request_failed " + exception.Message);
                    try
                    {
                        UpdateResponse response = UpdateResponse.Create(string.Empty, "failed", "pipe_request_failed");
                        byte[] payload = Encoding.UTF8.GetBytes(UpdateProtocol.Serialize(response) + "\n");
                        pipe.Write(payload, 0, payload.Length);
                        pipe.Flush();
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static CallerContext ResolveCaller(NamedPipeServerStream pipe)
        {
            uint clientProcessId;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientProcessId))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            string processSid = CallerIdentityResolver.ResolveProcessSid(unchecked((int)clientProcessId));
            string impersonatedSid = null;
            try
            {
                pipe.RunAsClient(delegate
                {
                    using (WindowsIdentity identity = WindowsIdentity.GetCurrent(true))
                    {
                        impersonatedSid = identity.User == null ? null : identity.User.Value;
                    }
                });
            }
            catch (Exception exception)
            {
                if (
                    !(exception is IOException) &&
                    !(exception is InvalidOperationException) &&
                    !(exception is UnauthorizedAccessException) &&
                    !(exception is System.Security.SecurityException)
                )
                {
                    throw;
                }
            }
            if (
                !string.IsNullOrWhiteSpace(impersonatedSid) &&
                !string.Equals(impersonatedSid, processSid, StringComparison.OrdinalIgnoreCase)
            )
            {
                throw new UnauthorizedAccessException("pipe_client_identity_mismatch");
            }
            return new CallerContext
            {
                Sid = processSid,
                ProfilePath = ResolveProfilePath(processSid),
                ClientProcessId = unchecked((int)clientProcessId)
            };
        }

        private static string ResolveProfilePath(string sid)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (
                RegistryKey profile = root.OpenSubKey(
                    @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid
                )
            )
            {
                string value = profile == null ? null : profile.GetValue("ProfileImagePath") as string;
                return string.IsNullOrWhiteSpace(value) ? null : Environment.ExpandEnvironmentVariables(value);
            }
        }

        private static string ReadBoundedLine(Stream stream)
        {
            UTF8Encoding encoding = new UTF8Encoding(false, true);
            using (StreamReader reader = new StreamReader(stream, encoding, false, 4096, true))
            {
                StringBuilder builder = new StringBuilder();
                while (builder.Length <= UpdateProtocol.MaximumMessageCharacters)
                {
                    int value = reader.Read();
                    if (value < 0 || value == '\n') return builder.ToString().TrimEnd('\r');
                    builder.Append((char)value);
                }
            }
            throw new InvalidDataException("pipe_message_too_large");
        }

        private void Log(string message)
        {
            try
            {
                lock (logSync)
                {
                    File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
                }
            }
            catch
            {
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
    }

    internal static class CallerIdentityResolver
    {
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint TokenQuery = 0x0008;

        public static string ResolveProcessSid(int processId)
        {
            IntPtr processHandle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (processHandle == IntPtr.Zero)
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            try
            {
                IntPtr tokenHandle;
                if (!OpenProcessToken(processHandle, TokenQuery, out tokenHandle))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                try
                {
                    using (WindowsIdentity identity = new WindowsIdentity(tokenHandle))
                    {
                        string sid = identity.User == null ? null : identity.User.Value;
                        if (string.IsNullOrWhiteSpace(sid))
                        {
                            throw new UnauthorizedAccessException("pipe_client_sid_unavailable");
                        }
                        return sid;
                    }
                }
                finally
                {
                    CloseHandle(tokenHandle);
                }
            }
            finally
            {
                CloseHandle(processHandle);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--console" && Environment.UserInteractive)
            {
                UpdatePipeHost host = ServiceComposition.CreateHost();
                ManualResetEvent stopped = new ManualResetEvent(false);
                host.Start();
                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
                {
                    e.Cancel = true;
                    host.Stop();
                    stopped.Set();
                };
                stopped.WaitOne();
                stopped.Dispose();
                return 0;
            }
            ServiceBase.Run(new OpenDeskUpdateWindowsService());
            return 0;
        }
    }
}
