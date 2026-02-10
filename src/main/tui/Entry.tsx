import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, useStdout } from 'ink';
import { GlobalState } from '../states/global.js';
import { TaskState, TaskUpdateChunk } from '../states/tasks.js';
import { ToolCallMessagePart, TextMessagePart } from '../agents/messages.js';
import { Banner } from '../tui/Banner';
import { AgentInput } from '../tui/AgentInput';
import { ThinkingSpinner } from '../tui/ThinkingSpinner';
import { ToolResultBox } from '../tui/ToolResultBox';
import { ResponseBox } from '../tui/ResponseBox';
import { LogPanel } from '../tui/LogPanel';
import cliMarkdown from 'cli-markdown';


type ToolResult = { toolName: string; result: string };

export function AgentCLI() {
    const { stdout } = useStdout();
    const [terminalSize, setTerminalSize] = useState({ rows: stdout?.rows ?? 24, columns: stdout?.columns ?? 80 });
    useEffect(() => {
        if (!stdout) return;
        const onResize = () => setTerminalSize({ rows: stdout.rows, columns: stdout.columns });
        onResize();
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    const [status, setStatus] = useState<'idle' | 'running'>('idle');
    const [tokenCount, setTokenCount] = useState<number | null>(null);
    const [toolResults, setToolResults] = useState<ToolResult[]>([]);
    const [finalResponse, setFinalResponse] = useState<string | null>(null);
    const [promptMessage, setPromptMessage] = useState('❯');
    const currentTaskRef = useRef<TaskState | null>(null);
    const state = GlobalState.getInstance();
    const initialPromptHandled = useRef(false);

    const handleSubmit = useCallback(
        async (value: string) => {
            const prompt = value.trim();
            if (prompt === '') return;

            if (prompt === 'bye') {
                process.stdout.write('再见\n');
                process.exit(0);
            }

            if (currentTaskRef.current === null) {
                currentTaskRef.current = state.taskManagerState.createTask();
            }
            const task = currentTaskRef.current;

            setStatus('running');
            setTokenCount(null);
            setToolResults([]);
            setFinalResponse(null);

            await task.submitUserMessage(prompt);
            await task.waitUntilFinished((chunkUpdate: TaskUpdateChunk) => {
                setTokenCount(chunkUpdate.usage?.total_tokens ?? null);
                if (chunkUpdate.last_part instanceof ToolCallMessagePart) {
                    for (const tc of chunkUpdate.last_part.toolcalls) {
                        if (tc.status === 'success' && tc.result != null) {
                            setToolResults((prev) => [
                                ...prev,
                                { toolName: tc.tool_name, result: tc.result! },
                            ]);
                        }
                    }
                }
                if (chunkUpdate.task_status === 'stopped') {
                    if (chunkUpdate.last_part instanceof TextMessagePart) {
                        setFinalResponse((chunkUpdate.last_part as TextMessagePart).text);
                    }
                }
            });

            setPromptMessage('接下来有什么新的指示?');
            setStatus('idle');
        },
        [state.taskManagerState]
    );

    // 首次启动时若带有命令行参数 (argv[2])，自动作为第一条提示提交
    useEffect(() => {
        if (initialPromptHandled.current) return;
        const argPrompt = process.argv[2];
        if (argPrompt != null && argPrompt !== '' && status === 'idle') {
            initialPromptHandled.current = true;
            handleSubmit(argPrompt);
        }
    }, [status, handleSubmit]);

    const { columns, rows } = terminalSize;
    return (
        <Box flexDirection="column" width={columns} height={rows} paddingX={1} paddingY={0}>
            <Box flexShrink={0}>
                <Banner />
            </Box>

            {/* 中间可滚动区域占满剩余空间 */}
            <Box flexDirection="column" flexGrow={1} minHeight={0}>
                {status === 'running' && (
                    <Box flexDirection="column" marginBottom={1} flexShrink={0}>
                        <Box marginBottom={1}>
                            <ThinkingSpinner tokenCount={tokenCount} />
                        </Box>
                        {toolResults.map((tr, i) => (
                            <ToolResultBox key={i} toolName={tr.toolName} result={tr.result} />
                        ))}
                    </Box>
                )}

                {finalResponse != null && (
                    <Box marginBottom={1} flexShrink={0}>
                        <ResponseBox title="Response" content={cliMarkdown(finalResponse)} />
                    </Box>
                )}

                <Box flexShrink={0}>
                    <LogPanel maxLines={6} />
                </Box>
            </Box>

            {/* 输入框始终固定在页面最下端 */}
            <Box flexShrink={0}>
                <AgentInput promptLabel={promptMessage} onSubmit={handleSubmit} />
            </Box>
        </Box>
    );
}