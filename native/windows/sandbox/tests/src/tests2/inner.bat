@echo off
rem 孙进程测试：这是"子 cmd"拉起的"孙 cmd"执行的脚本
rem 写 public 允许；写 vault 拒绝
echo grandchild-was-here> %SBX_ROOT%public\grandchild.txt 2>nul
echo x> %SBX_ROOT%vault\grandchild_vault.txt 2>nul
exit /b 0
