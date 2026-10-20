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
using System.Reflection;

/// <summary>
/// 重写 MSI Summary Information 的 Template（PID_TEMPLATE）属性。
///
/// WiX v3 的 candle -arch 只能为一个包生成单一平台词（x64 / ARM64 / Intel），
/// 而 Windows Installer 在安装时要求 Template 平台列表包含目标系统平台，
/// 否则以 1633（ERROR_INSTALL_PLATFORM_UNSUPPORTED）拒绝。x64 安装包需要
/// 同样能装进 ARM64 Windows（应用本体由系统兼容层模拟运行），因此构建期把
/// Template 改写为多平台列表（如 "x64,ARM64;1033"）。Template 列表本身就
/// 支持逗号分隔多平台，这里只做一次属性重写并持久化。
/// </summary>
internal static class SetMsiTemplate
{
    private const int PidTemplate = 7;

    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: SetMsiTemplate <msi-path> <template>");
            return 87;
        }

        Type installerType = Type.GetTypeFromProgID("WindowsInstaller.Installer");
        object installer = Activator.CreateInstance(installerType);
        object summary = installerType.InvokeMember(
            "SummaryInformation",
            BindingFlags.GetProperty,
            null,
            installer,
            new object[] { args[0], 1 }
        );
        Type summaryType = summary.GetType();
        object current = summaryType.InvokeMember(
            "Property",
            BindingFlags.GetProperty,
            null,
            summary,
            new object[] { PidTemplate }
        );
        summaryType.InvokeMember(
            "Property",
            BindingFlags.SetProperty,
            null,
            summary,
            new object[] { PidTemplate, args[1] }
        );
        summaryType.InvokeMember("Persist", BindingFlags.InvokeMethod, null, summary, null);
        Console.WriteLine("Template: {0} -> {1}", current, args[1]);
        return 0;
    }
}
