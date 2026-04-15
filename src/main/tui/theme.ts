import chalk from 'chalk';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';

// ── 终端配色方案检测 ──────────────────────────────────────────────────────

export type TerminalColorScheme = 'dark' | 'light';

let _detectedScheme: TerminalColorScheme = 'dark';
let _overrideScheme: TerminalColorScheme | undefined;

/**
 * 通过 OSC 11 查询终端实际背景色 RGB，根据亮度判断深/浅。
 * 必须在 TUI start() 之前调用（pi-tui 接管 stdin 后无法再用此方法）。
 * 超时或不支持时回退到环境变量检测，最终默认 dark。
 */
export async function detectTerminalColorScheme(timeoutMs = 200): Promise<TerminalColorScheme> {
    if (_overrideScheme) {
        _detectedScheme = _overrideScheme;
        return _detectedScheme;
    }

    // 尝试 OSC 11 查询（需要 TTY）
    if (process.stdin.isTTY && process.stdout.isTTY) {
        try {
            const result = await queryOSC11(timeoutMs);
            if (result) {
                _detectedScheme = result;
                return _detectedScheme;
            }
        } catch {
            /* 查询失败，回退 */
        }
    }

    // 回退：COLORFGBG 环境变量（xterm, rxvt, iTerm2 等设置，格式为 "fg;bg"）
    const colorfgbg = process.env.COLORFGBG;
    if (colorfgbg) {
        const parts = colorfgbg.split(';');
        const bg = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(bg) && bg >= 7) {
            _detectedScheme = 'light';
            return _detectedScheme;
        }
    }

    // macOS Terminal.app 默认浅色背景
    if (process.env.TERM_PROGRAM === 'Apple_Terminal') {
        _detectedScheme = 'light';
        return _detectedScheme;
    }

    _detectedScheme = 'dark';
    return _detectedScheme;
}

/**
 * 发送 OSC 11 (Report Background Color) 并解析终端响应。
 * 响应格式: ESC ] 11 ; rgb:RRRR/GGGG/BBBB ESC \
 * 各颜色分量为 4 位十六进制（0000-ffff），取高 8 位转换为 0-255。
 */
function queryOSC11(timeoutMs: number): Promise<TerminalColorScheme | null> {
    return new Promise((resolve) => {
        const wasRaw = process.stdin.isRaw;
        const wasPaused = process.stdin.isPaused?.() ?? true;
        let settled = false;
        let buf = '';

        const cleanup = () => {
            if (settled) return;
            settled = true;
            process.stdin.removeListener('data', onData);
            try {
                process.stdin.setRawMode(!!wasRaw);
            } catch {
                /* ignore */
            }
            if (wasPaused) {
                try {
                    process.stdin.pause();
                } catch {
                    /* ignore */
                }
            }
        };

        const timer = setTimeout(() => {
            cleanup();
            resolve(null);
        }, timeoutMs);

        const onData = (chunk: Buffer) => {
            buf += chunk.toString();
            // 匹配 OSC 11 响应：ESC]11;rgb:RRRR/GGGG/BBBB ST
            // ST 可以是 ESC\ (\x1b\\) 或 BEL (\x07)
            const match = buf.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
            if (match) {
                clearTimeout(timer);
                cleanup();
                const r = parseInt(match[1].slice(0, 2), 16);
                const g = parseInt(match[2].slice(0, 2), 16);
                const b = parseInt(match[3].slice(0, 2), 16);
                // 相对亮度公式 (ITU-R BT.601)
                const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
                resolve(luminance > 128 ? 'light' : 'dark');
            }
        };

        try {
            process.stdin.setRawMode(true);
        } catch {
            resolve(null);
            return;
        }

        process.stdin.on('data', onData);
        process.stdin.resume();
        // OSC 11: 查询背景色
        process.stdout.write('\x1b]11;?\x1b\\');
    });
}

/**
 * 获取当前终端配色方案，优先返回手动覆盖值。
 */
export function getTerminalColorScheme(): TerminalColorScheme {
    return _overrideScheme ?? _detectedScheme;
}

/**
 * 手动覆盖终端配色方案检测结果（供用户配置或测试使用）。
 * 传入 undefined 恢复自动检测。
 */
export function setTerminalColorScheme(scheme: TerminalColorScheme | undefined): void {
    _overrideScheme = scheme;
}

/**
 * 根据当前终端配色方案返回状态栏的配色方案。
 * - dark:  深灰背景 + 浅灰文字
 * - light: 浅灰背景 + 深色文字
 */
export function getStatusBarColors() {
    const scheme = getTerminalColorScheme();
    if (scheme === 'light') {
        return {
            bg: '#d8d8d8',
            fg: '#333333',
            fgDim: '#666666',
            fgAccent: '#1a7f37'
        };
    }
    return {
        bg: '#3a3a3a',
        fg: '#d4d4d4',
        fgDim: '#d4d4d4',
        fgAccent: '#00e676'
    };
}

/**
 * 根据当前终端配色方案返回 overlay（弹层）的配色方案。
 * - dark:  深灰背景 + 浅灰文字
 * - light: 浅灰白背景 + 深色文字
 */
export function getOverlayColors() {
    const scheme = getTerminalColorScheme();
    if (scheme === 'light') {
        return {
            bg: '#e8e8e8',
            fg: '#1a1a1a',
            border: '#a0a0a0'
        };
    }
    return {
        bg: '#2d2d2d',
        fg: '#e0e0e0',
        border: '#b6b6b6'
    };
}

/**
 * 返回与当前终端配色方案适配的"成功/在线"绿色。
 * 浅色终端下 #39FF14 太亮看不清，用较深的绿色代替。
 */
export function getAdaptiveGreen(): string {
    return getTerminalColorScheme() === 'light' ? '#158a2c' : '#39FF14';
}

export const defaultSelectListTheme: SelectListTheme = {
    selectedPrefix: (text: string) => chalk.blue(text),
    selectedText: (text: string) => chalk.bold(text),
    description: (text: string) => chalk.dim(text),
    scrollInfo: (text: string) => chalk.dim(text),
    noMatch: (text: string) => chalk.dim(text)
};

export const defaultMarkdownTheme: MarkdownTheme = {
    heading: (text: string) => chalk.bold.cyan(text),
    link: (text: string) => chalk.blue(text),
    linkUrl: (text: string) => chalk.dim(text),
    code: (text: string) => chalk.yellow(text),
    codeBlock: (text: string) => chalk.green(text),
    codeBlockBorder: (text: string) => chalk.dim(text),
    quote: (text: string) => chalk.italic(text),
    quoteBorder: (text: string) => chalk.dim(text),
    hr: (text: string) => chalk.dim(text),
    listBullet: (text: string) => chalk.cyan(text),
    bold: (text: string) => chalk.bold(text),
    italic: (text: string) => chalk.italic(text),
    strikethrough: (text: string) => chalk.strikethrough(text),
    underline: (text: string) => chalk.underline(text)
};

export const defaultEditorTheme: EditorTheme = {
    borderColor: (text: string) => chalk.dim(text),
    selectList: defaultSelectListTheme
};
