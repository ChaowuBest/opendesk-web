/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Dynobox;

/// <summary>
/// compatible 模式的沙箱安全上下文：受限令牌 + 显式 ACL 白名单。
///
/// 与 AppContainer 的差别：内核访问检查仍是标准双通道（普通 DACL 检查 AND
/// 受限 SID 检查），没有 lowbox 额外策略。效果是——
///   - 沙箱 SID 没有被授权的对象（如 C:/D: 上的用户数据）完全不可访问；
///   - 授予了 sandbox SID ACE 的对象（管道根、NUL、我们的卷）天然可用，
///     不受各版本 lowbox 策略差异影响（管道/NUL 的兼容补丁因此可以退役）。
///
/// 允许清单（安装时一次授权，见 SandboxGrant）：
///   C:\Windows、C:\Program Files*、工具链目录      只读+执行
///   HKLM/HKCR/HKCU 注册表                          只读
///   \Device\NamedPipe 根                           建管道
///   \Device\Null                                   读写
///   \BaseNamedObjects                              创建命名对象
///   用户数据目录                                   刻意不授权（隔离边界）
/// </summary>
public sealed class RestrictedTokenSecurity : IDisposable, ISandboxSecurity
{
    private const string SandboxAuthority = "S-1-32";   // NT non-unique authority

    private IntPtr _token;
    private string? _sandboxSid;
    private uint _hideMask;

    public bool UsesAppContainer => false;

    /// <summary>从当前用户 SID 确定性派生的沙箱 SID：同一用户每次运行相同，
    /// 安装期写入的 ACL 因此跨运行、跨重启保持有效。</summary>
    public string SandboxSid => _sandboxSid ?? throw new InvalidOperationException("受限令牌尚未初始化");

    public void Prepare(string? profileName = null)
    {
        if (_token != IntPtr.Zero) return;

        var userSid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("无法取得当前用户 SID");
        _sandboxSid = DeriveSandboxSid(userSid);

        // restricting 列表 = [Everyone, sandbox SID]：受限通道按这两个 SID 求
        // DACL 授权——Everyone 已有的授权（系统目录读执行、NUL 读写、管道根
        // 建管道）天然可用，无需任何机器级授权/UAC；用户数据写操作因
        // Everyone/沙箱 SID 均无写 ACE 而继续被拒绝（读放开为该模型已知取舍）。
        if (!OpenProcessToken(GetCurrentProcess(),
                TokenDuplicate | TokenQuery | TokenAssignPrimary, out var baseToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken 失败");
        try
        {
            _token = CreateRestricted(baseToken, SandboxSid);
            Log.Info("[SEC] 已构造受限令牌（restricting=[Everyone,{0}]，特权已全部移除）", SandboxSid);
        }
        finally { CloseHandle(baseToken); }
    }

    /// <summary>S-1-32-{4 个取自用户 SID 哈希的子授权}：确定性派生，跨运行稳定。</summary>
    internal static string DeriveSandboxSid(string userSid)
    {
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(userSid)));
        uint Part(int i)
        {
            var bytes = Convert.FromHexString(hash.Substring(i * 8, 8));
            return BitConverter.ToUInt32(bytes, 0) & 0x3FFFFFFFu | 0x40000000u;   // 避免子授权为 0
        }
        return $"{SandboxAuthority}-{Part(0)}-{Part(1)}-{Part(2)}-{Part(3)}";
    }

    /// <summary>DISABLE_MAX_PRIVILEGE 移除全部特权（保留无害的
    /// SeChangeNotifyPrivilege），并加入唯一的 restricting SID。</summary>
    private static IntPtr CreateRestricted(IntPtr baseToken, string sandboxSid)
    {
        // restricting 列表 = [Everyone, sandbox SID]（见 Prepare 注释）
        var sids = new[] { "S-1-1-0", sandboxSid };
        var entrySize = Marshal.SizeOf<SidAndAttributes>();
        var sidBytes = sids.Select(s =>
        {
            var identifier = new SecurityIdentifier(s);
            var bytes = new byte[identifier.BinaryLength];
            identifier.GetBinaryForm(bytes, 0);
            return bytes;
        }).ToArray();

        var restrictBuffer = Marshal.AllocHGlobal(entrySize * sids.Length + sidBytes.Sum(b => b.Length));
        try
        {
            var ptr = restrictBuffer + entrySize * sids.Length;
            for (var i = 0; i < sids.Length; i++)
            {
                Marshal.WriteIntPtr(restrictBuffer, i * entrySize, ptr);
                Marshal.WriteInt32(restrictBuffer, i * entrySize + 8, 0x2 /* SE_GROUP_ENABLED */);
                Marshal.Copy(sidBytes[i], 0, ptr, sidBytes[i].Length);
                ptr += sidBytes[i].Length;
            }

            const uint DISABLE_MAX_PRIVILEGE = 0x1;
            if (!CreateRestrictedToken(baseToken, DISABLE_MAX_PRIVILEGE,
                    0, IntPtr.Zero, 0, IntPtr.Zero,
                    (uint)sids.Length, restrictBuffer, out var restricted))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateRestrictedToken 失败");
            return restricted;
        }
        finally { Marshal.FreeHGlobal(restrictBuffer); }
    }

