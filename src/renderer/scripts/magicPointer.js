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
 * Magic Pointer: hold Command (Meta) on macOS or Alt on Windows/Linux to activate a magic cursor with drawing capability.
 * On release, if strokes were drawn, shows a floating input box for annotation.
 * On send, captures screenshot of window content + drawn strokes and saves to Desktop.
 *
 * Supports both mouse and touch input for drawing.
 */

import { NativeBridgeProxy } from '../../platforms/bridges/renderer.ts';
import { resolveRendererLocale } from '../locale.ts';

const STROKE_COLOR = '#4F8CFF';
const STROKE_WIDTH = 5;
const STROKE_LINE_CAP = 'round';
const STROKE_GLOW_COLOR = 'rgba(79, 140, 255, 0.5)';
const STROKE_GLOW_BLUR = 8;
const INPUT_BOX_MARGIN = 12;
const ACTIVATION_DELAY_MS = 200;

// Platform detection - macOS uses Meta (Command), others use Alt
const platform = window.systemInfo?.platform || (typeof process !== 'undefined' ? process.platform : 'unknown');
const isMac = platform === 'darwin';
const ACTIVATION_KEY = isMac ? 'Meta' : 'Alt';
const bridgeProxy = new NativeBridgeProxy();

let speechAvailableCache = null;
let speechCheckPromise = null;

async function getSpeechAvailable() {
    if (speechAvailableCache !== null) return speechAvailableCache;
    if (speechCheckPromise) return speechCheckPromise;
    speechCheckPromise = (async () => {
        try {
            const kit = await bridgeProxy.getSpeechKit();
            speechAvailableCache = await kit.available();
        } catch {
            speechAvailableCache = false;
        }
        return speechAvailableCache;
    })();
    return speechCheckPromise;
}

function detectSystemSpeechLocale() {
    return resolveRendererLocale();
}

async function getConfiguredSpeechLocale() {
    try {
        const settingObj = await window.settingAPI?.loadSettingObject?.();
        return resolveRendererLocale(settingObj);
    } catch {
        /* fall back to system locale */
    }
    return detectSystemSpeechLocale();
}

let enabled = false;
let experimentalFeatureEnabled = false;
let activationKeyDown = false;
let pointerActive = false;
let activationTimer = null; // Debounce timer for activation
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
let interactionVersion = 0;
let speechAvailable = false;
let speechSession = null;
let speechStarting = false;
let speechStartVersion = 0;
let speechRecording = false;
let speechStopping = false;
let speechBaseText = '';
let speechPollTimer = null;
let speechPeekInFlight = false;
let speechWarmupPromise = null;
let lastSpeechButtonPressAt = 0;

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
    <button class="mp-btn-speech" type="button" title="语音输入（点击开始，再次点击结束）" style="display:none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 14C13.66 14 15 12.66 15 11V5C15 3.34 13.66 2 12 2C10.34 2 9 3.34 9 5V11C9 12.66 10.34 14 12 14Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M19 11C19 14.87 15.87 18 12 18M12 18C8.13 18 5 14.87 5 11M12 18V22M8 22H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
    inputBoxEl.addEventListener('pointerdown', onSpeechButtonPointerDown, true);
    inputBoxEl.querySelector('.mp-btn-speech').addEventListener('click', onSpeechButtonClick);
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

function clearActivationTimer() {
    clearTimeout(activationTimer);
    activationTimer = null;
}

function updateMousePosition(x, y) {
    mouseX = x;
    mouseY = y;
    if (pointerActive) {
        positionCursor(mouseX, mouseY);
    }
}

function applySystemCursorPosition(position) {
    if (
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(position.width) ||
        !Number.isFinite(position.height) ||
        position.width <= 0 ||
        position.height <= 0
    ) {
        return false;
    }

    if (position.x < 0 || position.y < 0 || position.x > position.width || position.y > position.height) {
        return false;
    }

    const x = Math.max(0, Math.min(window.innerWidth, position.x * (window.innerWidth / position.width)));
    const y = Math.max(0, Math.min(window.innerHeight, position.y * (window.innerHeight / position.height)));
    updateMousePosition(x, y);
    return true;
}

async function syncCursorPositionFromSystem() {
    if (!window.magicPointerAPI?.getCursorPosition) return false;

    try {
        const position = await window.magicPointerAPI.getCursorPosition();
        return applySystemCursorPosition(position);
    } catch {
        return false;
    }
}

function bumpInteractionVersion() {
    interactionVersion += 1;
}

