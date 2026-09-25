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
using System.Security.Principal;

namespace Dynobox;

/// <summary>
/// 提权授权（compatible 模式的 allowlist）：以管理员身份把 sandbox SID 的
/// 最小权限 ACE 写入工具链需要访问的系统对象。授权分两类——
///   NTFS/注册表：写入后持久保存，安装一次即可；
///   设备对象（\Device\NamedPipe、\Device\Null）：NPFS/驱动在每次重启时重建
///   DACL，需由登录触发的计划任务（install-logon-task）静默重放。
/// </summary>
internal static class SandboxGrant
{
    /// <summary>当前用户（或 --user-sid 指定的用户）的沙箱 SID。</summary>
    public static string SandboxSidFor(string userSid) => RestrictedTokenSecurity.DeriveSandboxSid(userSid);

    /// <summary>NTFS 目录：向 sandbox SID 授予只读+执行（含子项继承）。</summary>
    private static void GrantDirectoryReadExecute(string path, string sandboxSid)
    {
        var dir = new DirectoryInfo(path);
        var security = dir.GetAccessControl();
        // 自定义 S-1-32 沙箱 SID 无法经 NTAccount 翻译，必须用 SID 形式构造
        var rule = new FileSystemAccessRule(
            new SecurityIdentifier(sandboxSid),
            FileSystemRights.ReadAndExecute | FileSystemRights.ListDirectory,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow);
        security.AddAccessRule(rule);
        dir.SetAccessControl(security);
    }

    /// <summary>注册表根键：向 sandbox SID 授予只读。</summary>
    private static void GrantRegistryRead(Microsoft.Win32.RegistryKey key, string sandboxSid)
    {
        var security = key.GetAccessControl();
        var rule = new RegistryAccessRule(
            new SecurityIdentifier(sandboxSid),
            RegistryRights.ReadKey,
            InheritanceFlags.ContainerInherit,
            PropagationFlags.None,
            AccessControlType.Allow);
        security.AddAccessRule(rule);
        key.SetAccessControl(security);
    }

    /// <summary>安装期授权：NTFS 只读目录 + 注册表只读 + 设备 ACE（NUL/管道根）。
    /// 幂等；重复执行不会产生重复 ACE。</summary>
    public static void Setup(string userSid, IEnumerable<string> extraToolDirectories)
    {
        var sandboxSid = SandboxSidFor(userSid);

        // 系统目录只读执行（受限通道需要：cmd/系统 DLL/框架定位）
        foreach (var dir in new[] { @"C:\Windows", @"C:\Program Files", @"C:\Program Files (x86)" })
            if (Directory.Exists(dir)) GrantDirectoryReadExecute(dir, sandboxSid);

        // 工具链目录（AppData 下的用户级安装也在用户配置范围内只读化）
        foreach (var dir in extraToolDirectories)
            if (Directory.Exists(dir)) GrantDirectoryReadExecute(dir, sandboxSid);

        // 注册表只读（node/msbuild/go 的 SDK 定位与 python 的 site 配置）
        GrantRegistryRead(Microsoft.Win32.Registry.LocalMachine, sandboxSid);
        GrantRegistryRead(Microsoft.Win32.Registry.ClassesRoot, sandboxSid);
        GrantRegistryRead(Microsoft.Win32.Registry.CurrentUser, sandboxSid);
        GrantRegistryRead(Microsoft.Win32.Registry.Users, sandboxSid);

        // 设备对象（NUL 读写 + 管道根建管道）
        NamedPipeAccess.ProvisionForSandboxSid(sandboxSid);
    }

    /// <summary>会话级重放：仅设备对象（NPFS 每次重启重建 DACL）。
    /// 由登录触发的计划任务以最高权限静默执行，无需交互。</summary>
    public static void SessionSetup(string userSid)
    {
        var sandboxSid = SandboxSidFor(userSid);
        NamedPipeAccess.ProvisionForSandboxSid(sandboxSid);
    }

    /// <summary>注册登录触发的计划任务（一次性，需管理员）：</summary>
    public static void InstallLogonTask(string userSid)
    {
        var exe = Environment.ProcessPath ?? throw new InvalidOperationException("无法定位 sandbox.exe");
        var sid = SandboxSidFor(userSid);
        var task = "DynoboxSandboxSessionSetup";
        var action = $"\"{exe}\" pipes-setup --user-sid {userSid}";
        Run("schtasks /Create /F /SC ONLOGON /RL HIGHEST /TN \"" + task + "\" /TR \"" + action + "\"");
        // 立即执行一次，本次会话即生效，无需等待重新登录
        Run("schtasks /Run /TN \"" + task + "\"");
    }

    private static void Run(string command)
    {
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe", "/d /s /c \"" + command + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var proc = System.Diagnostics.Process.Start(start)
            ?? throw new Win32Exception(2);
        if (!proc.WaitForExit(120000)) throw new Win32Exception(1460);
        if (proc.ExitCode != 0) throw new Win32Exception(proc.ExitCode);
    }
}