    /// <summary>卷安全描述符：SYSTEM、当前用户与 sandbox SID 全权——卷是我们
    /// 自己的内核对象，无需提权即可设置。</summary>
    public byte[] CreateVolumeSecurityDescriptor()
    {
        Prepare();
        var userSid = WindowsIdentity.GetCurrent().User?.Value
            ?? throw new InvalidOperationException("无法取得当前用户 SID");
        var raw = new RawSecurityDescriptor(
            $"D:(A;;GA;;;SY)(A;;GA;;;{userSid})(A;;GA;;;{SandboxSid})");
        var bytes = new byte[16384];
        raw.GetBinaryForm(bytes, 0);
        return bytes;
    }

    public int VolumeSecurityDescriptorLength
    {
        get
        {
            Prepare();
            var userSid = WindowsIdentity.GetCurrent().User?.Value
                ?? throw new InvalidOperationException("无法取得当前用户 SID");
            var raw = new RawSecurityDescriptor(
                $"D:(A;;GA;;;SY)(A;;GA;;;{userSid})(A;;GA;;;{SandboxSid})");
            return raw.BinaryLength;
        }
    }

    /// <summary>受限主令牌：CreateProcessAsUserW 直接使用（同用户派生令牌，
    /// 不需要 SE_ASSIGNPRIMARYTOKEN 特权）。</summary>
    /// <summary>AppContainer 专用能力，restricted 模式不支持。</summary>
    public T WithPackageSid<T>(Func<IntPtr, T> action) =>
        throw new NotSupportedException("restricted-token 模式不使用 package SID");

    public IntPtr OpenBaseToken()
    {
        Prepare();
        return _token;
    }

    public void HideDriveLetter(char letter)
    {
        try
        {
            var bit = 1u << (char.ToUpperInvariant(letter) - 'A');
            _hideMask |= bit;
            using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(NoDrivesKey);
            key.SetValue("NoDrives", _hideMask, Microsoft.Win32.RegistryValueKind.DWord);
            Log.Info("[SEC] 已隐藏盘符 {0}:（NoDrives 策略位）", char.ToUpperInvariant(letter));
        }
        catch (Exception ex)
        {
            Log.Warn("[SEC] 隐藏盘符失败（不影响功能）: {0}", ex.Message);
            _hideMask = 0;
        }
    }

    public void RestoreDriveLetters()
    {
        if (_hideMask == 0) return;
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(NoDrivesKey, writable: true);
            if (key is not null && key.GetValue("NoDrives") is int v)
            {
                var cleared = v & ~(int)_hideMask;
                if (cleared == 0)
                    key.DeleteValue("NoDrives", throwOnMissingValue: false);
                else if (cleared != v)
                    key.SetValue("NoDrives", cleared, Microsoft.Win32.RegistryValueKind.DWord);
            }
        }
        catch { }
        finally { _hideMask = 0; }
    }

    public void Dispose()
    {
        RestoreDriveLetters();
        if (_token != IntPtr.Zero)
        {
            CloseHandle(_token);
            _token = IntPtr.Zero;
        }
    }

    private const string NoDrivesKey =
        @"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer";
    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAssignPrimary = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess,
        out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr tokenHandle, uint infoClass,
        IntPtr information, uint length, out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr baseToken, uint flags,
        uint disableSidCount, IntPtr sidsToDisable,
        uint deletePrivilegeCount, IntPtr privilegesToDelete,
        uint restrictedSidCount, IntPtr sidsToRestrict,
        out IntPtr newTokenHandle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
