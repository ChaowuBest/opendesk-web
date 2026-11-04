/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Windows 快速截图遮罩页。
 *
 * 视觉与交互参数逐项对齐鸿蒙 QuickCaptureOverlay.ets：整屏半透明暗遮罩、
 * 圆角挖空的选区、旋转的锥形渐变描边 + 双层泛光、顶部提示条、选区工具条
 * （尺寸 + 取消 + 复制 + 发送给 OpenDesk）、已发送提示，以及 Esc / 单击空白 / 再次
 * 按热键退出的行为。绘制坐标是 CSS 像素（等价于鸿蒙 vp）。
 */

const GLOW_FRAME_INTERVAL_MS = 33;
const CLOSE_AFTER_SENT_MS = 700;
const MIN_SELECTION = 8;
const CORNER_RADIUS = 12;
/** Windows 任务栏在遮罩之上，工具条需要离屏幕底部留出空间。 */
const BOTTOM_RESERVE = 72;
const TOOLBAR_ESTIMATED_WIDTH = 462;
const TOOLBAR_HEIGHT = 44;
const TOOLBAR_MARGIN = 12;

type Phase = 'idle' | 'selecting' | 'selected' | 'sent';

interface OverlayStrings {
    hintDrag: string;
    hintExit: string;
    cancel: string;
    copy: string;
    send: string;
    backdrop: string;
    screenWidth: number;
    screenHeight: number;
}

interface OverlayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface CommitResult {
    ok: boolean;
    message: string;
}

interface OverlayApi {
    ready(): Promise<OverlayStrings | null>;
    commit(rect: OverlayRect): Promise<CommitResult>;
    copy(rect: OverlayRect): Promise<CommitResult>;
    close(): Promise<{ ok: boolean }>;
}

