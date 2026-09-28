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

using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Dynobox;

/// <summary>
/// 命名管道放通：Windows 禁止 AppContainer 进程在 \Device\NamedPipe 全局命名
/// 空间创建管道（根目录 DACL 不含 package SID 可匹配的 ACE），tsx CLI 等
/// 依赖管道 IPC 的工具在沙箱内必然失败。这里在管道根目录上为 dynobox 的
/// 每用户 package SID（按盘符派生，与 LoopbackAccess 同一套稳定身份）追加
/// FILE_CREATE_PIPE_INSTANCE | FILE_TRAVERSE ACE——只放行 OpenDesk 沙箱身份，
/// 不影响其他应用。设备对象的 DACL 在系统重启后随 NPFS 重建而恢复默认，
/// 因此每次会话由 pipes-ensure 重新检查并按需提权。
/// </summary>
internal static class NamedPipeAccess
{
    private const uint FileCreatePipeInstance = 0x0004;
    private const uint FileTraverse = 0x0020;
    // \Device\Null：FILE_GENERIC_READ | FILE_GENERIC_WRITE。
    // Go/cargo 工具链会在构建中打开 NUL 设备（go 的 VCS stamp、cargo 的
    // Stdio::null），其 DACL 缺少 AppContainer 可匹配的 ACE，导致沙箱内
    // "open NUL: Access is denied"，表现为构建无法拉起任何子进程。
    private const uint NullDeviceAccess = 0x12019F;
    // \Device\NamedPipe 根目录：与 Everyone 现有授权（0x1201BF）对齐。AppContainer
    // 的访问门要求 package SID 的 ACE 覆盖 CreateNamedPipe 请求的全部位——实际
    // 请求不止 FILE_CREATE_PIPE_INSTANCE|FILE_TRAVERSE，还含 READ_CONTROL/
    // SYNCHRONIZE 等；只授 0x24 时门检查仍然拒绝（winerror 5）。
    private const uint PipeRootAccess = 0x1201BF;
    private const uint ReadControl = 0x00020000;
    private const uint WriteDac = 0x00040000;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint LabelSecurityInformation = 0x00000008;
    private const uint ERROR_INVALID_PARAMETER = 87;

    private const string PipeRootPath = "\\\\.\\pipe";
    private const string NullDevicePath = "\\\\.\\NUL";

    /// <summary>与 LoopbackAccess 共用同一套按盘符派生的 package SID
    /// （单一实现，避免两处派生逻辑漂移）。</summary>
    public static string[] ProfileSids(string userSid) => LoopbackAccess.ProfileSids(userSid);

    private static IntPtr OpenObject(string path, uint desiredAccess, uint flags = 0)
    {
        // NUL 设备不接受 FILE_FLAG_BACKUP_SEMANTICS（返回 ERROR_INVALID_PARAMETER），
        // 管道根目录不接受缺省标志（ERROR_ACCESS_DENIED），因此由调用方区分。
        var handle = CreateFileW(path, desiredAccess, 7 /* read|write|delete share */,
            IntPtr.Zero, 3 /* OPEN_EXISTING */, flags, IntPtr.Zero);
        if (handle == new IntPtr(-1)) return IntPtr.Zero;
        return handle;
    }

    private static byte[] ReadSecurityDescriptor(IntPtr handle) =>
        ReadSecurityDescriptor(handle, DaclSecurityInformation);

