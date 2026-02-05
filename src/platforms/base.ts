import open from 'open';


export abstract class AbstractPlatform {
    static async openPath(filePath: string) {
        await open(filePath);
    }

    static async showItemInFolder(filePath: string) {

    }

    static getWorkerPath(): string {
        throw new Error('getWorkerPath not implemented');
    }
}

let __platform: typeof AbstractPlatform | null = null;

export function setPlatform(platform: typeof AbstractPlatform) {
    __platform = platform;
}

export function getPlatform(): typeof AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}
