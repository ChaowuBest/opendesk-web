/**
 * Magic Pointer: hold Command (Meta) on macOS or Alt on Windows/Linux to activate a magic cursor with drawing capability.
 * On release, if strokes were drawn, shows a floating input box for annotation.
 * On send, captures screenshot of window content + drawn strokes and saves to Desktop.
 *
 * Supports both mouse and touch input for drawing.
 */

const STROKE_COLOR = '#4F8CFF';
const STROKE_WIDTH = 5;
const STROKE_LINE_CAP = 'round';
const STROKE_GLOW_COLOR = 'rgba(79, 140, 255, 0.5)';
const STROKE_GLOW_BLUR = 8;
const INPUT_BOX_MARGIN = 12;
const ACTIVATION_DELAY_MS = 200;
const FOCUS_CHECK_INTERVAL_MS = 200;

// Platform detection - macOS uses Meta (Command), others use Alt
const platform = window.systemInfo?.platform || (typeof process !== 'undefined' ? process.platform : 'unknown');
const isMac = platform === 'darwin';
const ACTIVATION_KEY = isMac ? 'Meta' : 'Alt';

let enabled = false;
let activationKeyDown = false; // Renamed from metaDown for clarity
let activationTimer = null; // Debounce timer for activation
let focusCheckInterval = null; // Periodic focus check interval
let drawing = false;
let mouseX = 0;
let mouseY = 0;

let cursorEl = null;
let overlayEl = null;
let canvasEl = null;
let ctx = null;
let inputBoxEl = null;
let strokes = [];
let currentStroke = null;
let hasDrawnAnything = false;
let inputVisible = false;
let pendingScreenshot = null;

/**
 * SVG cursor: a triangular pointer (no tail/stem) with white fill,
 * blue stroke and drop shadow — matching the reference shape.
 */
function buildCursorSVG() {
    return `<svg width="32" height="32" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="mpShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0a1d3a" flood-opacity="0.5"/>
    </filter>
  </defs>
  <path d="M 32,26
           C 31,24.5 32.5,23.5 34,24.2
           L 73.5,43
           C 75,43.7 75,45.8 73.5,46.5
           L 57,54
           L 49.5,70.5
           C 48.8,72 46.7,72 46,70.5
           L 32,31
           C 31.5,29.5 31.5,27.5 32,26 Z"
        fill="#ffffff"
        stroke="#2980ff"
        stroke-width="3.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        filter="url(#mpShadow)" />
</svg>`;
}

function buildInputBoxHTML() {
    return `<div class="mp-input-card">
    <input class="mp-input-field" type="text" placeholder="描述一下..." />
    <button class="mp-btn-cancel" title="取消">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
    </button>
    <button class="mp-btn-send" title="发送">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 14V3M8 3L3 8M8 3L13 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </button>
</div>`;
}

function createElements() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'magic-pointer-overlay';
    document.body.appendChild(overlayEl);

    canvasEl = document.createElement('canvas');
    canvasEl.id = 'magic-pointer-canvas';
    syncCanvasSize();
    document.body.appendChild(canvasEl);
    ctx = canvasEl.getContext('2d');
    ctx.scale(devicePixelRatio, devicePixelRatio);

    cursorEl = document.createElement('div');
    cursorEl.id = 'magic-pointer-cursor';
    cursorEl.innerHTML = buildCursorSVG();
    document.body.appendChild(cursorEl);

    inputBoxEl = document.createElement('div');
    inputBoxEl.id = 'magic-pointer-input-box';
    inputBoxEl.innerHTML = buildInputBoxHTML();
    document.body.appendChild(inputBoxEl);

    inputBoxEl.querySelector('.mp-btn-send').addEventListener('click', onSend);
    inputBoxEl.querySelector('.mp-btn-cancel').addEventListener('click', onCancel);
    inputBoxEl.querySelector('.mp-input-field').addEventListener('keydown', (e) => {
        // 忽略输入法组合状态下的按键（如中文输入法选字时的回车）
        if (e.isComposing) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        } else if (e.key === 'Escape') {
            onCancel();
        }
    });
}

