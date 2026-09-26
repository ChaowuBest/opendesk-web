/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */

// Linux dynobox 沙箱的架构 ↔ Rust target triple 映射与 ELF 架构校验。
// build-linux-sandbox.cjs（按 triple 产出）与 forge.config.cjs 的
// stageLinuxSandboxResource（按目标架构挑产物）共用，防止打包机器架构与目标
// 架构不一致时把错架构的二进制静默打进安装包（安装后 exec format error）。

const fs = require('node:fs');

/** Electron forge arch 值 → rustc target triple（桌面端两个主流架构 + ia32 兜底） */
const ARCH_TO_TRIPLE = {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
    ia32: 'i686-unknown-linux-gnu'
};

/** elf64 头 e_machine 值（bytes 18-19，小端）：只校验桌面三种架构 */
const ELF_MACHINE_BY_ARCH = {
    x64: 62, // EM_X86_64
    arm64: 183, // EM_AARCH64
    ia32: 3 // EM_386
};

const ARCH_BY_ELF_MACHINE = Object.fromEntries(
    Object.entries(ELF_MACHINE_BY_ARCH).map(([arch, machine]) => [machine, arch])
);

/**
 * 读取 ELF 文件头中的 e_machine（二进制约 1MB，整个读入可接受；一次打包只校验一次）。
 * 返回 null 表示不是可识别的小端 ELF64/ELF32 可执行文件（或文件缺失/过短）。
 */
function readElfMachine(filePath) {
    let header;
    try {
        const bytes = fs.readFileSync(filePath);
        header = bytes.subarray(0, 20);
    } catch {
        return null;
    }
    if (header.length < 20) return null;
    if (
        header[0] !== 0x7f ||
        header[1] !== 0x45 /* 'E' */ ||
        header[2] !== 0x4c /* 'L' */ ||
        header[3] !== 0x46 /* 'F' */
    ) {
        return null;
    }
    // e_ident[EI_DATA]：1=小端（桌面 Linux 均为小端；大端不在支持范围）
    if (header[5] !== 1) return null;
    // e_machine 在偏移 18（ELF64 与 ELF32 相同）
    return header.readUInt16LE(18);
}

/**
 * 校验二进制 ELF 架构与目标 arch 匹配；不匹配抛 Error（fail-fast，防错架进包）。
 */
function assertLinuxElfMachine(filePath, arch) {
    const expected = ELF_MACHINE_BY_ARCH[arch];
    if (expected === undefined) {
        throw new Error(`不支持的 Linux 打包架构: ${arch}`);
    }
    const machine = readElfMachine(filePath);
    if (machine === null) {
        throw new Error(`无法解析 ELF 头（非 ELF 或文件不完整）: ${filePath}`);
    }
    if (machine !== expected) {
        const actual = ARCH_BY_ELF_MACHINE[machine] || `e_machine=${machine}`;
        throw new Error(
            `Linux sandbox 二进制架构不符: 目标 ${arch}(e_machine=${expected})，实际 ${actual} (${filePath})。` +
                '请在本机用对应架构构建（OPENDESK_SANDBOX_TARGET 交叉构建或 ARM64 构建机直接构建）。'
        );
    }
}

/** electron forge arch → rust target triple；未知架构抛错。 */
function tripleForLinuxArch(arch) {
    const triple = ARCH_TO_TRIPLE[arch];
    if (!triple) throw new Error(`不支持的 Linux 打包架构: ${arch}`);
    return triple;
}

module.exports = {
    ARCH_TO_TRIPLE,
    ELF_MACHINE_BY_ARCH,
    readElfMachine,
    assertLinuxElfMachine,
    tripleForLinuxArch
};
