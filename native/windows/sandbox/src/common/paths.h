/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
#pragma once

#include <string>
#include <vector>

namespace sbx {

// 宿主真实路径 -> 策略虚拟路径（/C/...）的映射表条目。
struct RootMap {
    std::wstring virtualPrefix;  // 虚拟前缀，如 /C（保证为 / 开头，'/' 结尾则去掉）
    std::wstring realPrefix;     // 宿主真实前缀，如 C:\（保证为绝对路径）
};

// 归一化策略里写到的路径形态：反斜杠转正斜杠、去尾 '/'、保证以 '/' 开头。
std::wstring normalizeVirtualPath(const std::wstring& raw);

// 归一化宿主真实路径：相对路径按进程 CWD 展开为绝对路径、展开绝对路径中的
// ..、去 ' \\?\'/' \\?\UNC\' 前缀、去尾点与尾空格、8.3 短名转长名（可选）。
// 返回 false 表示路径不可用。不做磁盘 IO（除短名转换），可在任意线程调用。
bool normalizeHostPath(const std::wstring& raw, std::wstring& out);

// 在 roots 中找 realPrefix 最长匹配，把宿主绝对路径映射为虚拟路径。
// 命中返回 true 并写 vpath（以 '/' 开头）；未命中任何 root 返回 false
// （调用方按"沙箱内不存在"语义处理：not-found）。
bool mapHostToVirtual(const std::wstring& hostPath, const std::vector<RootMap>& roots,
                       std::wstring& vpath);

// 虚拟路径反查（调试/回收站日志用）：找到包含该虚拟路径的 root 并还原宿主路径。
bool mapVirtualToHost(const std::wstring& vpath, const std::vector<RootMap>& roots,
                      std::wstring& hostPath);

// 将 `\\?\GLOBALROOT\Device\HarddiskVolumeN\...` 设备命名空间路径转换为等价盘符路径
// （`\\?\GLOBALROOT\Device\HarddiskVolume3\foo` -> `C:\foo`）。非 GLOBALROOT 卷路径
// 返回 false（原样调用方处理）。用于拦截经设备命名空间绕过 roots 映射的访问。
bool mapGlobalRootToDrive(const std::wstring& path, std::wstring& drivePath);

} // namespace sbx
