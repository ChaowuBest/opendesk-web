/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32;

namespace Dynobox;

/// <summary>沙箱安全上下文：盘符隐藏（NoDrives 策略位，HKCU，无需管理员）。</summary>
public sealed class SandboxSecurity : IDisposable
{
    private const string NoDrivesKey =
        @"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
    private uint _hideMask;
    private string? _profileName;
    private string? _packageSid;

    /// <summary>
    /// Prepares a per-run Windows AppContainer identity.  The child process is
    /// started with this token; an AppContainer has no access to ordinary user
    /// files unless the target volume explicitly grants its package SID.
    /// </summary>
    public void PrepareAppContainer()
    {
        if (_packageSid is not null) return;

        _profileName = "dynobox-" + Guid.NewGuid().ToString("N");
        var hr = CreateAppContainerProfile(_profileName, _profileName,
            "dynobox per-run file-system sandbox", IntPtr.Zero, 0, out var sid);
        if (hr != 0 && hr != HResultAlreadyExists)
            Marshal.ThrowExceptionForHR(hr);
        if (sid == IntPtr.Zero)
        {
            hr = DeriveAppContainerSidFromAppContainerName(_profileName, out sid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        }

        try
        {
            if (!ConvertSidToStringSid(sid, out var sidText) || sidText == IntPtr.Zero)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法转换 AppContainer SID");
            try { _packageSid = Marshal.PtrToStringUni(sidText); }
            finally { LocalFree(sidText); }
        }
        finally
        {
            FreeSid(sid);
        }

        Log.Info("[SEC] 已准备 AppContainer（SID={0}）", _packageSid);
    }

    public string PackageSid => _packageSid
        ?? throw new InvalidOperationException("AppContainer 尚未初始化");

    /// <summary>Security descriptor for the Dokan volume: SYSTEM, owner and
    /// the per-run AppContainer package SID only.</summary>
    public byte[] CreateVolumeSecurityDescriptor()
    {
        PrepareAppContainer();
        var userSid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("无法取得当前用户 SID");
        var sddl = $"D:(A;;GA;;;SY)(A;;GA;;;{userSid})(A;;GA;;;{PackageSid})";
        var raw = new RawSecurityDescriptor(sddl);
        // DokanNet 2.3 marshals this field as a ByValArray with SizeConst=16384.
        // Return the fixed-size buffer and let VolumeSecurityDescriptorLength
        // tell Dokan how many bytes contain the descriptor.
        var bytes = new byte[16384];
        raw.GetBinaryForm(bytes, 0);
        return bytes;
    }

    public int VolumeSecurityDescriptorLength
    {
        get
        {
            PrepareAppContainer();
            var userSid = WindowsIdentity.GetCurrent().User?.Value
                ?? throw new InvalidOperationException("无法取得当前用户 SID");
            var raw = new RawSecurityDescriptor(
                $"D:(A;;GA;;;SY)(A;;GA;;;{userSid})(A;;GA;;;{PackageSid})");
            return raw.BinaryLength;
        }
    }

    /// <summary>Fallback helper for callers that need to apply only the DACL
    /// after mounting. Normal runs pass the descriptor through Dokan options.</summary>
    public void ApplyVolumeAcl(string mountPoint)
    {
        PrepareAppContainer();
        var userSid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("无法取得当前用户 SID");
        var raw = new RawSecurityDescriptor(
            $"D:(A;;GA;;;SY)(A;;GA;;;{userSid})(A;;GA;;;{PackageSid})");
        var acl = new byte[raw.DiscretionaryAcl!.BinaryLength];
        raw.DiscretionaryAcl.GetBinaryForm(acl, 0);
        var pAcl = Marshal.AllocHGlobal(acl.Length);
        try
        {
            Marshal.Copy(acl, 0, pAcl, acl.Length);
            var rc = SetNamedSecurityInfo(mountPoint, SeFileObject,
                DaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, pAcl, IntPtr.Zero);
            if (rc != 0 && mountPoint.Length >= 2 && mountPoint[1] == ':')
            {
                var device = @"\\." + mountPoint[..2];
                rc = SetNamedSecurityInfo(device, SeFileObject,
                    DaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, pAcl, IntPtr.Zero);
                if (rc != 0)
                {
                    var h = CreateFile(device, ReadControl | WriteDac,
                        FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
                    if (h != InvalidHandleValue)
                    {
                        rc = SetSecurityInfo(h, SeFileObject,
                            DaclSecurityInformation, IntPtr.Zero, IntPtr.Zero, pAcl, IntPtr.Zero);
                        CloseHandle(h);
                    }
                }
            }
            if (rc != 0) throw new Win32Exception((int)rc, $"设置沙箱卷 DACL 失败 (Win32={rc})");
            Log.Info("[SEC] 已将沙箱卷 DACL 收窄到当前用户与 AppContainer");
        }
        finally { Marshal.FreeHGlobal(pAcl); }
    }

    /// <summary>Open the manager's primary token for CreateProcessAsUserW.</summary>
    public IntPtr OpenBaseToken()
    {
        PrepareAppContainer();
        if (!OpenProcessToken(GetCurrentProcess(),
                TokenQuery | TokenDuplicate | TokenAssignPrimary | TokenAdjustDefault |
                TokenAdjustSessionId, out var baseToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken 失败");

        return baseToken;
    }

    /// <summary>Runs an action while holding a valid native package SID.</summary>
    public T WithPackageSid<T>(Func<IntPtr, T> action)
    {
        PrepareAppContainer();
        var hr = DeriveAppContainerSidFromAppContainerName(_profileName!, out var sid);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        try { return action(sid); }
        finally { FreeSid(sid); }
    }

    public void HideDriveLetter(char letter)
    {
        try
        {
            var bit = 1u << (char.ToUpperInvariant(letter) - 'A');
            _hideMask |= bit;
            using var key = Registry.CurrentUser.CreateSubKey(NoDrivesKey);
            key.SetValue("NoDrives", _hideMask, RegistryValueKind.DWord);
            Log.Info("[SEC] 已隐藏盘符 {0}:（NoDrives 策略位）", char.ToUpperInvariant(letter));
        }
        catch (Exception ex)
        {
            Log.Warn("[SEC] 隐藏盘符失败（不影响功能）: {0}", ex.Message);
            _hideMask = 0; // 失败时重置，避免 Unmount 时误删
        }
    }

    public void RestoreDriveLetters()
    {
        if (_hideMask == 0) return;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(NoDrivesKey, writable: true);
            if (key is not null && key.GetValue("NoDrives") is uint v && (v & _hideMask) == _hideMask)
                key.DeleteValue("NoDrives", throwOnMissingValue: false);
        }
        catch { }
        finally
        {
            _hideMask = 0;
        }
    }

    public void Dispose()
    {
        RestoreDriveLetters();
        if (_profileName is not null)
        {
            try { DeleteAppContainerProfile(_profileName); } catch { }
            _profileName = null;
            _packageSid = null;
        }
    }

    private const int HResultAlreadyExists = unchecked((int)0x800700B7);
    private const uint TokenQuery = 0x0008;
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenAssignPrimary = 0x0001;
    private const uint TokenAdjustDefault = 0x0080;
    private const uint TokenAdjustSessionId = 0x0100;
    private const uint SeFileObject = 1;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint FileShareRead = 1;
    private const uint FileShareWrite = 2;
    private const uint OpenExisting = 3;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string appContainerName, string displayName, string description,
        IntPtr capabilities, uint capabilityCount, out IntPtr appContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string appContainerName, out IntPtr appContainerSid);






    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(string appContainerName);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess,
        out IntPtr tokenHandle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfo(
        string objectName, uint objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(
        IntPtr handle, uint objectType, uint securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
