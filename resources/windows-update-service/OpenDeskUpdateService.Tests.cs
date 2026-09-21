using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading;

namespace OpenDesk.UpdateService
{
    internal static class UpdateServiceTests
    {
        private static int Main()
        {
            string root = Path.Combine(Path.GetTempPath(), "opendesk-update-service-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                TestProtocol();
                Pass("protocol-validation");
                TestCallerIdentity();
                Pass("caller-identity");
                TestPathPolicy(root);
                Pass("source-path-policy");
                TestTrustAndChecksum(root);
                Pass("protected-trust-required");
                Pass("checksum-mismatch");
                TestTrustedSourceMode(root);
                Pass("trusted-source-mode");
                TestReplay(root);
                Pass("replay-deduplication");
                TestMachineLock();
                Pass("machine-wide-mutex");
                TestExitCodes(root);
                Pass("installer-exit-codes");
                TestHealthGatedCleanup(root);
                Pass("health-gated-cleanup");
                TestCleanupFailureRetry(root);
                Pass("cleanup-failure-retry");
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception);
                return 1;
            }
            finally
            {
                try { Directory.Delete(root, true); } catch { }
            }
        }

        private static void TestProtocol()
        {
            UpdateRequest request = ValidRequest(Guid.NewGuid().ToString());
            Assert(UpdateProtocol.Validate(request) == null, "valid request rejected");
            request.Action = "runShell";
            Assert(UpdateProtocol.Validate(request) == "unsupported_action", "unknown action accepted");
            request = ValidRequest("not-a-guid");
            Assert(UpdateProtocol.Validate(request) == "invalid_request_id", "bad request id accepted");
            request = ValidRequest(Guid.NewGuid().ToString());
            request.Sha256 = "1234";
            Assert(UpdateProtocol.Validate(request) == "invalid_sha256", "bad checksum accepted");
        }

