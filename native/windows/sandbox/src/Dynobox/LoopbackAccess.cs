/**
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
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Dynobox;

internal static class LoopbackAccess
{
    public static string CurrentUserSid => WindowsIdentity.GetCurrent().User!.Value;

    public static string ProfileName(string userSid, char letter)
    {
        var canonical = new SecurityIdentifier(userSid).Value;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))[..24].ToLowerInvariant();
        return $"dynobox-{hash}-{char.ToLowerInvariant(letter)}";
    }

    private static string[] ProfileSids(string userSid)
    {
        var result = new List<string>();
        for (var letter = 'A'; letter <= 'Z'; letter++)
        {
            var hr = DeriveAppContainerSidFromAppContainerName(ProfileName(userSid, letter), out var sid);
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            try { result.Add(new SecurityIdentifier(sid).Value); }
            finally { FreeSid(sid); }
        }
        return result.ToArray();
    }

    private static HashSet<string> ReadConfiguredSids()
    {
        var error = NetworkIsolationGetAppContainerConfig(out var count, out var entries);
        if (error != 0) throw new Win32Exception((int)error);
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var size = Marshal.SizeOf<SidAndAttributes>();
        try
        {
            for (var i = 0; i < count; i++)
            {
                var entry = Marshal.PtrToStructure<SidAndAttributes>(entries + i * size);
                result.Add(new SecurityIdentifier(entry.Sid).Value);
            }
        }
        finally
        {
            // NetworkIsolationGetAppContainerConfig allocates each SID and the
            // array separately on the process heap (see the Windows SDK sample).
            for (var i = 0; i < count; i++)
                HeapFree(GetProcessHeap(), 0, Marshal.ReadIntPtr(entries + i * size));
            if (entries != IntPtr.Zero) HeapFree(GetProcessHeap(), 0, entries);
        }
        return result;
    }

    private static bool IsConfigured(string userSid) => ProfileSids(userSid).All(ReadConfiguredSids().Contains);

    private static void Configure(string userSid)
    {
        using var gate = new Mutex(false, @"Global\OpenDesk.Dynobox.LoopbackSetup");
        try { if (!gate.WaitOne(30000)) throw new Win32Exception(1460); }
        catch (AbandonedMutexException) { }
        try
        {
            // NetworkIsolationSetAppContainerConfig 会整机替换免除列表，进程内
            // 自行做"读-合并-写"时与并发写入的其他应用存在丢失更新竞态。改用
            // 微软官方的 CheckNetIsolation.exe 逐条追加（-a -p=<SID>），条目的
            // 合并交给系统工具处理；互斥量只用于串行化本组进程的重复配置。
            var checkNetIsolation = Path.Combine(Environment.SystemDirectory, "CheckNetIsolation.exe");
            foreach (var sid in ProfileSids(userSid))
            {
                var start = new ProcessStartInfo(checkNetIsolation)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    ArgumentList = { "LoopbackExempt", "-a", "-p=" + sid }
                };
                using var setup = Process.Start(start) ?? throw new Win32Exception(2);
                if (!setup.WaitForExit(30000)) throw new Win32Exception(1460);
                if (setup.ExitCode != 0) throw new Win32Exception(setup.ExitCode);
            }
            if (!IsConfigured(userSid)) throw new Win32Exception(5);
        }
        finally { gate.ReleaseMutex(); }
    }

    // These commands return a JSON protocol; the OpenDesk host localizes errors.
    public static int Run(string operation, string[] args)
    {
        try
        {
            var userSid = CurrentUserSid;
            if (operation == "network-setup")
            {
                if (args.Length != 2 || args[0] != "--user-sid") throw new Win32Exception(87);
                userSid = new SecurityIdentifier(args[1]).Value;
                Configure(userSid);
            }
            else if (args.Length != 0) throw new Win32Exception(87);

            if (operation == "network-ensure" && !IsConfigured(userSid))
            {
                // Elevate only the bounded configuration command, never the
                // sandbox manager, shell, permission endpoint or user command.
                var start = new ProcessStartInfo(Environment.ProcessPath!)
                {
                    UseShellExecute = true,
                    Verb = "runas",
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                start.ArgumentList.Add("network-setup");
                start.ArgumentList.Add("--user-sid");
                start.ArgumentList.Add(userSid);
                using var setup = Process.Start(start) ?? throw new Win32Exception(2);
                if (!setup.WaitForExit(120000)) throw new Win32Exception(1460);
                if (setup.ExitCode != 0) throw new Win32Exception(setup.ExitCode);
                if (!IsConfigured(userSid)) throw new Win32Exception(5);
            }
            Console.WriteLine(JsonSerializer.Serialize(new { configured = IsConfigured(userSid), userSid }));
            return 0;
        }
        catch (Exception error)
        {
            var code = error is Win32Exception native ? native.NativeErrorCode : error.HResult;
            Console.WriteLine(JsonSerializer.Serialize(new { configured = false, errorCode = code }));
            return code == 0 ? 1 : code;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("Firewallapi.dll", ExactSpelling = true)]
    private static extern uint NetworkIsolationGetAppContainerConfig(out uint count, out IntPtr entries);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr GetProcessHeap();

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool HeapFree(IntPtr heap, uint flags, IntPtr memory);
}
