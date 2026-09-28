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

namespace Dynobox;

/// <summary>
/// 运行时预载 shim 的统一注册表。沙箱对个别运行时生态的兼容手段是统一的：
/// 往引导区写一份补丁资产，再把引导目录（或资产文件）注入该运行时的
/// "预载钩子"环境变量。新增一个运行时的兼容支持 = 在 All 表里加一条记录，
/// 不需要改动 Runner。
///
///   Node.js   NODE_OPTIONS --require  → fs.native realpath 纯 JS 回退
///   Python    PYTHONPATH 引导目录     → sitecustomize 重定向 os.devnull
/// </summary>
internal static class RuntimePreload
{
    public sealed class Shim
    {
        /// <summary>用于日志的补丁标识。</summary>
        public required string Id { get; init; }
        /// <summary>写入引导区的资产文件名。</summary>
        public required string FileName { get; init; }
        /// <summary>资产内容（补丁源码）。</summary>
        public required string Content { get; init; }
        /// <summary>注入目标环境变量。</summary>
        public required string EnvVar { get; init; }
        /// <summary>注入到现有值前面（路径列表语义）还是后面（开关附加语义）。</summary>
        public required bool Prepend { get; init; }
        /// <summary>引用资产时使用的开关前缀（如 Node 的 "--require "）。</summary>
        public required string ArgumentPrefix { get; init; }
    }

    private const char PathSeparator = ';';

    public static readonly Shim[] All =
    [
        new Shim
        {
            Id = "node-realpath",
            FileName = "node-realpath-patch.cjs",
            Content = RuntimeCompatibility.NodeRealpathPatch,
            EnvVar = "NODE_OPTIONS",
            Prepend = false,
            ArgumentPrefix = "--require ",
        },
        new Shim
        {
            Id = "python-devnull",
            FileName = "sitecustomize.py",
            Content = RuntimeCompatibility.PythonDevnullPatch,
            EnvVar = "PYTHONPATH",
            Prepend = true,
            ArgumentPrefix = "",
        },
    ];

    public static void InjectAll(
        string bootstrapDirectory,
        string virtualBootstrapDirectory,
        IDictionary<string, string> envVars,
        Action<string, Exception> onFailure)
    {
        foreach (var shim in All)
        {
            try
            {
                var assetPath = Path.Combine(bootstrapDirectory, shim.FileName);
                if (!File.Exists(assetPath)) File.WriteAllText(assetPath, shim.Content);

                var virtualAsset = virtualBootstrapDirectory
                    + Path.DirectorySeparatorChar + shim.FileName;
                var hasExisting = envVars.TryGetValue(shim.EnvVar, out var existing)
                    && existing.Length > 0;
                envVars[shim.EnvVar] = shim.Prepend
                    ? (hasExisting
                        ? virtualBootstrapDirectory + PathSeparator + existing
                        : virtualBootstrapDirectory)
                    : (hasExisting
                        ? existing + " " + shim.ArgumentPrefix + virtualAsset
                        : shim.ArgumentPrefix + virtualAsset);
            }
            catch (Exception ex)
            {
                onFailure(shim.Id, ex);
            }
        }
    }
}
