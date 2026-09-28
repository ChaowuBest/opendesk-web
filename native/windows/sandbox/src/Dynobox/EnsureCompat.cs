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
using System.Text.Json;

namespace Dynobox;

/// <summary>
/// 沙箱兼容性统一入口：把回环放行（network-setup）和命名管道放通（pipes-setup）
/// 合并为一次管理员确认。由 OpenDesk 宿主在启动时或切换沙箱设置时调用一次，
/// 后续同一次开机内的沙箱运行不再弹窗。
/// </summary>
internal static class EnsureCompat
{
    public static int Run(string[] args)
    {
        try
        {
            var userSid = LoopbackAccess.CurrentUserSid;

            var needLoopback = !LoopbackAccess.IsConfigured(userSid);
            var needPipes = !NamedPipeAccess.IsConfigured(userSid);

            if (needLoopback || needPipes)
            {
                var start = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath!)
                {
                    UseShellExecute = true,
                    Verb = "runas",
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                };
                start.ArgumentList.Add("setup-all");
                start.ArgumentList.Add("--user-sid");
                start.ArgumentList.Add(userSid);
                using var setup = System.Diagnostics.Process.Start(start)
                    ?? throw new Win32Exception(2);
                if (!setup.WaitForExit(120000)) throw new Win32Exception(1460);
                if (setup.ExitCode != 0) throw new Win32Exception(setup.ExitCode);
            }

            var loopbackOk = LoopbackAccess.IsConfigured(userSid);
            var pipesOk = NamedPipeAccess.IsConfigured(userSid);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                configured = loopbackOk && pipesOk,
                loopback = loopbackOk,
                pipes = pipesOk,
            }));
            return 0;
        }
        catch (Exception ex)
        {
            var code = ex is Win32Exception native ? native.NativeErrorCode : ex.HResult;
            Console.Error.WriteLine(ex.Message);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                configured = false,
                errorCode = code,
            }));
            return code == 0 ? 1 : code;
        }
    }
}