function forceExit() {
    const wasPointerActive = pointerActive;
    const hasPointerSurface =
        wasPointerActive ||
        activationTimer !== null ||
        overlayEl?.classList.contains('active') ||
        canvasEl?.classList.contains('active');
    const shouldKeepInput = inputVisible;
    const hadActivationTimer = activationTimer !== null;
    bumpInteractionVersion();
    activationKeyDown = false;
    drawing = false;
    currentStroke = null;
    clearActivationTimer();
    document.body.classList.remove('magic-pointer-active');
    hideCursor();
    void cleanupSpeechInput();
    if ((hasPointerSurface || hadActivationTimer) && !shouldKeepInput) {
        deactivate();
        clearCanvas();
        hasDrawnAnything = false;
    }
}

function activate() {
    if (!enabled || !activationKeyDown || inputVisible) return;
    pointerActive = true;
    document.body.classList.add('magic-pointer-active');
    overlayEl?.classList.add('active');
    canvasEl?.classList.add('active');
    showCursor();
}

async function activateWithFreshCursor() {
    await syncCursorPositionFromSystem();
    activate();
}

function deactivate() {
    pointerActive = false;
    document.body.classList.remove('magic-pointer-active');
    hideCursor();
    overlayEl?.classList.remove('active');
    canvasEl?.classList.remove('active');
}

function fullDismiss() {
    bumpInteractionVersion();
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
    const boxW = inputBoxEl.offsetWidth || 312;
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
    void refreshSpeechAvailability();
    requestAnimationFrame(() => {
        inputBoxEl.classList.add('visible');
        const field = inputBoxEl.querySelector('.mp-input-field');
        if (field) {
            field.value = '';
            field.placeholder = '描述一下...';
            field.classList.remove('speech-interim');
            field.focus();
        }
    });
}

function hideInputBox() {
    if (!inputBoxEl) return;
    void cleanupSpeechInput();
    inputVisible = false;
    inputBoxEl.classList.remove('visible');
}

