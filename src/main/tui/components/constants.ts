// 进入备用缓冲区的转义序列
export const ENTER_ALTERNATE_BUFFER = '\x1b[?1049h';
// 退出备用缓冲区的转义序列
export const EXIT_ALTERNATE_BUFFER = '\x1b[?1049l';

// 清屏的转义序列（仅当前可见区域）
export const CLEAR_SCREEN = '\x1b[2J';
// 光标归位的转义序列
export const CURSOR_HOME = '\x1b[H';

// 完整清屏：先归位再清屏，避免部分终端残留。3J 清除滚动历史（部分终端支持）
export const FULL_CLEAR = '\x1b[H\x1b[2J\x1b[3J';
