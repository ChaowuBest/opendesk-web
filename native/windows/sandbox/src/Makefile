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
# 头文件依赖（下面 -- 编译依赖 -- 段把它们挂到 .obj 上）。nmake 的双后缀推断
# 规则只能表达 "x.cpp -> x.obj"，无法声明头文件依赖；改 header 后未改动的 .cpp
# 会复用旧 .obj，新旧结构体布局混进同一个二进制。曾发生：Rule 增加 CoreGlob/spec
# 成员后 static 的 main.obj 仍按旧 sizeof 遍历 vector，产物 `debug-rules` 直接
# 0xC0000005（全量重建即恢复），以及一次"能跑但每 op 少判定一次"的隐性不一致。
# 这里显式列全（不用通配符：依赖里的通配符一旦匹配不到会让 nmake 报
# "don't know how to make"），让改任一共享头都触发相关 TU 重编。
COMMON_HEADERS = $(COMMON)\ask.h $(COMMON)\core_policy.h $(COMMON)\hook_scope.h \
    $(COMMON)\json.h $(COMMON)\log.h $(COMMON)\paths.h $(COMMON)\policy.h $(COMMON)\utf.h
HOOK_HEADERS = $(HOOK)\hook.h $(HOOK)\inject.h
HEADERS = $(COMMON_HEADERS) $(HOOK_HEADERS)
# core 的头：dynobox.h 定义规则/glob/policy 结构（桥接层直接 include），
# policy.h 被 policy.c 自身 include（改它同样要重编），mini_toml.h/util.h 同理。
CORE_HEADERS = $(CORE_SRC_DIR)\dynobox.h $(CORE_SRC_DIR)\mini_toml.h \
    $(CORE_SRC_DIR)\policy.h $(CORE_SRC_DIR)\util.h

all: $(OBJDIR) $(OUT) $(OUT)\sandbox.exe $(OUT)\$(HOOK_DLL)

$(OUT):
	@if not exist "$(OUT)" mkdir "$(OUT)"

$(OBJDIR):
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"

# -- 编译依赖（头文件） -------------------------------------------------------
# 这些目标本身不带命令：真正编译由上面/下面的推断规则提供，这里只补依赖，
# 使头文件时间戳也能判定 .obj 是否过期。core 头一并挂上：core_policy.cpp 直接
# include dynobox.h（core 的规则/glob 结构定义），改它同样要重编。
$(COMMON_OBJS) $(MANAGER_OBJS) $(HOOK_OBJS) $(INJECT_OBJ): $(HEADERS) $(CORE_HEADERS)
$(DETOURS_OBJS): $(DETOURS)\detours.h $(DETOURS)\detver.h

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
$(OBJDIR)\mini_toml_core.obj: $(CORE_SRC_DIR)\mini_toml.c $(CORE_HEADERS)
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /TC /I$(CORE_SRC_DIR) /Fo$@ /c $(CORE_SRC_DIR)\mini_toml.c

$(OBJDIR)\policy_core.obj: $(CORE_SRC_DIR)\policy.c $(CORE_HEADERS) $(CORE_SRC_DIR)\pthread_compat.h
	@if not exist "$(OBJDIR)" mkdir "$(OBJDIR)"
	$(CC) $(CFLAGS) /TC /I$(CORE_SRC_DIR) /Fo$@ /c $(CORE_SRC_DIR)\policy.c

$(OBJDIR)\util_core.obj: $(CORE_SRC_DIR)\util.c $(CORE_HEADERS)
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
