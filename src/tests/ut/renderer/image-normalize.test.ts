import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * AgentInput 用户图片附件的 MIME 归一化（image-normalize.js）：
 * - png/jpeg data URL 原样透传（主进程 jimp 可直接解码，无需转码）；
 * - 其余 MIME（gif/webp/bmp/svg 等）经 canvas 转成 PNG；
 * - 解码失败（损坏数据 / 测试环境无真实解码器）时原样返回，不阻塞附件。
 *
 * linkedom 没有 Image/canvas 实现，解码类转换在此环境下必然走「原样返回」降级，
 * 因此用可替换的 Image/canvas 桩分别验证转换成功与失败两条路径。
 */

describe('image-normalize', () => {
    let normalizeImageDataUrlToPng;
    let isNativeDecodableImageDataUrl;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        globalThis.document = window.document;
        const module = await import('../../../renderer/components/image-normalize.js');
        normalizeImageDataUrlToPng = module.normalizeImageDataUrlToPng;
        isNativeDecodableImageDataUrl = module.isNativeDecodableImageDataUrl;
    });

    const pngDataUrl = 'data:image/png;base64,aGVsbG8=';
    const jpegDataUrl = 'data:image/jpeg;base64,aGVsbG8=';
    const webpDataUrl = 'data:image/webp;base64,UklGRh==';
    const gifDataUrl = 'data:image/gif;base64,R0lGOD==';

    test('png and jpeg data urls are detected as native decodable', () => {
        expect(isNativeDecodableImageDataUrl(pngDataUrl)).toBe(true);
        expect(isNativeDecodableImageDataUrl(jpegDataUrl)).toBe(true);
        expect(isNativeDecodableImageDataUrl(webpDataUrl)).toBe(false);
        expect(isNativeDecodableImageDataUrl(gifDataUrl)).toBe(false);
        expect(isNativeDecodableImageDataUrl('data:;base64,aGVsbG8=')).toBe(false);
        expect(isNativeDecodableImageDataUrl('not-a-data-url')).toBe(false);
    });

    test('png and jpeg data urls pass through without transcoding', async () => {
        await expect(normalizeImageDataUrlToPng(pngDataUrl)).resolves.toBe(pngDataUrl);
        await expect(normalizeImageDataUrlToPng(jpegDataUrl)).resolves.toBe(jpegDataUrl);
    });

    test('non-native formats are transcoded to png via canvas', async () => {
        const pngOut = 'data:image/png;base64,conV3rT3d';
        const drawCalls = [];
        globalThis.Image = class {
            constructor() {
                this.naturalWidth = 32;
                this.naturalHeight = 16;
            }
            set src(value) {
                queueMicrotask(() => this.onload?.());
            }
        };
        globalThis.document.createElement = (tag) => {
            expect(tag).toBe('canvas');
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage: (...args) => drawCalls.push(args)
                }),
                toDataURL: (type) => {
                    expect(type).toBe('image/png');
                    return pngOut;
                }
            };
        };
        try {
            await expect(normalizeImageDataUrlToPng(webpDataUrl)).resolves.toBe(pngOut);
            await expect(normalizeImageDataUrlToPng(gifDataUrl)).resolves.toBe(pngOut);
            expect(drawCalls.length).toBe(2);
        } finally {
            delete globalThis.Image;
            delete globalThis.document.createElement;
        }
    });

    test('undecodable data urls fall back to the original value', async () => {
        globalThis.Image = class {
            set src(value) {
                queueMicrotask(() => this.onerror?.());
            }
        };
        try {
            await expect(normalizeImageDataUrlToPng(webpDataUrl)).resolves.toBe(webpDataUrl);
            await expect(normalizeImageDataUrlToPng('data:image/svg+xml;base64,PHN2Zy8+')).resolves.toBe(
                'data:image/svg+xml;base64,PHN2Zy8+'
            );
        } finally {
            delete globalThis.Image;
        }
    });

    test('a zero-pixel decode result falls back to the original value', async () => {
        globalThis.Image = class {
            constructor() {
                this.naturalWidth = 0;
                this.naturalHeight = 0;
            }
            set src(value) {
                queueMicrotask(() => this.onload?.());
            }
        };
        try {
            await expect(normalizeImageDataUrlToPng(webpDataUrl)).resolves.toBe(webpDataUrl);
        } finally {
            delete globalThis.Image;
        }
    });

    test('agent-input addImage enqueues synchronously and swaps in the normalized png in place', async () => {
        // 契约：addImage 保持同步入列（草稿恢复/发送按钮状态都是同步消费），
        // 归一化异步完成后原地替换条目 dataUrl。归一化本身的行为由上方用例覆盖，
        // 这里用受控 mock 驱动 agentinput 侧的时序契约。
        const pngOut = 'data:image/png;base64,sw4pp3d';
        const { parseHTML: html } = await import('linkedom');
        const { window } = html('<!doctype html><html><body></body></html>');
        const savedGlobalDocument = globalThis.document;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            Node: window.Node,
            requestAnimationFrame: (cb: (n: number) => void) => {
                cb(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal: jest.fn(async () => true)
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../platforms/bridges/renderer.ts', () => ({
            NativeBridgeProxy: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands: jest.fn(() => []),
            executeSlashCommand: jest.fn(async () => ({ status: 'cancelled' })),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));
        const normalizeMock = jest.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve(pngOut), 0)));
        await jest.unstable_mockModule('../../../renderer/components/image-normalize.js', () => ({
            normalizeImageDataUrlToPng: normalizeMock
        }));
        await import('../../../renderer/components/agentinput.js');

        try {
            const input = document.createElement('agent-input') as HTMLElement & {
                attachedImages: { dataUrl: string; name: string }[];
                render: () => void;
            };
            input.render();
            // 同步入列：调用返回时条目已存在（dataUrl 还是原值）
            input.addImage(webpDataUrl, 'shot.png');
            expect(input.attachedImages).toHaveLength(1);
            expect(input.attachedImages[0].dataUrl).toBe(webpDataUrl);
            expect(normalizeMock).toHaveBeenCalledWith(webpDataUrl);
            // 归一化完成后原地替换为 PNG
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(input.attachedImages[0].dataUrl).toBe(pngOut);
        } finally {
            globalThis.document = savedGlobalDocument;
        }
    });
});
