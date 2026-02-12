import { BaseApplication } from '../main/applications/base';
import open from 'open';


export abstract class AbstractPlatform {

    getName(): string {
        throw new Error('Not implemented');
    }

    async openPath(filePath: string) {
        await open(filePath);
    }

    async showItemInFolder(filePath: string) {

    }

    getWorkerPath(): string {
        return process.argv[1];
    }

    getApplicationClasses(): typeof BaseApplication[] {
        return [];
    }
}

let __platform: AbstractPlatform | null = null;

export function setPlatform(platform: AbstractPlatform) {
    __platform = platform;
}

export function getPlatform(): AbstractPlatform {
    if (__platform === null) {
        throw new Error('Platform is not set');
    }
    return __platform;
}
