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
using System.Diagnostics;
using Microsoft.Win32;

internal static class CleanupPrototypeInstallations
{
    private const string MarkerKey = @"SOFTWARE\OpenDesk\SilentUpdatePrototype\CleanupAgentV2";
    private const string LegacyMarkerKey = @"SOFTWARE\OpenDesk\SilentUpdatePrototype\CleanupAgent";
    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string PrototypeSuffix = "(silent-update prototype)";

    private static int Main(string[] args)
    {
        if (args.Length == 1 && String.Equals(args[0], "--register", StringComparison.OrdinalIgnoreCase))
        {
            // V1 marker 会使旧 bundle 在作为 related bundle 卸载时运行 --uninstall-all，
            // 进而误删刚由新 bundle 接管的 MSI。新代理启用独立标记，并在登记前从
            // 两个注册表视图清掉 V1 标记，让旧 bundle 只注销自身依赖关系。
            RegistryView[] legacyViews = { RegistryView.Registry64, RegistryView.Registry32 };
            foreach (RegistryView view in legacyViews)
            {
                using (RegistryKey legacyRoot = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                {
                    legacyRoot.DeleteSubKeyTree(LegacyMarkerKey, false);
                }
            }

            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey key = root.CreateSubKey(MarkerKey))
            {
                key.SetValue("Installed", 1, RegistryValueKind.DWord);
            }
            return 0;
        }

        if (args.Length != 1 || !String.Equals(args[0], "--uninstall-all", StringComparison.OrdinalIgnoreCase))
        {
            return 87;
        }

        int result = UninstallAllPrototypeProducts();
        if (result == 0)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            {
                root.DeleteSubKeyTree(MarkerKey, false);
            }
        }
        return result;
    }

    private static int UninstallAllPrototypeProducts()
    {
        List<string> productCodes = new List<string>();
        RegistryView[] views = { RegistryView.Registry64, RegistryView.Registry32 };
        foreach (RegistryView view in views)
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
            using (RegistryKey uninstall = root.OpenSubKey(UninstallKey))
            {
                if (uninstall == null) continue;
                foreach (string keyName in uninstall.GetSubKeyNames())
                {
                    Guid productCode;
                    if (!Guid.TryParse(keyName, out productCode)) continue;
                    using (RegistryKey product = uninstall.OpenSubKey(keyName))
                    {
                        string displayName = product == null ? null : product.GetValue("DisplayName") as string;
                        if (String.IsNullOrWhiteSpace(displayName) ||
                            !displayName.EndsWith(PrototypeSuffix, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                    }

                    string normalized = productCode.ToString("B").ToUpperInvariant();
                    if (!productCodes.Contains(normalized)) productCodes.Add(normalized);
                }
            }
        }

        foreach (string productCode in productCodes)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = "msiexec.exe",
                Arguments = "/x " + productCode + " /qn /norestart IGNOREDEPENDENCIES=ALL",
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                if (process.ExitCode != 0 && process.ExitCode != 1605 && process.ExitCode != 3010)
                {
                    return process.ExitCode;
                }
            }
        }
        return 0;
    }
}
