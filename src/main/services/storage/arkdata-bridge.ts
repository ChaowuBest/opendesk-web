import type { DatabaseKit } from '../../../platforms/bridges/common.js';

let _kit: DatabaseKit | null = null;

export function setArkdataDatabaseKit(kit: DatabaseKit | null): DatabaseKit | null {
    const previous = _kit;
    _kit = kit;
    return previous;
}

export function getArkdataDatabaseKit(): DatabaseKit {
    if (!_kit) {
        throw new Error(
            'ArkData DatabaseKit not initialized. ' +
                'Worker must call setArkdataDatabaseKit() in initialize() before constructing ArkData IndexDB.'
        );
    }
    return _kit;
}
