// 进入备用缓冲区的转义序列
export const ENTER_ALTERNATE_BUFFER = '\x1b[?1049h';
// 退出备用缓冲区的转义序列
export const EXIT_ALTERNATE_BUFFER = '\x1b[?1049l';

// 清屏的转义序列
export const CLEAR_SCREEN = '\x1b[2J';
// 光标归位的转义序列
export const CURSOR_HOME = '\x1b[H';