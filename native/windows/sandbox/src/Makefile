# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
#
# nmake 构建 sandbox.exe（管理进程）与 sandbox_hook.dll（Detours 注入库）。
# 需先执行 vcvars：call "%ProgramFiles%\Microsoft Visual Studio\...\VC\Auxiliary\Build\vcvars64.bat"
#   nmake /f Makefile                 # x64（默认）
#   nmake /f Makefile ARCH=x86         # x86（32 位工具链，hook DLL = sandbox_hook32.dll）
#
# 本文件必须保留 UTF-8 BOM：nmake 按 ANSI 代码页（中文系统为 GBK）读取无 BOM 的
# makefile，UTF-8 中文注释会被逐字节错位配对，可能吞掉紧随其后的宏定义行
# （表现为链接 sandbox_hook.dll 时大量 LNK2019）。BOM 使 nmake 按 UTF-8 正确解析。

!IF "$(ARCH)" == ""
ARCH = x64
!ENDIF

# 本目录即工程根（common/manager/hook/detours-src 都在这层）。
# 注意：不使用 "ROOT = .." 宏——nmake 会把纯 ".." 宏值吞成空字符串，
# 导致 $(ROOT)\dist 展开为 \dist（写到盘根）。OUT 直接写 ..\ 相对路径。
.SUFFIXES: .cpp .obj
COMMON = common
MANAGER = manager
HOOK = hook
DETOURS = detours-src
OBJDIR = build\$(ARCH)

!IF "$(ARCH)" == "x64"
RID = win-x64
DETOURS_ARCH_OBJ = $(OBJDIR)\disolx64.obj
HOOK_DLL = sandbox_hook.dll
!ELSEIF "$(ARCH)" == "x86"
RID = win-x86
DETOURS_ARCH_OBJ = $(OBJDIR)\disolx86.obj
HOOK_DLL = sandbox_hook32.dll
!ELSEIF "$(ARCH)" == "arm64"
RID = win-arm64
DETOURS_ARCH_OBJ = $(OBJDIR)\disolarm64.obj
HOOK_DLL = sandbox_hook.dll
!ELSE
!ERROR unsupported ARCH=$(ARCH)
!ENDIF

OUT = ..\dist\$(RID)\bin

# 共享 core 源码目录（native/openharmony/sandbox/src，三平台单一来源）。
# 注意：本文件位于 native/windows/sandbox/src，到达 native/ 需要三级 ".."。
CORE_SRC_DIR = ..\..\..\openharmony\sandbox\src

CFLAGS = /nologo /W3 /O2 /MT /EHsc /std:c++17 /utf-8 /DNOMINMAX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /D_WINVER=0x0A00 /I$(COMMON) /I$(DETOURS) /I$(CORE_SRC_DIR)
# Detours 内部需要架构宏（跳板布局）；只对 detours-src 编译生效
!IF "$(ARCH)" == "x64"
DETOURS_DEFS = /DDETOURS_64BIT /DDETOURS_X64
!ELSEIF "$(ARCH)" == "x86"
DETOURS_DEFS = /DDETOURS_32BIT /DDETOURS_X86
!ELSE
DETOURS_DEFS = /DDETOURS_64BIT /DDETOURS_ARM64
!ENDIF
DETOURS_CFLAGS = $(CFLAGS) $(DETOURS_DEFS)

