import os
import sys
from pathlib import Path

print(f"python {sys.version_info[:3]} on {sys.platform}")

# 尝试通过沙箱映射路径读家目录文件
for candidate in [r"Z:\C\Users\liyif\opendesk_sandbox_write_test.txt",
                  r"C:\Users\liyif\opendesk_sandbox_write_test.txt"]:
    try:
        print(f"read via {candidate}:", Path(candidate).read_text(encoding="utf-8").strip())
    except Exception as e:
        print(f"read via {candidate} FAILED: {type(e).__name__}: {e}")

# 写 D 盘根目录（原生路径与映射路径各试一次）
for target in [r"D:\opendesk_sandbox_python_result.txt",
               r"Z:\D\opendesk_sandbox_python_result.txt"]:
    try:
        Path(target).write_text(f"written by python in sandbox, pid={os.getpid()}", encoding="utf-8")
        print(f"write via {target} OK")
    except Exception as e:
        print(f"write via {target} FAILED: {type(e).__name__}: {e}")
