@echo off
rem ============================================================
rem dynobox 沙箱内访问控制测试（BAT 部分：读/写/执行/删除）
rem 由沙箱管理器拉起，cwd 即沙箱根目录，SBX_ROOT 环境变量同值。
rem 注意：本文件必须保持 CRLF 行尾，否则 cmd 解析会错位。
rem ============================================================
setlocal enabledelayedexpansion
set /a PASS=0, FAIL=0

echo === dynobox 沙箱内测试（BAT）===

rem ---- 1. 读放行 ----
type %SBX_ROOT%docs\hello.txt >nul 2>&1
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  bat_read_allow) else (set /a FAIL+=1 & echo FAIL  bat_read_allow)

rem ---- 2. 读拒绝 ----
type %SBX_ROOT%docs\secret.txt >nul 2>&1
if !errorlevel! NEQ 0 (set /a PASS+=1 & echo PASS  bat_read_deny) else (set /a FAIL+=1 & echo FAIL  bat_read_deny)

rem ---- 3. 根目录枚举 ----
dir /b %SBX_ROOT% >nul 2>&1
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  bat_list_root) else (set /a FAIL+=1 & echo FAIL  bat_list_root)

rem ---- 4. 写放行（public）----
echo bat-was-here> %SBX_ROOT%public\bat_ok.txt 2>nul
if exist %SBX_ROOT%public\bat_ok.txt (set /a PASS+=1 & echo PASS  bat_write_allow) else (set /a FAIL+=1 & echo FAIL  bat_write_allow)

rem ---- 5. 写拒绝（vault）----
echo x> %SBX_ROOT%vault\bat.txt 2>nul
if exist %SBX_ROOT%vault\bat.txt (set /a FAIL+=1 & echo FAIL  bat_write_deny) else (set /a PASS+=1 & echo PASS  bat_write_deny)

rem ---- 6. 执行放行（tools 白名单）----
%SBX_ROOT%tools\where.exe cmd >nul 2>&1
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  bat_exec_allow) else (set /a FAIL+=1 & echo FAIL  bat_exec_allow)

rem ---- 7. 执行拒绝（tools\blocked 黑名单）----
%SBX_ROOT%tools\blocked\where.exe cmd >nul 2>&1
if !errorlevel! NEQ 0 (set /a PASS+=1 & echo PASS  bat_exec_deny) else (set /a FAIL+=1 & echo FAIL  bat_exec_deny)

rem ---- 8. 执行 ask（上游 allow）----
%SBX_ROOT%tools\ask\where.exe cmd >nul 2>&1
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  bat_exec_ask_allow) else (set /a FAIL+=1 & echo FAIL  bat_exec_ask_allow)

rem ---- 9. 删除拒绝（docs 只读）----
del %SBX_ROOT%docs\hello.txt >nul 2>&1
if exist %SBX_ROOT%docs\hello.txt (set /a PASS+=1 & echo PASS  bat_delete_deny) else (set /a FAIL+=1 & echo FAIL  bat_delete_deny)

rem ---- 10. 删除放行（public，自己刚创建的文件）----
del %SBX_ROOT%public\bat_ok.txt >nul 2>&1
if exist %SBX_ROOT%public\bat_ok.txt (set /a FAIL+=1 & echo FAIL  bat_delete_allow) else (set /a PASS+=1 & echo PASS  bat_delete_allow)

rem ---- 11. Python 用例（读/写/ask/超时/改名；无 python 环境则跳过）----
where python >nul 2>&1
if !errorlevel! NEQ 0 (
    echo NOTE  未检测到 python，跳过 python 用例
    goto :summary
)
python %SBX_ROOT%tests\py_tests.py
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  py_all_cases) else (set /a FAIL+=1 & echo FAIL  py_all_cases)

:summary
echo === BAT 结果: !PASS! 通过 / !FAIL! 失败 ===

echo === BAT 结果: !PASS! 通过 / !FAIL! 失败 ===
endlocal & exit /b %FAIL%