const canvas = document.getElementById('overlay-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const backdrop = document.getElementById('backdrop') as HTMLImageElement;
const hint = document.getElementById('hint') as HTMLElement;
const hintTitle = document.getElementById('hint-title') as HTMLElement;
const hintSubtitle = document.getElementById('hint-subtitle') as HTMLElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;
const sizeLabel = document.getElementById('size-label') as HTMLElement;
const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement;
const copyButton = document.getElementById('copy-button') as HTMLButtonElement;
const sendButton = document.getElementById('send-button') as HTMLButtonElement;
const sentLabel = document.getElementById('sent-label') as HTMLElement;

const api = (window as unknown as { quickCaptureOverlayAPI?: OverlayApi }).quickCaptureOverlayAPI;

const state = {
    phase: 'idle' as Phase,
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    downX: -1,
    downY: -1,
    hadSelection: false,
    sending: false,
    glowAngle: 0
};

let glowTimer = -1;
let closeTimer = -1;

function screenWidth(): number {
    return window.innerWidth;
}

function screenHeight(): number {
    return window.innerHeight;
}

function resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(screenWidth() * dpr));
    canvas.height = Math.max(1, Math.round(screenHeight() * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
}

function traceSelection(): void {
    ctx.beginPath();
    ctx.roundRect(state.left, state.top, state.width, state.height, CORNER_RADIUS);
}

function redraw(): void {
    const width = screenWidth();
    const height = screenHeight();
    ctx.clearRect(0, 0, width, height);
    // 整屏半透明暗遮罩
    ctx.fillStyle = 'rgba(9, 12, 20, 0.52)';
    ctx.fillRect(0, 0, width, height);
    if (state.phase === 'idle') {
        return;
    }
    // 在遮罩上挖一个圆角全透明洞，露出页面底层的预截屏（冻结画面）
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgb(0, 0, 0)';
    traceSelection();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // 旋转的锥形渐变描边 + 彩色泛光
    const centerX = state.left + state.width / 2;
    const centerY = state.top + state.height / 2;
    const gradient = ctx.createConicGradient(state.glowAngle, centerX, centerY);
    gradient.addColorStop(0, '#8B5CF6');
    gradient.addColorStop(0.33, '#22D3EE');
    gradient.addColorStop(0.66, '#F472B6');
    gradient.addColorStop(1, '#8B5CF6');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(139, 92, 246, 0.65)';
    ctx.shadowBlur = 16;
    traceSelection();
    ctx.stroke();
    ctx.shadowColor = 'rgba(34, 211, 238, 0.45)';
    ctx.shadowBlur = 28;
    ctx.stroke();

    // 内层 1px 白色细描边
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    traceSelection();
    ctx.stroke();
}

function applyPhase(next: Phase): void {
    state.phase = next;
    hint.style.display = next === 'idle' ? 'flex' : 'none';
    toolbar.style.display = next === 'selected' ? 'flex' : 'none';
    sentLabel.style.display = next === 'sent' ? 'block' : 'none';
    redraw();
}

function layoutToolbar(): void {
    const density = window.devicePixelRatio || 1;
    sizeLabel.textContent = `${Math.round(state.width * density)} × ${Math.round(state.height * density)}`;
    let x = state.left;
    x = Math.max(TOOLBAR_MARGIN, Math.min(x, screenWidth() - TOOLBAR_ESTIMATED_WIDTH - TOOLBAR_MARGIN));
    let y = state.top + state.height + TOOLBAR_MARGIN;
    if (y + TOOLBAR_HEIGHT > screenHeight() - BOTTOM_RESERVE) {
        y = Math.max(TOOLBAR_MARGIN, state.top - TOOLBAR_HEIGHT - TOOLBAR_MARGIN);
    }
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${y}px`;
    sentLabel.style.left = `${x}px`;
    sentLabel.style.top = `${y}px`;
}

function closeOverlay(): void {
    if (closeTimer >= 0) {
        clearTimeout(closeTimer);
        closeTimer = -1;
    }
    void api?.close();
}

function scheduleClose(delayMs: number): void {
    if (closeTimer >= 0) {
        clearTimeout(closeTimer);
    }
    closeTimer = window.setTimeout(() => {
        closeTimer = -1;
        closeOverlay();
    }, delayMs);
}

/**
 * 交付选区：`send` 交给主窗口，`copy` 写入系统剪贴板。
 * 成功后退回主窗口/复制的时序与鸿蒙一致：700ms；失败提示停留更久（1400ms）。
 */
async function deliverSelection(action: 'send' | 'copy'): Promise<void> {
    if (state.sending) {
        return;
    }
    state.sending = true;
    const rect: OverlayRect = {
        left: state.left,
        top: state.top,
        width: state.width,
        height: state.height
    };
    let result: CommitResult = { ok: false, message: '' };
    try {
        const request = action === 'send' ? api?.commit(rect) : api?.copy(rect);
        result = (await request) ?? { ok: false, message: '' };
    } catch (error) {
        console.error(`[QuickCaptureOverlay] ${action} failed:`, error);
    }
    sentLabel.textContent = result.message;
    applyPhase('sent');
    if (!result.ok) {
        state.sending = false;
    }
    scheduleClose(result.ok ? CLOSE_AFTER_SENT_MS : CLOSE_AFTER_SENT_MS * 2);
}

function onPointerDown(event: PointerEvent): void {
    // 鼠标只响应左键；触摸/笔的 button 也是 0
    if (event.button !== 0) {
        return;
    }
    event.preventDefault();
    state.downX = event.clientX;
    state.downY = event.clientY;
    state.hadSelection = state.phase === 'selected' || state.phase === 'sent';
    applyPhase('selecting');
    // 捕获指针，手指/鼠标移出窗口也能继续收到 move/up
    try {
        canvas.setPointerCapture(event.pointerId);
    } catch {
        // 部分触摸注入场景下 pointerId 已失效，退化为不捕获
    }
}

function onPointerMove(event: PointerEvent): void {
    if (state.phase !== 'selecting') {
        return;
    }
    event.preventDefault();
    const left = Math.max(0, Math.min(state.downX, event.clientX));
    const right = Math.min(screenWidth(), Math.max(state.downX, event.clientX));
    const top = Math.max(0, Math.min(state.downY, event.clientY));
    const bottom = Math.min(screenHeight(), Math.max(state.downY, event.clientY));
    state.left = left;
    state.top = top;
    state.width = right - left;
    state.height = bottom - top;
    redraw();
}

function onPointerUp(event: PointerEvent): void {
    if (state.phase !== 'selecting') {
        return;
    }
    event.preventDefault();
    try {
        if (canvas.hasPointerCapture(event.pointerId)) {
            canvas.releasePointerCapture(event.pointerId);
        }
    } catch {
        // 与捕获失败对称：指针已失效时无需释放
    }
    if (state.width < MIN_SELECTION || state.height < MIN_SELECTION) {
        // 视为普通单击：已有选区时重新开始，否则退出
        if (state.hadSelection) {
            state.left = 0;
            state.top = 0;
            state.width = 0;
            state.height = 0;
            applyPhase('idle');
        } else {
            closeOverlay();
        }
        return;
    }
    layoutToolbar();
    applyPhase('selected');
}

function bindEvents(): void {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    // 触摸屏兜底：即使某些输入路径没有把手势交给 Pointer Events，也不让页面滚动/缩放
    document.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
    cancelButton.addEventListener('click', () => closeOverlay());
    copyButton.addEventListener('click', () => void deliverSelection('copy'));
    sendButton.addEventListener('click', () => void deliverSelection('send'));
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        // Sent 阶段按 Esc：主进程按是否已交接决定要不要把主窗口带到前台。
        closeOverlay();
    });
    window.addEventListener('resize', resizeCanvas);
}

async function bootstrap(): Promise<void> {
    bindEvents();
    resizeCanvas();
    applyPhase('idle');
    glowTimer = window.setInterval(() => {
        if (state.phase === 'selected' || state.phase === 'sent') {
            state.glowAngle = (state.glowAngle + 0.06) % (Math.PI * 2);
            redraw();
        }
    }, GLOW_FRAME_INTERVAL_MS);

    try {
        const strings = await api?.ready();
        if (!strings) {
            return;
        }
        if (strings.backdrop) {
            backdrop.src = strings.backdrop;
            // 背景按显示器 DIP 尺寸铺开：窗口可能被系统裁到工作区（不含任务栏），
            // 保持 1:1 才能让框选位置与截图像素严格对应。
            if (strings.screenWidth > 0 && strings.screenHeight > 0) {
                backdrop.style.width = `${strings.screenWidth}px`;
                backdrop.style.height = `${strings.screenHeight}px`;
            }
        }
        hintTitle.textContent = strings.hintDrag;
        hintSubtitle.textContent = strings.hintExit;
        cancelButton.textContent = strings.cancel;
        copyButton.textContent = strings.copy;
        sendButton.textContent = strings.send;
    } catch (error) {
        console.error('[QuickCaptureOverlay] load strings failed:', error);
    }
}

window.addEventListener('beforeunload', () => {
    if (glowTimer >= 0) {
        clearInterval(glowTimer);
        glowTimer = -1;
    }
});

void bootstrap();

export {};
