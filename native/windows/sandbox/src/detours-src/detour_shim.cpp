/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 */
// 兼容层：Detours 的 disasm.cpp 在 OFFLINE_LIBRARY 模式下导出带架构后缀的
// DetourCopyInstruction<ARCH>，而 detours.cpp 引用无后缀的 DetourCopyInstruction。
// 这里提供无后缀符号并转发给架构实现（避免直接修改第三方源码）。
#include <windows.h>

#if defined(_M_ARM64)
extern "C" PVOID WINAPI DetourCopyInstructionARM64(_In_opt_ PVOID pDst,
                                                   _Inout_opt_ PVOID* ppDstPool,
                                                   _In_ PVOID pSrc,
                                                   _Out_opt_ PVOID* ppTarget,
                                                   _Out_opt_ LONG* plExtra);
#elif defined(_M_IX86)
extern "C" PVOID WINAPI DetourCopyInstructionX86(_In_opt_ PVOID pDst,
                                                 _Inout_opt_ PVOID* ppDstPool,
                                                 _In_ PVOID pSrc,
                                                 _Out_opt_ PVOID* ppTarget,
                                                 _Out_opt_ LONG* plExtra);
#else
extern "C" PVOID WINAPI DetourCopyInstructionX64(_In_opt_ PVOID pDst,
                                                 _Inout_opt_ PVOID* ppDstPool,
                                                 _In_ PVOID pSrc,
                                                 _Out_opt_ PVOID* ppTarget,
                                                 _Out_opt_ LONG* plExtra);
#endif

extern "C" PVOID WINAPI DetourCopyInstruction(_In_opt_ PVOID pDst,
                                              _Inout_opt_ PVOID* ppDstPool,
                                              _In_ PVOID pSrc,
                                              _Out_opt_ PVOID* ppTarget,
                                              _Out_opt_ LONG* plExtra)
{
#if defined(_M_ARM64)
    return DetourCopyInstructionARM64(pDst, ppDstPool, pSrc, ppTarget, plExtra);
#elif defined(_M_IX86)
    return DetourCopyInstructionX86(pDst, ppDstPool, pSrc, ppTarget, plExtra);
#else
    return DetourCopyInstructionX64(pDst, ppDstPool, pSrc, ppTarget, plExtra);
#endif
}