async function onSend() {
    if (speechRecording) {
        await stopSpeechInput({ finalize: true });
    }

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

function getInputField() {
    return inputBoxEl?.querySelector('.mp-input-field') || null;
}

function getSpeechButton() {
    return inputBoxEl?.querySelector('.mp-btn-speech') || null;
}

function updateSpeechButtonVisibility() {
    const speechBtn = getSpeechButton();
    if (!speechBtn) return;
    speechBtn.style.display = speechAvailable ? 'flex' : 'none';
}

async function refreshSpeechAvailability() {
    speechAvailable = await getSpeechAvailable();
    updateSpeechButtonVisibility();
    if (isMac && speechAvailable) {
        void warmSpeechInput();
    }
}

function updateSpeechUI(recording) {
    const field = getInputField();
    const speechBtn = getSpeechButton();
    inputBoxEl?.classList.toggle('recording', recording);
    speechBtn?.classList.toggle('speech-recording', recording);
    if (speechBtn) {
        speechBtn.title = recording ? '正在录音，点击停止' : '语音输入（点击开始，再次点击结束）';
    }
    if (field) {
        field.placeholder = recording ? '正在聆听，识别文字将显示在输入框...' : '描述一下...';
        if (!recording) {
            field.classList.remove('speech-interim');
        }
    }
}

function fillSpeechTextInInput(text, options = {}) {
    const field = getInputField();
    if (!field) return;
    const trimmed = (text || '').trim();
    const base = (speechBaseText || '').trim();
    if (trimmed) {
        field.value = base ? `${base} ${trimmed}` : trimmed;
    } else if (!options.interim) {
        field.value = speechBaseText;
    }
    field.classList.toggle('speech-interim', !!options.interim && !!trimmed);
    if (!options.interim || document.activeElement === field) {
        field.focus();
        const len = field.value.length;
        field.setSelectionRange(len, len);
    }
}

function stopSpeechPreviewPolling() {
    if (speechPollTimer) {
        clearInterval(speechPollTimer);
        speechPollTimer = null;
    }
    speechPeekInFlight = false;
}

async function cleanupSpeechInput() {
    speechStartVersion += 1;
    stopSpeechPreviewPolling();
    speechStarting = false;
    speechRecording = false;
    speechStopping = false;
    const session = speechSession;
    speechSession = null;
    updateSpeechUI(false);
    if (session) {
        try {
            await session.release();
        } catch {
            /* ignore */
        }
    }
}

async function stopSpeechInput({ finalize = true } = {}) {
    const session = speechSession;
    if (!session) {
        if (speechStarting) {
            speechStartVersion += 1;
            speechStarting = false;
            speechRecording = false;
            stopSpeechPreviewPolling();
            updateSpeechUI(false);
            return;
        }
        await cleanupSpeechInput();
        return;
    }
    if (speechStopping) {
        speechStarting = false;
        speechRecording = false;
        stopSpeechPreviewPolling();
        updateSpeechUI(false);
        return;
    }
    speechStopping = true;
    speechStarting = false;
    speechStartVersion += 1;
    speechSession = null;
    speechRecording = false;
    stopSpeechPreviewPolling();
    updateSpeechUI(false);
    try {
        if (finalize) {
            const text = await session.stop();
            fillSpeechTextInInput(text || '', { interim: false });
        }
    } catch {
        /* ignore */
    } finally {
        speechStopping = false;
    }
}

function startSpeechPreviewPolling() {
    stopSpeechPreviewPolling();
    speechPollTimer = setInterval(async () => {
        const session = speechSession;
        if (!speechRecording || !session || speechPeekInFlight) return;
        speechPeekInFlight = true;
        try {
            const result = await session.peek();
            if (!speechRecording || speechSession !== session) return;
            if (!result) return;
            if (typeof result === 'string') {
                fillSpeechTextInInput(result, { interim: true });
                return;
            }
            if (result.content) {
                fillSpeechTextInInput(result.content, { interim: true });
            }
            if (result.finished) {
                await stopSpeechInput({ finalize: true });
            }
        } catch {
            /* ignore poll errors */
        } finally {
            speechPeekInFlight = false;
        }
    }, 200);
}

async function toggleSpeechInput() {
    const field = getInputField();
    if (!field || !inputVisible) return;
    if (speechStopping) {
        speechStarting = false;
        speechRecording = false;
        stopSpeechPreviewPolling();
        updateSpeechUI(false);
        return;
    }

    if (speechStarting || speechRecording) {
        await stopSpeechInput({ finalize: true });
        return;
    }

    if (!speechAvailable && !(await getSpeechAvailable())) {
        speechAvailable = false;
        updateSpeechButtonVisibility();
        return;
    }

    try {
        const kit = await bridgeProxy.getSpeechKit();
        if (!(await kit.available())) {
            speechAvailable = false;
            updateSpeechButtonVisibility();
            return;
        }
        const startVersion = speechStartVersion + 1;
        speechStartVersion = startVersion;
        speechSession = kit;
        speechStarting = true;
        speechRecording = true;
        speechStopping = false;
        speechBaseText = field.value;
        updateSpeechUI(true);
        field.focus();
        await kit.initialize(await getConfiguredSpeechLocale());
        if (speechStartVersion !== startVersion || speechSession !== kit) {
            return;
        }
        await kit.start();
        if (speechStartVersion !== startVersion || speechSession !== kit) {
            try {
                await kit.stop();
            } catch {
                /* ignore */
            }
            return;
        }
        speechStarting = false;
        speechRecording = true;
        startSpeechPreviewPolling();
    } catch {
        await cleanupSpeechInput();
    }
}

async function warmSpeechInput() {
    if (speechWarmupPromise || speechStarting || speechRecording || speechStopping) {
        return speechWarmupPromise;
    }
    speechWarmupPromise = (async () => {
        try {
            const kit = await bridgeProxy.getSpeechKit();
            if (await kit.available()) {
                await kit.initialize(await getConfiguredSpeechLocale());
            }
        } catch {
            /* ignore warmup errors */
        } finally {
            speechWarmupPromise = null;
        }
    })();
    return speechWarmupPromise;
}

function onSpeechButtonPointerDown(e) {
    if (!e.target?.closest?.('.mp-btn-speech')) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    lastSpeechButtonPressAt = performance.now();
    void toggleSpeechInput();
}

function onSpeechButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (performance.now() - lastSpeechButtonPressAt < 350) {
        return;
    }
    void toggleSpeechInput();
}

/**
 * Capture composite image: window content + drawn strokes (no overlay/cursor/input box).
 * Returns a PNG data URL.
 */
