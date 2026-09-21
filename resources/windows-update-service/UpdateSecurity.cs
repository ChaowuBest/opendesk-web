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
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using Microsoft.Win32;

namespace OpenDesk.UpdateService
{
    internal sealed class CallerContext
    {
        public string Sid { get; set; }
        public string ProfilePath { get; set; }
        public int ClientProcessId { get; set; }
    }

    internal interface ITrustPolicy
    {
        bool IsTrusted(string version, string sha256, string protectedPath);
    }

    internal sealed class RegistryTrustPolicy : ITrustPolicy
    {
        private const string TrustKey = @"SOFTWARE\OpenDesk\UpdateService";

        public bool IsTrusted(string version, string sha256, string protectedPath)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey key = root.OpenSubKey(TrustKey))
            {
                object signerValue = key == null ? null : key.GetValue("TrustedSignerThumbprints");
                string[] signerThumbprints = signerValue as string[];
                if (signerThumbprints == null && signerValue is string)
                {
                    signerThumbprints = new[] { (string)signerValue };
                }
                return AuthenticodeVerifier.HasTrustedSignature(protectedPath, signerThumbprints);
            }
        }
    }

    internal static class UpdatePathPolicy
    {
        public static string GetAllowedCacheRoot(CallerContext caller)
        {
            if (caller == null || string.IsNullOrWhiteSpace(caller.ProfilePath)) return null;
            return Path.GetFullPath(Path.Combine(caller.ProfilePath, "AppData", "Roaming", "opendesk", "Cache"));
        }

        public static string ValidateSourcePath(string sourcePath, CallerContext caller)
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !Path.IsPathRooted(sourcePath))
            {
                throw new InvalidDataException("source_path_not_absolute");
            }
            string fullPath = Path.GetFullPath(sourcePath);
            string root = GetAllowedCacheRoot(caller);
            if (string.IsNullOrWhiteSpace(root)) throw new InvalidDataException("caller_profile_unavailable");
            string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!fullPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("source_path_outside_user_cache");
            }
            if (!string.Equals(Path.GetExtension(fullPath), ".exe", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("source_path_not_executable_package");
            }
            if (!File.Exists(fullPath)) throw new FileNotFoundException("source_package_missing", fullPath);

            string current = fullPath;
            while (!string.Equals(current, root, StringComparison.OrdinalIgnoreCase))
            {
                FileAttributes attributes = File.GetAttributes(current);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    throw new InvalidDataException("source_path_contains_reparse_point");
                }
                current = Path.GetDirectoryName(current);
                if (string.IsNullOrWhiteSpace(current)) throw new InvalidDataException("source_path_parent_invalid");
            }
            if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException("source_cache_is_reparse_point");
            }
            return fullPath;
        }
    }

    internal interface IUpdatePackageSecurity
    {
        string PrepareTrustedPackage(UpdateRequest request, CallerContext caller, string protectedPackageRoot);
    }

    internal interface IDirectoryProtector
    {
        void Ensure(string path);
    }

    internal sealed class WindowsDirectoryProtector : IDirectoryProtector
    {
        public void Ensure(string path)
        {
            ProtectedDirectory.Ensure(path);
        }
    }

    internal sealed class UpdatePackageSecurity : IUpdatePackageSecurity
    {
        private readonly ITrustPolicy trustPolicy;
        private readonly IDirectoryProtector directoryProtector;
        private readonly bool enforcePackageVerification;

        public UpdatePackageSecurity(ITrustPolicy trustPolicy)
            : this(trustPolicy, new WindowsDirectoryProtector(), true)
        {
        }

        public UpdatePackageSecurity(ITrustPolicy trustPolicy, IDirectoryProtector directoryProtector)
            : this(trustPolicy, directoryProtector, true)
        {
        }

        public UpdatePackageSecurity(
            ITrustPolicy trustPolicy,
            IDirectoryProtector directoryProtector,
            bool enforcePackageVerification
        )
        {
            this.trustPolicy = trustPolicy;
            this.directoryProtector = directoryProtector;
            this.enforcePackageVerification = enforcePackageVerification;
        }

        public string PrepareTrustedPackage(UpdateRequest request, CallerContext caller, string protectedPackageRoot)
        {
            string sourcePath = UpdatePathPolicy.ValidateSourcePath(request.SourcePath, caller);
            directoryProtector.Ensure(protectedPackageRoot);
            string versionDirectory = Path.Combine(protectedPackageRoot, request.TargetVersion);
            directoryProtector.Ensure(versionDirectory);
            string temporaryPath = Path.Combine(versionDirectory, ".tmp-" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                string actualHash;
                using (
                    FileStream input = new FileStream(
                        sourcePath,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.Read,
                        1024 * 1024,
                        FileOptions.SequentialScan
                    )
                )
                using (
                    FileStream output = new FileStream(
                        temporaryPath,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        1024 * 1024,
                        FileOptions.WriteThrough
                    )
                )
                using (SHA256 hash = SHA256.Create())
                {
                    byte[] buffer = new byte[1024 * 1024];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                        hash.TransformBlock(buffer, 0, read, buffer, 0);
                    }
                    hash.TransformFinalBlock(new byte[0], 0, 0);
                    output.Flush(true);
                    actualHash = ToHex(hash.Hash);
                }

                if (
                    enforcePackageVerification &&
                    !string.Equals(actualHash, request.Sha256, StringComparison.OrdinalIgnoreCase)
                )
                {
                    throw new InvalidDataException("package_checksum_mismatch");
                }
                if (enforcePackageVerification && !trustPolicy.IsTrusted(request.TargetVersion, actualHash, temporaryPath))
                {
                    throw new UnauthorizedAccessException("package_not_in_protected_trust_policy");
                }
                string finalPath = Path.Combine(versionDirectory, actualHash + ".exe");
                if (File.Exists(finalPath)) File.Delete(finalPath);
                File.Move(temporaryPath, finalPath);
                return finalPath;
            }
            catch
            {
                try { if (File.Exists(temporaryPath)) File.Delete(temporaryPath); } catch { }
                throw;
            }
        }

        internal static string CalculateSha256(string path)
        {
            using (FileStream stream = File.OpenRead(path))
            using (SHA256 hash = SHA256.Create())
            {
                return ToHex(hash.ComputeHash(stream));
            }
        }

        private static string ToHex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
        }
    }

    internal static class ProtectedDirectory
    {
        public static void Ensure(string path)
        {
            Directory.CreateDirectory(path);
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(
                new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow
                )
            );
            security.AddAccessRule(
                new FileSystemAccessRule(
                    new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                    FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None,
                    AccessControlType.Allow
                )
            );
            Directory.SetAccessControl(path, security);
        }
    }

    internal static class AuthenticodeVerifier
    {
        private static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        private const int CertificateUntrustedRoot = unchecked((int)0x800B0109);

        public static bool HasTrustedSignature(string path, IEnumerable<string> trustedThumbprints)
        {
            int verificationResult = VerifyEmbeddedSignature(path);
            // 测试发布证书按指纹固定在 OpenDesk 自己的受保护配置中，不加入 Windows
            // 全局根证书库。WinVerifyTrust 因此只允许“签名完整但根不受系统信任”这一种
            // 链错误；摘要损坏、证书过期、用途错误等其他结果仍全部拒绝。
            if (
                trustedThumbprints == null ||
                (verificationResult != 0 && verificationResult != CertificateUntrustedRoot)
            )
            {
                return false;
            }
            try
            {
                X509Certificate certificate = X509Certificate.CreateFromSignedFile(path);
                X509Certificate2 certificate2 = new X509Certificate2(certificate);
                string actual = NormalizeThumbprint(certificate2.Thumbprint);
                foreach (string trusted in trustedThumbprints)
                {
                    if (string.Equals(actual, NormalizeThumbprint(trusted), StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            catch
            {
            }
            return false;
        }

        private static string NormalizeThumbprint(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? string.Empty : value.Replace(" ", string.Empty).Trim();
        }

        private static int VerifyEmbeddedSignature(string path)
        {
            WinTrustFileInfo fileInfo = new WinTrustFileInfo(path);
            WinTrustData data = new WinTrustData(fileInfo);
            return WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, data);
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern int WinVerifyTrust(IntPtr window, [MarshalAs(UnmanagedType.LPStruct)] Guid action, WinTrustData data);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private sealed class WinTrustFileInfo
        {
            public int StructureSize = Marshal.SizeOf(typeof(WinTrustFileInfo));
            public string FilePath;
            public IntPtr FileHandle = IntPtr.Zero;
            public IntPtr KnownSubject = IntPtr.Zero;

            public WinTrustFileInfo(string path)
            {
                FilePath = path;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private sealed class WinTrustData
        {
            public int StructureSize = Marshal.SizeOf(typeof(WinTrustData));
            public IntPtr PolicyCallbackData = IntPtr.Zero;
            public IntPtr SipClientData = IntPtr.Zero;
            public int UiChoice = 2;
            public int RevocationChecks = 0;
            public int UnionChoice = 1;
            public IntPtr FileInfo;
            public int StateAction = 0;
            public IntPtr StateData = IntPtr.Zero;
            public string UrlReference = null;
            public int ProviderFlags = 0x1000;
            public int UiContext = 0;

            public WinTrustData(WinTrustFileInfo fileInfo)
            {
                FileInfo = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                Marshal.StructureToPtr(fileInfo, FileInfo, false);
            }

            ~WinTrustData()
            {
                if (FileInfo != IntPtr.Zero) Marshal.FreeCoTaskMem(FileInfo);
            }
        }
    }
}
