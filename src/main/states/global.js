const { TaskManagerState, TaskState } = require('./tasks');


/**
 * @property {TaskManagerState} taskManagerState
 */
class GlobalState {

    constructor () {
        this.taskManagerState = new TaskManagerState();
    }

    static initialize() {
        this.getInstance();
    }

    /**
     * Get the unique global state instance
     * @returns {GlobalState}
     */
    static getInstance () {
        if (!GlobalState.instance) {
            let existingGlobalState = GlobalState.load();
            if (existingGlobalState !== null) {
                console.info('loading existing global state instance')
                GlobalState.instance = existingGlobalState;
            } else {
                console.info('creating new global state instance')
                GlobalState.instance = new GlobalState();
            }
        }

        return GlobalState.instance;
    }

    static load() {
        let taskManagerState = TaskManagerState.load();
        if (taskManagerState === null) {
            return null;
        }

        var globalState = new GlobalState();
        globalState.taskManagerState = taskManagerState;
        return globalState;
    }
}

module.exports = { GlobalState }