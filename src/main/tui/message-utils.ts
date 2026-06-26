import type { TaskState } from '../aikernel/states/tasks';

interface UserMessageLike {
    role?: unknown;
    internal?: unknown;
    rawText?: unknown;
    getPlainText?: unknown;
    content?: unknown;
}

function isUserMessageLike(message: unknown): message is UserMessageLike {
    return typeof message === 'object' && message !== null && (message as UserMessageLike).role === 'user';
}

function getUserMessageText(message: UserMessageLike): string {
    if (typeof message.rawText === 'string' && message.rawText.trim().length > 0) {
        return message.rawText.trim();
    }
    if (typeof message.getPlainText === 'function') {
        return message.getPlainText().trim();
    }
    if (!Array.isArray(message.content)) {
        return '';
    }
    return message.content
        .map((part) => {
            if (typeof part !== 'object' || part === null) return '';
            const typedPart = part as { type?: unknown; text?: unknown };
            return typedPart.type === 'text' && typeof typedPart.text === 'string' ? typedPart.text : '';
        })
        .join('\n')
        .trim();
}

export function getLastNonInternalUserMessageText(task: TaskState | undefined): string | undefined {
    if (!task) return undefined;
    for (let i = task.chat_context.messages.length - 1; i >= 0; i--) {
        const message = task.chat_context.messages[i];
        if (!isUserMessageLike(message) || message.internal === true) continue;
        const text = getUserMessageText(message);
        if (text.length > 0) return text;
    }
    return undefined;
}
