import { intro, outro, text, note, spinner, box, select, SpinnerResult } from '@clack/prompts';
import { GlobalState } from './../states/global.js';
import { ChatContext, UserMessage } from '../agents/messages.js';
import { argv } from 'process';
import cliMarkdown from 'cli-markdown';
import { ApplicationRegistry } from '../applications/registry.js';
import { BaseTaskUpdateSubscriber, TaskUpdateChunk } from '../states/tasks.js';


const state = GlobalState.getInstance();

const banner = `
██╗  ██╗██╗██████╗ ███████╗███████╗██╗  ██╗
██║  ██║██║██╔══██╗██╔════╝██╔════╝██║ ██╔╝
███████║██║██║  ██║█████╗  ███████╗█████╔╝
██╔══██║██║██║  ██║██╔══╝  ╚════██║██╔═██╗
██║  ██║██║██████╔╝███████╗███████║██║  ██╗
╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝`

class CliTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    s: SpinnerResult;

    constructor(s: SpinnerResult) {
        super();
        this.s = s;
        s.start('思考中...');
    }

    send(chunkUpdate: TaskUpdateChunk) {
        this.s.message(`正在组织回答 (已产生 ${chunkUpdate.usage?.total_tokens} 词) `);
    }
}

export async function mainloop() {
    intro(banner);
    var prompt = '';
    if (argv[2]) {
        prompt = argv[2];
    } else {
        prompt = await text({
            message: '你好呀，需要我帮你做什么?',
            placeholder: 'I want to create a new project',
        }).then(result => result.toString());
    }

    if (prompt.trim() === 'bye') {
        outro('再见');
        return;
    }

    const s = spinner();
    s.start('思考中...');
    const task = state.taskManagerState.createTask();
    await task.submitUserMessage(prompt.toString());
    await task.waitUntilFinished((chunkUpdate: TaskUpdateChunk) => {
        s.message(`正在组织回答 (已产生 ${chunkUpdate.usage?.total_tokens} 词) `);
        if (chunkUpdate.task_status === 'stopped') {
            s.stop('思考完成');
            box(
                cliMarkdown((chunkUpdate.last_part as TextMessagePart).text), 'Response',
                { rounded: true, titleAlign: 'center' }
            )
            console.info(chunkUpdate);
        }
    });
}