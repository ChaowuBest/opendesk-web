import type { NativeBridge, SpeechKit, OcrKit, PeekResult } from './common';

class SpeechKitProxy implements SpeechKit {
    async available(): Promise<boolean> {
        return window.native.call('speechKit:available');
    }

    async initialize(): Promise<void> {
        return window.native.call('speechKit:initialize');
    }

    async start(): Promise<void> {
        return window.native.call('speechKit:start');
    }

    async peek(): Promise<PeekResult> {
        return window.native.call('speechKit:peek');
    }

    async stop(): Promise<string> {
        return window.native.call('speechKit:stop');
    }

    async release(): Promise<void> {
        return window.native.call('speechKit:release');
    }
}

class OcrKitProxy implements OcrKit {
    async available(): Promise<boolean> {
        return false;
    }
}

export class NativeBridgeProxy implements NativeBridge {
    async getPlatform(): Promise<string> {
        return window.native.call('getPlatform');
    }

    async getVariant(): Promise<string> {
        return window.native.call('getVariant');
    }

    async getSpeechKit(): Promise<SpeechKit> {
        return new SpeechKitProxy();
    }

    async getOcrKit(): Promise<OcrKit> {
        return new OcrKitProxy();
    }
}
