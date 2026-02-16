import { ProcessTerminal } from "@mariozechner/pi-tui";
import { FULL_CLEAR } from './components/constants';


/**
 * 包装 ProcessTerminal，在 resize 时只走一条路径：先清屏再 requestRender，
 * 避免与 pi-tui 自带的 resize 监听器重复注册导致「先画再清再画」的冲突与残留。
 */
const RESIZE_DEBOUNCE_MS = 200;

export class OpenDeskTerminal extends ProcessTerminal {
    private resizeTimer: ReturnType<typeof setTimeout> | undefined;
    /** 上次 debounce 执行时的终端尺寸，用于判断是否仅高度变化 */
    private lastColumns = -1;
    private lastRows = -1;

    private onResizeCallbacks: Array<(cols: number, rows: number) => void> = [];

    onResize(onResize: (cols: number, rows: number) => void): void {
        this.onResizeCallbacks.push(onResize);
    }

    clearScreen() {
        process.stdout.write(FULL_CLEAR);
    }

    start(onInput: (data: string) => void, onResize: () => void): void {
        const wrappedResize = () => {
            if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
            // 不在 resize 回调里同步写 stdout；用 setTimeout 延后清屏+重绘，避免 xterm 中竞态导致卡死或残留
            this.resizeTimer = setTimeout(() => {
                this.resizeTimer = undefined;

                // 先执行外部回调，让使用者有机会更新 minLines 等状态
                for (const callback of this.onResizeCallbacks) {
                    callback(this.columns, this.rows);
                }

                // 清屏后再让 pi-tui 重绘，确保用最新状态渲染
                this.clearScreen();
                onResize();

                this.lastColumns = this.columns;
                this.lastRows = this.rows;
            }, RESIZE_DEBOUNCE_MS);
        };
        super.start(onInput, wrappedResize);
    }

    stop(): void {
        if (this.resizeTimer !== undefined) {
            clearTimeout(this.resizeTimer);
            this.resizeTimer = undefined;
        }
        super.stop();
    }
}