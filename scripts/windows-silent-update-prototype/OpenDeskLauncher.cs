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
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Reflection;
using Microsoft.Win32;

[assembly: AssemblyTitle("OpenDesk")]
[assembly: AssemblyDescription("OpenDesk stable version launcher")]
[assembly: AssemblyCompany("OpenDesk Team, Openharmony")]
[assembly: AssemblyProduct("OpenDesk")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class OpenDeskLauncher
{
    private const string StateKey = @"SOFTWARE\OpenDesk\SilentUpdatePrototype";

    [STAThread]
    private static int Main(string[] args)
    {
        string[] forwardedArguments = WaitForPreviousProcess(args);
        using (RegistryKey key = Registry.LocalMachine.OpenSubKey(StateKey, false))
        {
            string installRoot = key == null ? null : key.GetValue("InstallRoot") as string;
            string activeVersion = key == null ? null : key.GetValue("ActiveVersion") as string;
            if (String.IsNullOrWhiteSpace(installRoot) || String.IsNullOrWhiteSpace(activeVersion))
            {
                return 2;
            }

            string executablePath = Path.Combine(installRoot, "app-" + activeVersion, "opendesk.exe");
            if (!File.Exists(executablePath))
            {
                return 3;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = executablePath,
                Arguments = String.Join(" ", Array.ConvertAll(forwardedArguments, QuoteArgument)),
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(executablePath)
            });
            return 0;
        }
    }

    private static string[] WaitForPreviousProcess(string[] args)
    {
        if (args.Length < 2 || !String.Equals(args[0], "--wait-for-pid", StringComparison.OrdinalIgnoreCase))
        {
            return args;
        }

        int processId;
        if (Int32.TryParse(args[1], out processId) && processId > 0)
        {
            try
            {
                using (Process previous = Process.GetProcessById(processId))
                {
                    previous.WaitForExit(120000);
                }
            }
            catch (ArgumentException)
            {
                // The old process already exited before the launcher started waiting.
            }
        }

        string[] remaining = new string[Math.Max(0, args.Length - 2)];
        if (remaining.Length > 0) Array.Copy(args, 2, remaining, 0, remaining.Length);
        return remaining;
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }

        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char value in argument)
        {
            if (value == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (value == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(value);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