function syncCanvasSize() {
    if (!canvasEl) return;
    canvasEl.width = window.innerWidth * devicePixelRatio;
    canvasEl.height = window.innerHeight * devicePixelRatio;
    canvasEl.style.width = window.innerWidth + 'px';
    canvasEl.style.height = window.innerHeight + 'px';
}

function positionCursor(x, y) {
    if (!cursorEl) return;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
}

function showCursor() {
    if (!cursorEl) return;
    positionCursor(mouseX, mouseY);
    requestAnimationFrame(() => cursorEl.classList.add('visible'));
}

function hideCursor() {
    if (!cursorEl) return;
    cursorEl.classList.remove('visible');
}

function forceExit() {
    activationKeyDown = false;
    clearTimeout(activationTimer);
    activationTimer = null;
    deactivate();
}

function activate() {
    if (!enabled) return;
    document.body.classList.add('magic-pointer-active');
    overlayEl?.classList.add('active');
    canvasEl?.classList.add('active');
    showCursor();
    // Start periodic focus check: exit magic pointer if window loses focus
    if (focusCheckInterval) clearInterval(focusCheckInterval);
    focusCheckInterval = setInterval(() => {
        if (activationKeyDown && !document.hasFocus()) {
            forceExit();
        }
    }, FOCUS_CHECK_INTERVAL_MS);
}

function deactivate() {
    document.body.classList.remove('magic-pointer-active');
    hideCursor();
    overlayEl?.classList.remove('active');
    canvasEl?.classList.remove('active');
    if (focusCheckInterval) {
        clearInterval(focusCheckInterval);
        focusCheckInterval = null;
    }
}

function fullDismiss() {
    deactivate();
    hideInputBox();
    clearCanvas();
    hasDrawnAnything = false;
}

function clearCanvas() {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width / devicePixelRatio, canvasEl.height / devicePixelRatio);
    strokes = [];
    currentStroke = null;
}

function redrawAll() {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width / devicePixelRatio, canvasEl.height / devicePixelRatio);
    const allStrokes = currentStroke ? strokes.concat([currentStroke]) : strokes;
    for (const s of allStrokes) {
        if (s.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = STROKE_COLOR;
        ctx.lineWidth = STROKE_WIDTH;
        ctx.lineCap = STROKE_LINE_CAP;
        ctx.lineJoin = STROKE_LINE_CAP;
        ctx.shadowColor = STROKE_GLOW_COLOR;
        ctx.shadowBlur = STROKE_GLOW_BLUR;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length; i++) {
            ctx.lineTo(s[i].x, s[i].y);
        }
        ctx.stroke();
        ctx.restore();
    }
}

/**
 * Compute bounding rect of all strokes.
 */
