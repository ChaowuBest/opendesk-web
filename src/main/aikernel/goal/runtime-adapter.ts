export type GoalRuntimeCheckpoint =
    | 'after_completion'
    | 'after_tools'
    | 'after_tool_turn'
    | 'before_finish'
    | 'after_finish_hooks'
    | 'after_hook_backoff';

export interface GoalRuntimeCheckpointOptions {
    includeSupplements?: boolean;
}

export type GoalRuntimeMaterialize = (options?: GoalRuntimeCheckpointOptions) => Promise<boolean>;

export class GoalRuntimeAdapter {
    constructor(private readonly materialize: GoalRuntimeMaterialize) {}

    async checkpoint(_checkpoint: GoalRuntimeCheckpoint, options: GoalRuntimeCheckpointOptions = {}): Promise<boolean> {
        return this.materialize(options);
    }
}