        private static void TestCallerIdentity()
        {
            string expected = WindowsIdentity.GetCurrent().User.Value;
            string actual = CallerIdentityResolver.ResolveProcessSid(Process.GetCurrentProcess().Id);
            Assert(string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase), "process token SID mismatch");
        }

        private static void TestPathPolicy(string root)
        {
            CallerContext caller = CreateCaller(root);
            string cache = UpdatePathPolicy.GetAllowedCacheRoot(caller);
            Directory.CreateDirectory(cache);
            string valid = Path.Combine(cache, "package.exe");
            File.WriteAllText(valid, "package");
            Assert(UpdatePathPolicy.ValidateSourcePath(valid, caller) == Path.GetFullPath(valid), "valid cache path rejected");
            string outside = Path.Combine(root, "outside.exe");
            File.WriteAllText(outside, "outside");
            Expect<InvalidDataException>(delegate { UpdatePathPolicy.ValidateSourcePath(outside, caller); });
        }

        private static void TestTrustAndChecksum(string root)
        {
            CallerContext caller = CreateCaller(root);
            string cache = UpdatePathPolicy.GetAllowedCacheRoot(caller);
            Directory.CreateDirectory(cache);
            string source = Path.Combine(cache, "trusted.exe");
            File.WriteAllText(source, "trusted-package-content");
            string hash = UpdatePackageSecurity.CalculateSha256(source);
            UpdateRequest request = ValidRequest(Guid.NewGuid().ToString());
            request.SourcePath = source;
            request.Sha256 = hash;
            string protectedRoot = Path.Combine(root, "protected-untrusted");
            UpdatePackageSecurity untrusted = new UpdatePackageSecurity(
                new StaticTrustPolicy(false),
                new TestDirectoryProtector()
            );
            Expect<UnauthorizedAccessException>(delegate { untrusted.PrepareTrustedPackage(request, caller, protectedRoot); });

            UpdatePackageSecurity trusted = new UpdatePackageSecurity(
                new StaticTrustPolicy(true),
                new TestDirectoryProtector()
            );
            request.Sha256 = new string('0', 64);
            Expect<InvalidDataException>(delegate
            {
                trusted.PrepareTrustedPackage(request, caller, Path.Combine(root, "protected-bad-hash"));
            });
        }

        private static void TestTrustedSourceMode(string root)
        {
            CallerContext caller = CreateCaller(root);
            string cache = UpdatePathPolicy.GetAllowedCacheRoot(caller);
            Directory.CreateDirectory(cache);
            string source = Path.Combine(cache, "website-package.exe");
            File.WriteAllText(source, "website-package-content");
            UpdateRequest request = ValidRequest(Guid.NewGuid().ToString());
            request.SourcePath = source;
            request.Sha256 = new string('0', 64);
            UpdatePackageSecurity trustedSource = new UpdatePackageSecurity(
                new StaticTrustPolicy(false),
                new TestDirectoryProtector(),
                false
            );

            string prepared = trustedSource.PrepareTrustedPackage(
                request,
                caller,
                Path.Combine(root, "protected-trusted-source")
            );

            Assert(File.Exists(prepared), "trusted source package was not prepared");
            Assert(File.ReadAllText(prepared) == "website-package-content", "trusted source package content changed");
        }

        private static void TestReplay(string root)
        {
            CountingPackageSecurity security = new CountingPackageSecurity(Path.Combine(root, "protected.exe"));
            CountingInstaller runner = new CountingInstaller(0);
            UpdateEngine engine = CreateEngine(root, security, runner, new AcceptingPostVerifier(), "replay");
            UpdateRequest request = ValidRequest(Guid.NewGuid().ToString());
            UpdateResponse first = engine.Handle(request, CreateCaller(root));
            UpdateResponse replay = engine.Handle(request, CreateCaller(root));
            Assert(first.Status == "installed", "first install did not succeed");
            Assert(replay.Status == "installed", "replay did not return final state");
            Assert(security.Count == 1 && runner.Count == 1, "replay executed install twice");
        }

        private static void TestMachineLock()
        {
            string name = @"Global\OpenDeskUpdateService.Test." + Guid.NewGuid().ToString("N");
            using (MachineOperationLock first = new MachineOperationLock(name))
            using (MachineOperationLock second = new MachineOperationLock(name))
            {
                Assert(first.TryAcquire(), "first mutex acquisition failed");
                bool secondAcquiredWhileBusy = true;
                Thread competingThread = new Thread(new ThreadStart(delegate
                {
                    secondAcquiredWhileBusy = second.TryAcquire();
                    if (secondAcquiredWhileBusy) second.Release();
                }));
                competingThread.Start();
                competingThread.Join();
                Assert(!secondAcquiredWhileBusy, "second mutex acquisition was not rejected");
                first.Release();
                bool secondAcquiredAfterRelease = false;
                Thread retryThread = new Thread(new ThreadStart(delegate
                {
                    secondAcquiredAfterRelease = second.TryAcquire();
                    if (secondAcquiredAfterRelease) second.Release();
                }));
                retryThread.Start();
                retryThread.Join();
                Assert(secondAcquiredAfterRelease, "mutex was not released");
            }
        }

        private static void TestExitCodes(string root)
        {
            UpdateRequest rebootRequest = ValidRequest(Guid.NewGuid().ToString());
            UpdateEngine rebootEngine = CreateEngine(
                root,
                new CountingPackageSecurity(Path.Combine(root, "reboot.exe")),
                new CountingInstaller(3010),
                new AcceptingPostVerifier(),
                "reboot"
            );
            UpdateResponse reboot = rebootEngine.Handle(rebootRequest, CreateCaller(root));
            Assert(reboot.Status == "failed" && reboot.Code == "restart_required", "3010 reported as installed");

            UpdateRequest failedRequest = ValidRequest(Guid.NewGuid().ToString());
            UpdateEngine failedEngine = CreateEngine(
                root,
                new CountingPackageSecurity(Path.Combine(root, "failed.exe")),
                new CountingInstaller(5),
                new AcceptingPostVerifier(),
                "failed"
            );
            UpdateResponse failed = failedEngine.Handle(failedRequest, CreateCaller(root));
            Assert(failed.Status == "failed" && failed.Code == "installer_failed", "nonzero exit reported as installed");
        }

        private static void TestHealthGatedCleanup(string root)
        {
            CountingCleanupRunner cleanup = new CountingCleanupRunner(0);
            UpdateEngine engine = CreateEngine(
                root,
                new CountingPackageSecurity(Path.Combine(root, "health.exe")),
                new CountingInstaller(0),
                new AcceptingPostVerifier(),
                "health",
                new AcceptingHealthVerifier(),
                cleanup,
                new AcceptingOldVersionWaiter(),
                new AcceptingCleanupVerifier()
            );
            UpdateRequest premature = HealthRequest("0.3.7");
            UpdateResponse rejected = engine.Handle(premature, CreateCaller(root));
            Assert(rejected.Status == "rejected" && rejected.Code == "health_not_pending", "premature health was accepted");
            Assert(cleanup.Count == 0, "cleanup ran before an installed update");

            UpdateResponse installed = engine.Handle(ValidRequest(Guid.NewGuid().ToString()), CreateCaller(root));
            Assert(installed.Status == "installed", "test update did not install");
            UpdateResponse health = engine.Handle(HealthRequest("0.3.7"), CreateCaller(root));
            Assert(health.Code == "health_recorded", "health was not acknowledged");
            UpdateResponse cleaned = engine.Handle(QueryRequest(), CreateCaller(root));
            Assert(cleaned.Status == "cleaned" && cleaned.Code == "cleanup_completed", "cleanup did not complete");
            Assert(cleanup.Count == 1, "cleanup did not run exactly once");

            engine.Handle(HealthRequest("0.3.7"), CreateCaller(root));
            Assert(cleanup.Count == 1, "repeated health reran completed cleanup");
        }

        private static void TestCleanupFailureRetry(string root)
        {
            SequenceCleanupRunner cleanup = new SequenceCleanupRunner(new[] { 5, 0 });
            UpdateEngine engine = CreateEngine(
                root,
                new CountingPackageSecurity(Path.Combine(root, "retry.exe")),
                new CountingInstaller(0),
                new AcceptingPostVerifier(),
                "cleanup-retry",
                new AcceptingHealthVerifier(),
                cleanup,
                new AcceptingOldVersionWaiter(),
                new AcceptingCleanupVerifier()
            );
            engine.Handle(ValidRequest(Guid.NewGuid().ToString()), CreateCaller(root));
            engine.Handle(HealthRequest("0.3.7"), CreateCaller(root));
            UpdateResponse failed = engine.Handle(QueryRequest(), CreateCaller(root));
            Assert(failed.Status == "cleanup_failed" && failed.Code == "cleanup_installer_failed", "cleanup failure was hidden");
            engine.Handle(HealthRequest("0.3.7"), CreateCaller(root));
            UpdateResponse retried = engine.Handle(QueryRequest(), CreateCaller(root));
            Assert(retried.Status == "cleaned" && cleanup.Count == 2, "failed cleanup was not retried");
        }

        private static UpdateEngine CreateEngine(
            string root,
            IUpdatePackageSecurity security,
            IInstallerRunner runner,
            IPostInstallVerifier verifier,
            string suffix,
            IHealthVerifier healthVerifier = null,
            ICleanupRunner cleanupRunner = null,
            IOldVersionProcessWaiter oldVersionProcessWaiter = null,
            IPostCleanupVerifier cleanupVerifier = null
        )
        {
            return new UpdateEngine(
                security,
                runner,
                verifier,
                healthVerifier ?? new RejectingHealthVerifier(),
                cleanupRunner ?? new CountingCleanupRunner(0),
                oldVersionProcessWaiter ?? new AcceptingOldVersionWaiter(),
                cleanupVerifier ?? new AcceptingCleanupVerifier(),
                new InlineBackgroundScheduler(),
                new MemoryStateStore(),
                new TestOperationLock(),
                Path.Combine(root, "packages-" + suffix)
            );
        }

        private static CallerContext CreateCaller(string root)
        {
            return new CallerContext { Sid = "S-1-5-21-test", ProfilePath = Path.Combine(root, "profile"), ClientProcessId = 123 };
        }

        private static UpdateRequest ValidRequest(string requestId)
        {
            return new UpdateRequest
            {
                ProtocolVersion = 1,
                RequestId = requestId,
                Action = UpdateProtocol.SubmitUpdate,
                TargetVersion = "0.3.7",
                SourcePath = @"C:\Users\test\AppData\Roaming\opendesk\Cache\package.exe",
                Sha256 = new string('a', 64)
            };
        }

        private static UpdateRequest HealthRequest(string version)
        {
            return new UpdateRequest
            {
                ProtocolVersion = 1,
                RequestId = Guid.NewGuid().ToString(),
                Action = UpdateProtocol.ReportHealthy,
                TargetVersion = version,
                ProcessId = 123
            };
        }

        private static UpdateRequest QueryRequest()
        {
            return new UpdateRequest
            {
                ProtocolVersion = 1,
                RequestId = Guid.NewGuid().ToString(),
                Action = UpdateProtocol.QueryStatus
            };
        }

        private static void Assert(bool value, string message)
        {
            if (!value) throw new InvalidOperationException(message);
        }

        private static void Expect<T>(Action action) where T : Exception
        {
            try
            {
                action();
            }
            catch (T)
            {
                return;
            }
            throw new InvalidOperationException("Expected " + typeof(T).Name);
        }

        private static void Pass(string name)
        {
            Console.WriteLine("PASS " + name);
        }

        private sealed class StaticTrustPolicy : ITrustPolicy
        {
            private readonly bool trusted;
            public StaticTrustPolicy(bool trusted) { this.trusted = trusted; }
            public bool IsTrusted(string version, string sha256, string protectedPath) { return trusted; }
        }

        private sealed class TestDirectoryProtector : IDirectoryProtector
        {
            public void Ensure(string path) { Directory.CreateDirectory(path); }
        }

        private sealed class CountingPackageSecurity : IUpdatePackageSecurity
        {
            private readonly string result;
            public int Count { get; private set; }
            public CountingPackageSecurity(string result) { this.result = result; }
            public string PrepareTrustedPackage(UpdateRequest request, CallerContext caller, string protectedPackageRoot)
            {
                Count += 1;
                string directory = Path.GetDirectoryName(result);
                if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
                if (!File.Exists(result)) File.WriteAllText(result, "test-package");
                return result;
            }
        }

        private sealed class CountingInstaller : IInstallerRunner
        {
            private readonly int exitCode;
            public int Count { get; private set; }
            public CountingInstaller(int exitCode) { this.exitCode = exitCode; }
            public int Run(string protectedPackagePath) { Count += 1; return exitCode; }
        }

        private sealed class AcceptingPostVerifier : IPostInstallVerifier
        {
            public bool Verify(string targetVersion) { return true; }
        }

        private sealed class RejectingHealthVerifier : IHealthVerifier
        {
            public bool Verify(UpdateRequest request, CallerContext caller) { return false; }
        }

        private sealed class AcceptingHealthVerifier : IHealthVerifier
        {
            public bool Verify(UpdateRequest request, CallerContext caller) { return true; }
        }

        private sealed class CountingCleanupRunner : ICleanupRunner
        {
            private readonly int exitCode;
            public int Count { get; private set; }
            public CountingCleanupRunner(int exitCode) { this.exitCode = exitCode; }
            public int Run(string protectedPackagePath) { Count += 1; return exitCode; }
        }

        private sealed class SequenceCleanupRunner : ICleanupRunner
        {
            private readonly int[] exitCodes;
            public int Count { get; private set; }
            public SequenceCleanupRunner(int[] exitCodes) { this.exitCodes = exitCodes; }
            public int Run(string protectedPackagePath)
            {
                int index = Math.Min(Count, exitCodes.Length - 1);
                Count += 1;
                return exitCodes[index];
            }
        }

        private sealed class AcceptingOldVersionWaiter : IOldVersionProcessWaiter
        {
            public bool WaitUntilExited(string targetVersion, TimeSpan timeout) { return true; }
        }

        private sealed class AcceptingCleanupVerifier : IPostCleanupVerifier
        {
            public bool Verify(string targetVersion) { return true; }
        }

        private sealed class InlineBackgroundScheduler : IBackgroundScheduler
        {
            public void Schedule(Action action) { action(); }
        }

        private sealed class MemoryStateStore : IUpdateStateStore
        {
            private PersistedUpdateState state = PersistedUpdateState.Idle();
            public PersistedUpdateState Load() { return state; }
            public void Save(PersistedUpdateState value) { state = value; }
        }

        private sealed class TestOperationLock : IMachineOperationLock
        {
            private bool acquired;
            public bool TryAcquire() { if (acquired) return false; acquired = true; return true; }
            public void Release() { acquired = false; }
            public void Dispose() { }
        }
    }
}
