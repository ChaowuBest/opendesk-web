import { intro, outro, text, note, spinner, box, select, SpinnerResult } from '@clack/prompts';
import { GlobalState } from './../states/global.js';
import { ChatContext, ToolCallMessagePart, TextMessagePart, UserMessage } from '../agents/messages.js';
import { argv } from 'process';
import cliMarkdown from 'cli-markdown';
import { TaskState, TaskUpdateChunk } from '../states/tasks.js';


const state = GlobalState.getInstance();

const banner = `
██╗  ██╗██╗██████╗ ███████╗███████╗██╗  ██╗
██║  ██║██║██╔══██╗██╔════╝██╔════╝██║ ██╔╝
███████║██║██║  ██║█████╗  ███████╗█████╔╝
██╔══██║██║██║  ██║██╔══╝  ╚════██║██╔═██╗
██║  ██║██║██████╔╝███████╗███████║██║  ██╗
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝`

let currentTask: TaskState | null = null;
let providedPrompt: string | null = argv[2] ?? null;

async function step(): Promise<void> {
    var prompt = '';
    if (providedPrompt) {
        prompt = providedPrompt;
        providedPrompt = null;
    } else {
        prompt = await text({
            message: currentTask === null ? '你好呀，需要我帮你做什么?' : '接下来有什么新的指示?',
            placeholder: '(bye - 退出)',
        }).then(result => result.toString());
    }

    if (prompt.trim() === 'bye') {
        throw new Error('bye');
    }

    if (currentTask === null) {
        currentTask = state.taskManagerState.createTask();
    }

    const s = spinner();
    s.start('思考中...');

    await currentTask.submitUserMessage(prompt.toString());
    await currentTask.waitUntilFinished((chunkUpdate: TaskUpdateChunk) => {
        s.message(`正在组织回答 (已产生 ${chunkUpdate.usage?.total_tokens} 词) `);
        if (chunkUpdate.last_part instanceof ToolCallMessagePart) {
            for (const tc of chunkUpdate.last_part.toolcalls) {
                if (tc.status === 'success') {
                    s.stop();
                    box(tc.result, `工具调用完成: ${tc.tool_name}`, { rounded: true });
                    s.start('思考中...');
                }
            }
        }
        if (chunkUpdate.task_status === 'stopped') {
            s.stop('思考完成');
            if (chunkUpdate.last_part instanceof TextMessagePart) {
                box(
                    cliMarkdown((chunkUpdate.last_part as TextMessagePart).text), 'Response',
                    { rounded: true, titleAlign: 'center' }
                )
            }
        }
    });
}

export async function mainloop() {
    intro(banner);

    while (true) {
        try {
            await step();
        } catch (err) {
            if (err.message === 'bye') {
                outro('再见');
                return;
            }
            throw err;
        }
    }
}