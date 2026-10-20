import type { AnyMessage } from '@agentclientprotocol/sdk';
import type {
    AcpMessageListener,
    AcpMessageChannel,
    AcpMessageChannelCloseListener
} from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';

export class TestAcpMessageChannel implements AcpMessageChannel {
    readonly sent: string[] = [];
    readonly events: string[] = [];
    failSendWith?: Error;
    beforeSend?: () => Promise<void>;
    afterSend?: () => void;
    private readonly messageListeners = new Set<AcpMessageListener>();
    private readonly closeListeners = new Set<AcpMessageChannelCloseListener>();
    private readonly bufferedMessages: string[] = [];
    private closed = false;
    private closeError?: Error;
    private peer?: TestAcpMessageChannel;
    private sendRejection?: {
        predicate: (frame: AnyMessage) => boolean;
        error: Error;
    };

    connect(peer: TestAcpMessageChannel): void {
        this.peer = peer;
    }

    async send(message: string): Promise<void> {
        this.events.push('send');
        if (this.closed) throw this.closeError ?? new Error('port closed');
        if (this.failSendWith) throw this.failSendWith;
        await this.beforeSend?.();
        const rejection = this.sendRejection;
        if (rejection) {
            const frame = JSON.parse(message) as AnyMessage;
            if (rejection.predicate(frame)) {
                this.sendRejection = undefined;
                throw rejection.error;
            }
        }
        this.sent.push(message);
        this.peer?.emitMessage(message);
        this.afterSend?.();
    }

    rejectNextSend(predicate: (frame: AnyMessage) => boolean, error: Error): void {
        this.sendRejection = { predicate, error };
    }

    onMessage(listener: AcpMessageListener): () => void {
        this.messageListeners.add(listener);
        if (this.messageListeners.size === 1) {
            const buffered = this.bufferedMessages.splice(0);
            for (const message of buffered) listener(message);
        }
        return () => {
            this.events.push('unbind-message');
            this.messageListeners.delete(listener);
        };
    }

    onClose(listener: AcpMessageChannelCloseListener): () => void {
        if (this.closed) {
            listener(this.closeError);
            return () => undefined;
        }
        this.closeListeners.add(listener);
        return () => {
            this.events.push('unbind-close');
            this.closeListeners.delete(listener);
        };
    }

    close(): void {
        this.events.push('port-close');
        const peer = this.peer;
        this.emitClose();
        peer?.emitClose();
    }

    emitMessage(message: string): void {
        if (this.closed) return;
        if (this.messageListeners.size === 0) {
            this.bufferedMessages.push(message);
            return;
        }
        for (const listener of this.messageListeners) listener(message);
    }

    emitMessageAfterCloseForIdentityFence(message: string): void {
        for (const listener of this.messageListeners) listener(message);
    }

    emitClose(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        this.closeError = error;
        this.events.push(error ? 'notify-error' : 'notify-close');
        const listeners = Array.from(this.closeListeners);
        for (const listener of listeners) listener(error);
    }

    get listenerCount(): number {
        return this.messageListeners.size + this.closeListeners.size;
    }
}

export function createTestChannelPair(): [TestAcpMessageChannel, TestAcpMessageChannel] {
    const first = new TestAcpMessageChannel();
    const second = new TestAcpMessageChannel();
    first.connect(second);
    second.connect(first);
    return [first, second];
}
