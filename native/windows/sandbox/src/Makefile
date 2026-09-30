# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
#
# nmake 构建 sandbox.exe（管理进程）与 sandbox_hook.dll（Detours 注入库）。
# 需先执行 vcvars：call "%ProgramFiles%\Microsoft Visual Studio\...\VC\Auxiliary\Build\vcvars64.bat"
#   nmake /f Makefile                 # x64（默认）
#   nmake /f Makefile ARCH=x86         # x86（32 位工具链，hook DLL = sandbox_hook32.dll）

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

CFLAGS = /nologo /W3 /O2 /MT /EHsc /std:c++17 /utf-8 /DNOMINMAX /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /D_WINVER=0x0A00 /I$(COMMON) /I$(DETOURS)
# Detours 内部需要架构宏（跳板布局）；只对 detours-src 编译生效
!IF "$(ARCH)" == "x64"
DETOURS_DEFS = /DDETOURS_64BIT /DDETOURS_X64
!ELSEIF "$(ARCH)" == "x86"
DETOURS_DEFS = /DDETOURS_32BIT /DDETOURS_X86
!ELSE
DETOURS_DEFS = /DDETOURS_64BIT /DDETOURS_ARM64
!ENDIF
DETOURS_CFLAGS = $(CFLAGS) $(DETOURS_DEFS)

COMMON_OBJS = $(OBJDIR)\log.obj $(OBJDIR)\toml.obj $(OBJDIR)\glob.obj $(OBJDIR)\paths.obj $(OBJDIR)\json.obj $(OBJDIR)\ask.obj $(OBJDIR)\policy.obj $(OBJDIR)\hook_scope.obj
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

# -- 链接 ---------------------------------------------------------------------

$(OUT)\sandbox.exe: $(COMMON_OBJS) $(DETOURS_OBJS) $(MANAGER_OBJS) $(INJECT_OBJ)
	@if not exist "$(OUT)" mkdir "$(OUT)"
	link /nologo /INCREMENTAL:NO /SUBSYSTEM:CONSOLE /ENTRY:wmainCRTStartup /OUT:$@ $(COMMON_OBJS) $(DETOURS_OBJS) $(MANAGER_OBJS) $(INJECT_OBJ) shell32.lib winhttp.lib advapi32.lib user32.lib ws2_32.lib ole32.lib

$(OUT)\$(HOOK_DLL): $(COMMON_OBJS) $(DETOURS_OBJS) $(HOOK_OBJS) $(INJECT_OBJ)
	@if not exist "$(OUT)" mkdir "$(OUT)"
	link /nologo /INCREMENTAL:NO /DLL /OUT:$@ $(COMMON_OBJS) $(DETOURS_OBJS) $(HOOK_OBJS) $(INJECT_OBJ) shell32.lib ws2_32.lib advapi32.lib

clean:
	@-rmdir /s /q $(OBJDIR) 2>nul