async function captureComposite() {
    // Temporarily hide overlay and input box for clean capture
    const restoreVersion = interactionVersion;
    const overlayWasActive = overlayEl?.classList.contains('active');
    const inputWasVisible = inputBoxEl?.classList.contains('visible');
    const cursorWasVisible = cursorEl?.classList.contains('visible');
    overlayEl?.classList.remove('active');
    inputBoxEl?.classList.remove('visible');
    cursorEl?.classList.remove('visible');

    try {
        await new Promise((r) => setTimeout(r, 50));

        const dataUrl = await window.magicPointerAPI.captureWindow();
        if (!dataUrl) return null;

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
    } finally {
        if (restoreVersion === interactionVersion) {
            if (overlayWasActive) overlayEl?.classList.add('active');
            if (inputWasVisible) inputBoxEl?.classList.add('visible');
            if (cursorWasVisible) cursorEl?.classList.add('visible');
        }
    }
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
    if (e.key !== ACTIVATION_KEY || activationKeyDown || inputVisible || !experimentalFeatureEnabled) return;

    activationKeyDown = true;
    hasDrawnAnything = false;
    clearCanvas();
    void syncCursorPositionFromSystem();

    // Debounce: delay activation to avoid accidental triggers on quick taps
    clearActivationTimer();
    activationTimer = setTimeout(() => {
        activationTimer = null;
        void activateWithFreshCursor();
    }, ACTIVATION_DELAY_MS);
}

async function onKeyup(e) {
    if (e.key !== ACTIVATION_KEY) return;

    // If activation was still pending (debounce timer hasn't fired), cancel it
    if (activationTimer) {
        activationKeyDown = false;
        drawing = false;
        currentStroke = null;
        clearActivationTimer();
        return;
    }

    if (!activationKeyDown) return;
    activationKeyDown = false;

    if (!pointerActive) {
        drawing = false;
        currentStroke = null;
        return;
    }

    drawing = false;

    if (currentStroke && currentStroke.length > 1) {
        strokes.push(currentStroke);
        hasDrawnAnything = true;
    }
    currentStroke = null;

    if (hasDrawnAnything && strokes.length > 0) {
        // Keep the canvas visible with the strokes while the annotation input is open.
        pointerActive = false;
        hideCursor();
        document.body.classList.remove('magic-pointer-active');
        // Capture screenshot NOW (before input box appears), containing only page content + strokes
        const captureVersion = interactionVersion;
        try {
            pendingScreenshot = await captureComposite();
        } catch {
            pendingScreenshot = null;
        }
        if (captureVersion !== interactionVersion) {
            pendingScreenshot = null;
            return;
        }
        if (pendingScreenshot) {
            // Then show input box on top
            showInputBox();
        } else {
            fullDismiss();
        }
    } else {
        // Nothing drawn — dismiss everything
        fullDismiss();
    }
}

function onMouseMove(e) {
    updateMousePosition(e.clientX, e.clientY);

    if (drawing && currentStroke) {
        currentStroke.push({ x: e.clientX, y: e.clientY });
        redrawAll();
    }
}

function onMouseDown(e) {
    if (!pointerActive || e.button !== 0) return;
    drawing = true;
    currentStroke = [{ x: e.clientX, y: e.clientY }];
    redrawAll();
}

function onMouseUp() {
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
    if (!pointerActive) return;
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        updateMousePosition(touch.clientX, touch.clientY);
        drawing = true;
        currentStroke = [{ x: touch.clientX, y: touch.clientY }];
        redrawAll();
    }
}

function onTouchMove(e) {
    if (!pointerActive || !drawing) return;
    if (e.touches.length === 1) {
        const touch = e.touches[0];
        updateMousePosition(touch.clientX, touch.clientY);
        if (currentStroke) {
            currentStroke.push({ x: touch.clientX, y: touch.clientY });
            redrawAll();
        }
    }
}

function onTouchEnd() {
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

function onPageInactive() {
    if (document.visibilityState === 'hidden') {
        forceExit();
    }
}

function init() {
    if (typeof document === 'undefined') return;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
        return;
    }
    if (enabled) return;
    createElements();
    enabled = true;

    // MagicPointer is gated behind experimental feature toggle
    if (window.settingAPI?.loadSettingObject) {
        window.settingAPI
            .loadSettingObject()
            .then((setting) => {
                experimentalFeatureEnabled = !!setting?.debug?.experimental_features?.magic_pointer;
            })
            .catch(() => {});
    }
    if (window.settingAPI?.onSettingChanged) {
        window.settingAPI.onSettingChanged((setting) => {
            experimentalFeatureEnabled = !!setting?.debug?.experimental_features?.magic_pointer;
        });
    }
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
    document.addEventListener('visibilitychange', onPageInactive);
    window.addEventListener('pagehide', forceExit);
    window.addEventListener('magicPointer:forceExit', forceExit);
}

init();

export function initMagicPointer() {
    init();
}
