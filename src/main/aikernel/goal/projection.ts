import { ChatContext } from '../messages.js';
import type { TaskState } from '../states/tasks.js';

export function buildGoalContextProjection(task: TaskState): ChatContext {
    const projected = new ChatContext();
    projected.system_prompt = task.chat_context.system_prompt;
    projected.messages = [...task.chat_context.messages];
    return projected;
}
