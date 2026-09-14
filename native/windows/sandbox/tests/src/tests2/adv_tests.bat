@echo off
rem ============================================================
rem 高级场景测试（BAT 部分）：孙进程治理 + 多进程并发 IO
rem 注意：本文件必须保持 CRLF 行尾，否则 cmd 解析会错位。
rem ============================================================
setlocal enabledelayedexpansion
set /a PASS=0, FAIL=0

echo === dynobox 高级场景测试（BAT）===

rem ---- 1. 孙进程治理：bat -> 子 cmd -> 孙 cmd，孙的 IO 同样受策略管控 ----
cmd /c tests2\inner.bat >nul 2>&1
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  adv_grandchild_chain) else (set /a FAIL+=1 & echo FAIL  adv_grandchild_chain)

if exist %SBX_ROOT%public\grandchild.txt (set /a PASS+=1 & echo PASS  adv_grandchild_write) else (set /a FAIL+=1 & echo FAIL  adv_grandchild_write)
if exist %SBX_ROOT%public\grandchild_vault.txt (set /a FAIL+=1 & echo FAIL  adv_grandchild_vault_blocked) else (set /a PASS+=1 & echo PASS  adv_grandchild_vault_blocked)

rem ---- 2. 多进程并发 IO：3 个后台进程同时写不同文件 ----
start /b cmd /c echo A > %SBX_ROOT%public\par-A.txt
start /b cmd /c echo B > %SBX_ROOT%public\par-B.txt
start /b cmd /c echo C > %SBX_ROOT%public\par-C.txt
ping -n 3 127.0.0.1 >nul
set /a OKCNT=0
if exist %SBX_ROOT%public\par-A.txt set /a OKCNT+=1
if exist %SBX_ROOT%public\par-B.txt set /a OKCNT+=1
if exist %SBX_ROOT%public\par-C.txt set /a OKCNT+=1
if !OKCNT! EQU 3 (set /a PASS+=1 & echo PASS  adv_parallel_processes) else (set /a FAIL+=1 & echo FAIL  adv_parallel_processes !OKCNT!/3)

del %SBX_ROOT%public\par-A.txt %SBX_ROOT%public\par-B.txt %SBX_ROOT%public\par-C.txt >nul 2>&1

rem ---- 3. Python 并发线程 IO ----
python %SBX_ROOT%tests2\parallel_pytests.py
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  adv_threaded_io) else (set /a FAIL+=1 & echo FAIL  adv_threaded_io)

rem ---- 4. Python 高级用例（16 项）----
python %SBX_ROOT%tests2\adv_pytests.py
if !errorlevel! EQU 0 (set /a PASS+=1 & echo PASS  adv_py_all_cases) else (set /a FAIL+=1 & echo FAIL  adv_py_all_cases)

echo === ADV-BAT 结果: !PASS! 通过 / !FAIL! 失败 ===
endlocal & exit /b %FAIL%
