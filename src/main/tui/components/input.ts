import { Box, Component, Text, Editor, TUI } from "@mariozechner/pi-tui";
import { defaultEditorTheme } from "../theme";


type AgentInputStatus = 'idle' | 'running';

export class StatusBar implements Component {

    invalidate() {
        throw new Error("Method not implemented.");
    }
    render(width: number): string[] {
        throw new Error("Method not implemented.");
    }
}

/**
 * AgentInput不仅是用来方便用户进行输入的控件，同时也用于显示各种提示等
 * 会随着用户的交互行为高频变化的信息。总而言之，我们希望“持续追加”的信息
 * 显示在TaskView中，而“不停变化”的信息放在AgentInput中
 */
export class AgentInputArea implements Component {

    input: Editor;

    private tui: TUI;
    private layout: Box;
    private status: AgentInputStatus = 'idle';
    private statusText: Text = new Text('');

    private submitCallback?: (text: string) => void;

    constructor(tui: TUI) {
        this.tui = tui;
        this.layout = new Box(0, 0);
        this.input = new Editor(this.tui, defaultEditorTheme);
        this.layout.addChild(this.input);
        // this.layout.addChild(this.statusText);

        this.input.onSubmit = (text: string) => {
            if (text.trim() === '') {
                return;
            }

            this.input.addToHistory(text);
            this.setStatus('running');
            this.submitCallback?.(text);
        };
    }

    setStatus(status: AgentInputStatus) {
        this.status = status;
        if (this.status === 'running') {
            this.tui.setFocus(null);
            this.input.setText('任务进行中...');
        } else {
            this.input.setText('');
            this.tui.setFocus(this.input);
        }
    }

    invalidate() {
        this.layout.invalidate();
    }

    render(width: number): string[] {
        return this.layout.render(width);
    }

    onSubmit(callback: (text: string) => void) {
        this.submitCallback = callback;
    }
}