    private static byte[] ReadSecurityDescriptor(IntPtr handle, uint sections)
    {
        var buffer = new byte[4096];
        while (!GetKernelObjectSecurity(handle, sections, buffer, (uint)buffer.Length, out var needed))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != 122 /* ERROR_INSUFFICIENT_BUFFER */ || needed > 1 << 20)
                throw new Win32Exception(error);
            buffer = new byte[needed];
        }
        return buffer;
    }

    /// <summary>判断 DACL 二进制是否已包含对指定 SID 的、覆盖 mask 全部位面的
    /// Allow ACE。ACL 头为 8 字节：[0]=revision、[2..3]=AclSize、[4..5]=AceCount、
    /// [6..7]=sbz2，ACE 从偏移 8 开始。内核对象的 GetSddlForm 在只读取 DACL 段时
    /// 返回空串（即使 DACL 含多条 ACE），且当前引用面缺少 CommonAce 构造所需的
    /// AceRevision 类型，因此判断与追加都直接基于 ACL 二进制。</summary>
    private static bool HasAce(byte[] aclBinary, byte[] sidBinary, uint mask)
    {
        var aceCount = aclBinary[4] | (aclBinary[5] << 8);
        var offset = 8;
        for (var i = 0; i < aceCount; i++)
        {
            var size = aclBinary[offset + 2] | (aclBinary[offset + 3] << 8);
            if (aclBinary[offset] == 0 /* ACCESS_ALLOWED_ACE_TYPE */ && size >= 8 + sidBinary.Length)
            {
                var aceMask = BitConverter.ToUInt32(aclBinary, offset + 4);
                if ((aceMask & mask) == mask && EqualsSid(aclBinary, offset + 8, sidBinary))
                    return true;
            }
            offset += size;
        }
        return false;
    }

    private static bool EqualsSid(byte[] ace, int offset, byte[] sidBinary)
    {
        if (offset + sidBinary.Length > ace.Length) return false;
        for (var i = 0; i < sidBinary.Length; i++)
            if (ace[offset + i] != sidBinary[i]) return false;
        return true;
    }

    /// <summary>在 ACL 二进制末尾追加一条 ACCESS_ALLOWED ACE（幂等由调用方
    /// 保证）。必须同时更新头部的 AclSize（[2..3]，新缓冲总长）与 AceCount
    /// （[4..5]）；二者错位会导致内核静默忽略整段 DACL。</summary>
    private static byte[] AppendAce(byte[] aclBinary, uint mask, byte[] sidBinary)
    {
        var aceSize = 8 + sidBinary.Length;
        var result = new byte[aclBinary.Length + aceSize];
        Buffer.BlockCopy(aclBinary, 0, result, 0, aclBinary.Length);
        var aclSize = result.Length;
        var aceCount = (aclBinary[4] | (aclBinary[5] << 8)) + 1;
        result[2] = (byte)aclSize;
        result[3] = (byte)(aclSize >> 8);
        result[4] = (byte)aceCount;
        result[5] = (byte)(aceCount >> 8);
        var offset = aclBinary.Length;
        result[offset] = 0;   // ACCESS_ALLOWED_ACE_TYPE
        result[offset + 1] = 0;   // AceFlags
        result[offset + 2] = (byte)aceSize;
        result[offset + 3] = (byte)(aceSize >> 8);
        Buffer.BlockCopy(BitConverter.GetBytes(mask), 0, result, offset + 4, sizeof(uint));
        Buffer.BlockCopy(sidBinary, 0, result, offset + 8, sidBinary.Length);
        return result;
    }

    private static byte[] SidBinary(string sid)
    {
        var identifier = new SecurityIdentifier(sid);
        var binary = new byte[identifier.BinaryLength];
        identifier.GetBinaryForm(binary, 0);
        return binary;
    }

    private static bool IsObjectConfigured(string path, string[] sids, uint mask)
    {
        // NUL 设备拒绝"仅 READ_CONTROL"的打开（ERROR_FILE_NOT_FOUND），必须
        // 携带 GENERIC_READ 才能拿到含 READ_CONTROL 的句柄读 DACL。
        var handle = OpenObject(path, ReadControl | 0x80000000u /* GENERIC_READ */, ObjectFlags(path));
        if (handle == IntPtr.Zero) return false;   // 读不到按未配置处理，交给提权路径
        try
        {
            var descriptor = new RawSecurityDescriptor(ReadSecurityDescriptor(handle), 0);
            if (descriptor.DiscretionaryAcl is not { } dacl) return false;
            var binary = new byte[dacl.BinaryLength];
            dacl.GetBinaryForm(binary, 0);
            return sids.All(sid => HasAce(binary, SidBinary(sid), mask));
        }
        finally { CloseHandle(handle); }
    }

    /// <summary>设备映射名各自的打开标志：管道根是目录需要 FILE_FLAG_BACKUP_SEMANTICS，
    /// NUL 设备则恰好相反（见 OpenObject）。</summary>
    private static uint ObjectFlags(string path) =>
        path == PipeRootPath ? 0x02000000u : 0u;

    internal static bool IsConfigured(string userSid)
    {
        var sids = ProfileSids(userSid);
        return IsObjectConfigured(PipeRootPath, sids, PipeRootAccess)
            && IsObjectConfigured(NullDevicePath, sids, NullDeviceAccess);
    }

    /// <summary>compatible 模式：对给定沙箱 SID 授予设备访问（NUL 读写 +
    /// 管道根建管道）。见 SandboxGrant 的授权说明。</summary>
    public static void ProvisionForSandboxSid(string sandboxSid)
    {
        ProvisionAces(PipeRootPath, new[] { sandboxSid }, PipeRootAccess);
        ProvisionAces(NullDevicePath, new[] { sandboxSid }, NullDeviceAccess);
    }

    /// <summary>向对象 DACL 追加缺失的 package SID Allow ACE（幂等）。直接在
    /// ACL 二进制上追加并整段写回，保留原有 ACE 顺序与语义。</summary>
    private static void ProvisionAces(string path, string[] sids, uint mask)
    {
        var handle = OpenObject(path, ReadControl | WriteDac, ObjectFlags(path));
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var descriptor = new RawSecurityDescriptor(ReadSecurityDescriptor(handle), 0);
            if (descriptor.DiscretionaryAcl is not { } dacl)
                throw new Win32Exception(unchecked((int)ERROR_INVALID_PARAMETER));   // 无 DACL 时无法安全追加
            var binary = new byte[dacl.BinaryLength];
            dacl.GetBinaryForm(binary, 0);
            var changed = false;
            foreach (var sid in sids)
            {
                var sidBinary = SidBinary(sid);
                if (HasAce(binary, sidBinary, mask)) continue;
                binary = AppendAce(binary, mask, sidBinary);
                changed = true;
            }
            if (!changed) return;
            descriptor.DiscretionaryAcl = new RawAcl(binary, 0);
            var updated = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(updated, 0);
            if (!SetKernelObjectSecurity(handle, DaclSecurityInformation, updated))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { CloseHandle(handle); }
    }

    internal static void Configure(string userSid)
    {
        var sids = ProfileSids(userSid);
        ProvisionAces(PipeRootPath, sids, PipeRootAccess);
        ProvisionAces(NullDevicePath, sids, NullDeviceAccess);
    }

    // 这些命令返回与 network-* 一致的 JSON 协议；OpenDesk 宿主负责本地化错误。
    public static int Run(string operation, string[] args)
    {
        try
        {
            var userSid = LoopbackAccess.CurrentUserSid;
            if (operation == "pipes-setup")
            {
                if (args.Length != 2 || args[0] != "--user-sid") throw new Win32Exception(87);
                userSid = new SecurityIdentifier(args[1]).Value;
                Configure(userSid);
            }
            else if (args.Length != 0) throw new Win32Exception(87);

            if (operation == "pipes-ensure" && !IsConfigured(userSid))
            {
                // 只提升这条有界的配置命令，绝不提升沙箱管理器、shell、
                // 权限端点或用户命令（与 network-ensure 同一原则）。
                var start = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath!)
                {
                    UseShellExecute = true,
                    Verb = "runas",
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                };
                start.ArgumentList.Add("pipes-setup");
                start.ArgumentList.Add("--user-sid");
                start.ArgumentList.Add(userSid);
                using var setup = System.Diagnostics.Process.Start(start) ?? throw new Win32Exception(2);
                if (!setup.WaitForExit(120000)) throw new Win32Exception(1460);
                if (setup.ExitCode != 0) throw new Win32Exception(setup.ExitCode);
            }
            var configured = IsConfigured(userSid);
            Console.WriteLine(JsonSerializer.Serialize(new { configured }));
            return 0;
        }
        catch (Exception error)
        {
            var code = error is Win32Exception native ? native.NativeErrorCode : error.HResult;
            Console.Error.WriteLine(error.ToString());
            // 提权子进程以隐藏窗口运行，stderr 不可见；落一份错误明细供诊断。
            if (operation == "pipes-setup")
            {
                try
                {
                    File.WriteAllText(
                        Path.Combine(Path.GetTempPath(), "dynobox-pipes-setup-error.log"),
                        error.ToString());
                }
                catch { /* 诊断兜底失败不影响主流程 */ }
            }
            Console.WriteLine(JsonSerializer.Serialize(new { configured = false, errorCode = code }));
            return code == 0 ? 1 : code;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint desiredAccess, uint shareMode,
        IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetKernelObjectSecurity(IntPtr handle, uint sections,
        byte[] descriptor, uint length, out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetKernelObjectSecurity(IntPtr handle, uint sections, byte[] descriptor);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