function getStrokesBounds() {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const s of strokes) {
        for (const p of s) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Position the input box near the drawn area.
 * Prefer right side, then bottom; fall back to left or top if clipped.
 */
function positionInputBox() {
    if (!inputBoxEl) return;
    const bounds = getStrokesBounds();
    const boxW = 280;
    const boxH = inputBoxEl.offsetHeight || 120;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    let x, y;

    // Try right side
    if (bounds.maxX + INPUT_BOX_MARGIN + boxW <= winW) {
        x = bounds.maxX + INPUT_BOX_MARGIN;
        y = Math.max(
            INPUT_BOX_MARGIN,
            Math.min((bounds.minY + bounds.maxY) / 2 - boxH / 2, winH - boxH - INPUT_BOX_MARGIN)
        );
    }
    // Try bottom
    else if (bounds.maxY + INPUT_BOX_MARGIN + boxH <= winH) {
        x = Math.max(
            INPUT_BOX_MARGIN,
            Math.min((bounds.minX + bounds.maxX) / 2 - boxW / 2, winW - boxW - INPUT_BOX_MARGIN)
        );
        y = bounds.maxY + INPUT_BOX_MARGIN;
    }
    // Try left side
    else if (bounds.minX - INPUT_BOX_MARGIN - boxW >= 0) {
        x = bounds.minX - INPUT_BOX_MARGIN - boxW;
        y = Math.max(
            INPUT_BOX_MARGIN,
            Math.min((bounds.minY + bounds.maxY) / 2 - boxH / 2, winH - boxH - INPUT_BOX_MARGIN)
        );
    }
    // Fallback: top
    else {
        x = Math.max(
            INPUT_BOX_MARGIN,
            Math.min((bounds.minX + bounds.maxX) / 2 - boxW / 2, winW - boxW - INPUT_BOX_MARGIN)
        );
        y = Math.max(INPUT_BOX_MARGIN, bounds.minY - INPUT_BOX_MARGIN - boxH);
    }

    inputBoxEl.style.left = x + 'px';
    inputBoxEl.style.top = y + 'px';
}

function showInputBox() {
    if (!inputBoxEl) return;
    inputVisible = true;
    positionInputBox();
    requestAnimationFrame(() => {
        inputBoxEl.classList.add('visible');
        const field = inputBoxEl.querySelector('.mp-input-field');
        if (field) {
            field.value = '';
            field.focus();
        }
    });
}

function hideInputBox() {
    if (!inputBoxEl) return;
    inputVisible = false;
    inputBoxEl.classList.remove('visible');
}

async function onSend() {
    if (!pendingScreenshot) {
        fullDismiss();
        return;
    }

    const description = inputBoxEl?.querySelector('.mp-input-field')?.value || '';

    try {
        await createTaskWithScreenshot(pendingScreenshot, description);
    } catch (err) {
        console.error('[MagicPointer] failed:', err);
    }

    pendingScreenshot = null;
    fullDismiss();
}

function onCancel() {
    pendingScreenshot = null;
    fullDismiss();
}

/**
 * Capture composite image: window content + drawn strokes (no overlay/cursor/input box).
 * Returns a PNG data URL.
 */
async function captureComposite() {
    // Temporarily hide overlay and input box for clean capture
    const overlayWasActive = overlayEl?.classList.contains('active');
    overlayEl?.classList.remove('active');
    inputBoxEl?.classList.remove('visible');
    cursorEl?.classList.remove('visible');

    await new Promise((r) => setTimeout(r, 50));

    const dataUrl = await window.magicPointerAPI.captureWindow();
    if (!dataUrl) return null;

    if (overlayWasActive) overlayEl?.classList.add('active');

    const compositeCanvas = document.createElement('canvas');
    const w = window.innerWidth * devicePixelRatio;
    const h = window.innerHeight * devicePixelRatio;
    compositeCanvas.width = w;
    compositeCanvas.height = h;
    const cCtx = compositeCanvas.getContext('2d');

    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
    });
    cCtx.drawImage(img, 0, 0, w, h);

    cCtx.scale(devicePixelRatio, devicePixelRatio);
    for (const s of strokes) {
        if (s.length < 2) continue;
        cCtx.save();
        cCtx.strokeStyle = STROKE_COLOR;
        cCtx.lineWidth = STROKE_WIDTH;
        cCtx.lineCap = STROKE_LINE_CAP;
        cCtx.lineJoin = STROKE_LINE_CAP;
        cCtx.shadowColor = STROKE_GLOW_COLOR;
        cCtx.shadowBlur = STROKE_GLOW_BLUR;
        cCtx.globalAlpha = 0.85;
        cCtx.beginPath();
        cCtx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length; i++) {
            cCtx.lineTo(s[i].x, s[i].y);
        }
        cCtx.stroke();
        cCtx.restore();
    }

    return compositeCanvas.toDataURL('image/png');
}

/**
 * Create a new OpenDesk agent task, then submit the screenshot + user description as a message.
 */
async function createTaskWithScreenshot(screenshotDataUrl, description) {
    const taskId = await window.taskManagerAPI.createTask();
    await window.taskManagerAPI.submitMessage(taskId, {
        message: description || '请看这张截屏标注',
        attachedImages: [screenshotDataUrl],
        attachedFilePaths: []
    });
    // Navigate to the newly created task
    if (window.globalControlAPI && window.globalControlAPI.openTask) {
        window.globalControlAPI.openTask(taskId);
    }
}

