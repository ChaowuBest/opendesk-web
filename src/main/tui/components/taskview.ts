import { Component, Text, Box, type TUI } from "@mariozechner/pi-tui";
import { TaskState } from "../../states/tasks";
import { AssistantMessage, ReasoningMessagePart, TextMessagePart, ToolCallMessagePart, UserMessage } from "../../agents/messages";
import { TaskUpdateChunk } from "../../states/tasks";
import chalk from "chalk";
import cliMarkdown from "cli-markdown";


export class TextMessagePartView implements Component {
    text: Text = new Text('');

    constructor(text?: string) {
        this.text.setText(text ?? '');
    }

    setMarkdown(markdown: string) {
        try {
            this.text.setText(cliMarkdown(markdown));
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
    private text: Text = new Text('');
    private box: Box = new Box(1, 1);

    constructor(text?: string) {
        this.text.setText(text ?? '');
        this.box.setBgFn((text: string) => chalk.grey.bgYellowBright.italic((text)));
        this.box.addChild(this.text);
    }

    setMarkdown(markdown: string) {
        // this.text = cliMarkdown(markdown);
        this.text.setText(markdown);
    }

    invalidate() { }

    render(width: number): string[] {
        return this.box.render(width);
    }
}

export class ToolCallMessagePartView implements Component {
    toolCallPart: ToolCallMessagePart;

    invalidate() {
        throw new Error("Method not implemented.");
    }

    render(width: number): string[] {
        throw new Error("Method not implemented.");
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
    message: AssistantMessage;
    box: Box = new Box();
    parts: Array<ReasoningMessagePartView | TextMessagePartView | ToolCallMessagePartView> = [];

    async updateTextPart(index: number, textPart: TextMessagePart) {
        let updatedPartView: TextMessagePartView;
        while (index >= this.parts.length) {
            updatedPartView = new TextMessagePartView();
            this.parts.push(updatedPartView);
            this.box.addChild(updatedPartView);
        }

        const existingPartView = this.parts[index];
        if (existingPartView instanceof TextMessagePartView) {
            updatedPartView = existingPartView;
        } else {
            throw new Error(`part type mismatch`)
        }

        updatedPartView.setMarkdown(textPart.text);
    }

    async updateReasoningPart(index: number, reasoningPart: ReasoningMessagePart) {
        let updatedPartView: ReasoningMessagePartView;
        while (index >= this.parts.length) {
            updatedPartView = new ReasoningMessagePartView();
            this.parts.push(updatedPartView);
            this.box.addChild(updatedPartView);
        }

        const existingPartView = this.parts[index];
        if (existingPartView instanceof ReasoningMessagePartView) {
            updatedPartView = existingPartView;
        } else {
            throw new Error(`part type mismatch`)
        }

        updatedPartView.setMarkdown(reasoningPart.content);
    }

    async updateToolCallPart(index: number,toolCallPart: ToolCallMessagePart) {
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

export class TaskView implements Component {
    taskState?: TaskState;
    messages: Array<UserMessageView | AssistantMessageView> = [];

    /** 持有 TUI 引用以便在子组件内调用 requestRender；由上层在挂载时注入 */
    private tui: TUI;

    constructor(tui: TUI) {
        this.tui = tui;
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
        this.messages.push(UserMessageView.text(text));
        this.messages.push(responseView);

        await this.taskState.submitUserMessage(text);
        await this.taskState.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
            responseView.update(chunkUpdate);
            this.tui.requestRender();
        })
    }

    invalidate() {
        this.messages.forEach(message => message.invalidate());
    }

    render(width: number): string[] {
        return this.messages.flatMap(message => message.render(width));
    }
}