# toml.obj / glob.obj 已移除：TOML 解析与 glob 匹配改由共享 core 提供
# （mini_toml.c + policy.c，经 core_policy.cpp 桥接），Windows 侧不再维护
# 第二份实现。toml.cpp / glob.cpp 源文件一并废弃。
COMMON_OBJS = $(OBJDIR)\log.obj $(OBJDIR)\utf.obj $(OBJDIR)\paths.obj $(OBJDIR)\json.obj $(OBJDIR)\ask.obj $(OBJDIR)\policy.obj $(OBJDIR)\hook_scope.obj $(OBJDIR)\core_policy.obj
# 共享 core（native/openharmony/sandbox/src，三平台单一来源）：mini_toml（TOML
# 解析）+ policy（dbox_policy_load_toml / dbox_glob_match 评估内核）+ util（路径
# 归一化）。经 common/core_policy.cpp 桥接（UTF-16↔UTF-8 + 大小写折叠）。
CORE_OBJS = $(OBJDIR)\mini_toml_core.obj $(OBJDIR)\policy_core.obj $(OBJDIR)\util_core.obj
DETOURS_OBJS = $(OBJDIR)\detours.obj $(OBJDIR)\image.obj $(OBJDIR)\creatwth.obj $(OBJDIR)\modules.obj $(OBJDIR)\detour_shim.obj $(DETOURS_ARCH_OBJ)
MANAGER_OBJS = $(OBJDIR)\main.obj $(OBJDIR)\runner.obj $(OBJDIR)\endpoint.obj
HOOK_OBJS = $(OBJDIR)\dllmain.obj $(OBJDIR)\hooks_file.obj $(OBJDIR)\hooks_proc.obj $(OBJDIR)\hooks_nt.obj $(OBJDIR)\hooks_symlink.obj
INJECT_OBJ = $(OBJDIR)\inject.obj
HEADERS = $(COMMON)\*.h $(HOOK)\*.h

all: $(OBJDIR) $(OUT) $(OUT)\sandbox.exe $(OUT)\$(HOOK_DLL)

$(OUT):
	@if not exist "$(OUT)" mkdir "$(OUT)"

$(OBJDIR):
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"

# -- 编译推断规则 -------------------------------------------------------------

{$(COMMON)}.cpp{$(OBJDIR)}.obj:
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /Fo$@ /c $<

{$(MANAGER)}.cpp{$(OBJDIR)}.obj:
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /Fo$@ /c $<

{$(HOOK)}.cpp{$(OBJDIR)}.obj:
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /Fo$@ /c $<

{$(DETOURS)}.cpp{$(OBJDIR)}.obj:
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(DETOURS_CFLAGS) /Fo$@ /c $<

# -- 共享 core 的 .c 编译（C 编译单元，include core 目录；/TC 强制 C 编译） -----
# 显式规则（nmake 的 {dir}.c{dir2}.obj 双后缀推断不支持自定义目标后缀）。
$(OBJDIR)\mini_toml_core.obj: $(CORE_SRC_DIR)\mini_toml.c
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /TC /I$(CORE_SRC_DIR) /Fo$@ /c $(CORE_SRC_DIR)\mini_toml.c

$(OBJDIR)\policy_core.obj: $(CORE_SRC_DIR)\policy.c $(CORE_SRC_DIR)\pthread_compat.h
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /TC /I$(CORE_SRC_DIR) /Fo$@ /c $(CORE_SRC_DIR)\policy.c

$(OBJDIR)\util_core.obj: $(CORE_SRC_DIR)\util.c $(CORE_SRC_DIR)\util.h
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /TC /I$(CORE_SRC_DIR) /Fo$@ /c $(CORE_SRC_DIR)\util.c

# -- 链接 ---------------------------------------------------------------------

$(OUT)\sandbox.exe: $(COMMON_OBJS) $(CORE_OBJS) $(DETOURS_OBJS) $(MANAGER_OBJS) $(INJECT_OBJ)
	@if not exist "$(OUT)" mkdir "$(OUT)"
	link /nologo /INCREMENTAL:NO /SUBSYSTEM:CONSOLE /ENTRY:wmainCRTStartup /OUT:$@ $(COMMON_OBJS) $(CORE_OBJS) $(DETOURS_OBJS) $(MANAGER_OBJS) $(INJECT_OBJ) shell32.lib winhttp.lib advapi32.lib user32.lib ws2_32.lib ole32.lib

$(OUT)\$(HOOK_DLL): $(COMMON_OBJS) $(CORE_OBJS) $(DETOURS_OBJS) $(HOOK_OBJS) $(INJECT_OBJ)
	@if not exist "$(OUT)" mkdir "$(OUT)"
	link /nologo /INCREMENTAL:NO /DLL /OUT:$@ $(COMMON_OBJS) $(CORE_OBJS) $(DETOURS_OBJS) $(HOOK_OBJS) $(INJECT_OBJ) shell32.lib ws2_32.lib advapi32.lib

clean:
	@-rmdir /s /q $(OBJDIR) 2>nul