function onKeydown(e) {
    if (e.key === ACTIVATION_KEY && !activationKeyDown && !inputVisible) {
        // Debounce: delay activation to avoid accidental triggers on quick taps
        clearTimeout(activationTimer);
        activationTimer = setTimeout(() => {
            activationTimer = null;
            activationKeyDown = true;
            hasDrawnAnything = false;
            strokes = [];
            currentStroke = null;
            activate();
        }, ACTIVATION_DELAY_MS);
    }
}

async function onKeyup(e) {
    if (e.key !== ACTIVATION_KEY) return;

    // If activation was still pending (debounce timer hasn't fired), cancel it
    if (activationTimer) {
        clearTimeout(activationTimer);
        activationTimer = null;
        return;
    }

    if (!activationKeyDown) return;

    activationKeyDown = false;
    drawing = false;

    if (currentStroke && currentStroke.length > 1) {
        strokes.push(currentStroke);
        hasDrawnAnything = true;
    }
    currentStroke = null;

    // Hide cursor regardless
    hideCursor();
    document.body.classList.remove('magic-pointer-active');

    if (hasDrawnAnything && strokes.length > 0) {
        // Capture screenshot NOW (before input box appears), containing only page content + strokes
        pendingScreenshot = await captureComposite();
        // Then show input box on top
        showInputBox();
    } else {
        // Nothing drawn — dismiss everything
        fullDismiss();
    }
}

function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (activationKeyDown) {
        positionCursor(mouseX, mouseY);
    }

    if (drawing && currentStroke) {
        currentStroke.push({ x: e.clientX, y: e.clientY });
        redrawAll();
    }
}

function onMouseDown(e) {
    if (!activationKeyDown || e.button !== 0) return;
    drawing = true;
    currentStroke = [{ x: e.clientX, y: e.clientY }];
    redrawAll();
}

function onMouseUp(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.length > 1) {
        strokes.push(currentStroke);
        hasDrawnAnything = true;
    }
    currentStroke = null;
    redrawAll();
}

// Touch event handlers for touchscreen support
function onTouchStart(e) {
    if (!activationKeyDown) return;
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        mouseX = touch.clientX;
        mouseY = touch.clientY;
        positionCursor(mouseX, mouseY);
        drawing = true;
        currentStroke = [{ x: touch.clientX, y: touch.clientY }];
        redrawAll();
    }
}

function onTouchMove(e) {
    if (!activationKeyDown || !drawing) return;
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        mouseX = touch.clientX;
        mouseY = touch.clientY;
        positionCursor(mouseX, mouseY);
        if (currentStroke) {
            currentStroke.push({ x: touch.clientX, y: touch.clientY });
            redrawAll();
        }
    }
}

function onTouchEnd(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke && currentStroke.length > 1) {
        strokes.push(currentStroke);
        hasDrawnAnything = true;
    }
    currentStroke = null;
    redrawAll();
}

function onResize() {
    syncCanvasSize();
    if (ctx) {
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }
    redrawAll();
    if (inputVisible) {
        positionInputBox();
    }
}

function init() {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        return;
    }
    createElements();
    enabled = true;
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    // Touch event listeners for touchscreen support
    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    window.addEventListener('resize', onResize);
    // Exit magic pointer immediately when the window loses focus
    // (e.g., user switched to another window via Cmd+Tab)
    window.addEventListener('blur', () => {
        if (activationKeyDown || activationTimer) {
            forceExit();
        }
    });

    // When window regains focus, if activationKeyDown is still true it means
    // we missed the keyup event during the blur period. Force exit to prevent
    // the magic cursor and system cursor both showing simultaneously.
    window.addEventListener('focus', () => {
        if (activationKeyDown) {
            forceExit();
        }
    });
}

init();

export function initMagicPointer() {
    init();
}
