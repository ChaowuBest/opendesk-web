import { Component, Text, Markdown, Box, type TUI } from "@mariozechner/pi-tui";
import { TaskState } from "../../states/tasks";
import { AssistantMessage, ReasoningMessagePart, TextMessagePart, ToolCallMessagePart, UserMessage, ToolCall } from "../../agents/messages";
import { TaskUpdateChunk } from "../../states/tasks";
import { defaultMarkdownTheme } from "../theme";
import { logger } from "../../utils/logger";
import chalk from "chalk";


export class TextMessagePartView implements Component {
    text: Markdown = new Markdown('', 0, 0, defaultMarkdownTheme);

    constructor(text?: string) {
        if (text) {
            this.text.setText(text);
        }
    }

    setMarkdown(markdown: string) {
        try {
            this.text.setText(markdown);
        } catch (error) {
            // ignore error
        }
    }

    invalidate() { }

    render(width: number): string[] {
        return this.text.render(width);
    }
}

export class ReasoningMessagePartView implements Component {
    private text: Markdown = new Markdown('', 0, 0, defaultMarkdownTheme);
    private box: Box = new Box();

    constructor(text?: string) {
        if (text) {
            this.text.setText(text);
        }
        this.box.setBgFn((text: string) => chalk.grey.bgYellowBright.italic((text)));
        this.box.addChild(this.text);
    }

    setMarkdown(markdown: string) {
        this.text.setText(markdown);
    }

    invalidate() { }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

export class ToolCallView implements Component {

    title: Text = new Text('');
    box: Box = new Box(0, 0);

    constructor(toolCall: ToolCall) {
        this.box.addChild(this.title);
        this.title.setText(toolCall.tool_name);
    }

    invalidate() {
    }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

export class ToolCallMessagePartView implements Component {

    private box: Box = new Box(0, 0);

    setToolcalls(toolcalls: ToolCall[]) {
        this.box.clear();
        for (const toolcall of toolcalls) {
            this.box.addChild(new ToolCallView(toolcall));
        }
    }

    invalidate() {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

export class UserMessageView implements Component {
    message: UserMessage;
    box: Box = new Box(1, 1);

    constructor(message: UserMessage) {
        this.box.setBgFn((text: string) => chalk.white.bgGrey((text)));
        this.message = message;
        for (const part of message.content) {
            if (part.type === 'text') {
                this.box.addChild(new TextMessagePartView(part.text));
            }
        }
    }

    static text(text: string): UserMessageView {
        return new UserMessageView(new UserMessage(text));
    }

    invalidate() {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

export class AssistantMessageView implements Component {

    box: Box = new Box(0, 1);
    parts: Array<ReasoningMessagePartView | TextMessagePartView | ToolCallMessagePartView> = [];

    async updateTextPart(index: number, textPart: TextMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new TextMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof TextMessagePartView)) {
            throw new Error(`part type mismatch`)
        }

        existingPartView.setMarkdown(textPart.text);
    }

    async updateReasoningPart(index: number, reasoningPart: ReasoningMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new ReasoningMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ReasoningMessagePartView)) {
            throw new Error(`part type mismatch`)
        }

        existingPartView.setMarkdown(reasoningPart.content);
    }

    async updateToolCallPart(index: number, toolCallPart: ToolCallMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new ToolCallMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ToolCallMessagePartView)) {
            throw new Error(`part type mismatch`)
        }

        existingPartView.setToolcalls(toolCallPart.toolcalls);
    }

    /**
     * 根据任务发回的更新块来更新消息视图，由于用户消息视图是静态的，所以不需要更新
     * @param chunkUpdate
     */
    async update(chunkUpdate: TaskUpdateChunk) {
        switch (chunkUpdate.last_part.type) {
            case 'text':
                return await this.updateTextPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'reasoning':
                return await this.updateReasoningPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'tool_call':
                return await this.updateToolCallPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
        }
    }

    invalidate() {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

/**
 * 任务视图
 * 用于显示任务的对话历史
 */
export class TaskView implements Component {

    taskState?: TaskState;
    statusBar: Text = new Text('');
    messages: Array<UserMessageView | AssistantMessageView> = [];

    /** 持有 TUI 引用以便在子组件内调用 requestRender；由上层在挂载时注入 */
    private tui: TUI;
    private messageLayout: Box = new Box(0, 0);
    private mainLayout: Box = new Box(0, 0);

    constructor(tui: TUI) {
        this.tui = tui;
        this.mainLayout.addChild(this.messageLayout);
        this.mainLayout.addChild(this.statusBar);
    }

    /**
     * 在当前任务中向Agent发送一条消息，并等待Agent的响应。Agent完成响应
     * 之后这个函数才会结束
     * @param text 用户输入的消息
     * @returns
     */
    async communicate(text: string) {
        if (!this.taskState) {
            // todo: push error messages
            return;
        }

        const responseView = new AssistantMessageView();
        this.messageLayout.addChild(UserMessageView.text(text));
        this.messageLayout.addChild(responseView);

        await this.taskState.submitUserMessage(text);
        await this.taskState.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
            responseView.update(chunkUpdate);
            if (chunkUpdate.usage) {
                this.statusBar.setText(`上下文开销：${chunkUpdate.usage.total_tokens} tokens`);
            }
            this.tui.requestRender();
        })
    }

    invalidate() {
        this.messages.forEach(message => message.invalidate());
    }

    render(width: number): string[] {
        return this.mainLayout.render(width);
    }
}
