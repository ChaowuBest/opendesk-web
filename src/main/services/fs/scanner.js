const fastGlob = require('fast-glob');
const { z } = require('zod')
const { FSEntrySchema, Setting } = require('../../utils/setting');


/**
 * @typedef {z.core.output<FSEntrySchema>} FSEntry
 * @property {FSEntry} entry
 */
class FSScanner {

    constructor(entry) {
        /** @type {FSEntry} */
        this.entry = entry;
        this.__interval = null;
    }

    static startFSService() {
        Setting.getInstance().data.filesystems.forEach(fsEntry => {
            new FSScanner(fsEntry).start();
        })
    }

    async start() {
        await this.scan();
        this.__interval = setInterval(() => {
            this.scan();
        }, 20000);
    }

    /**
     * @overload
     * @param {false} withStats
     * @returns {Promise<string[]>}
     * @overload
     * @param {true} withStats
     * @returns {Promise<Object[]>}
     */
    async scan(withStats = false) {
        /** @type {fastGlob.Options} */
        const options = {
            cwd: this.entry.root,
            dot: false,
            stats: withStats,
            suppressErrors: true,
            followSymbolicLinks: false,
            absolute: true,
            caseSensitiveMatch: false,
            ignore: this.entry.exclude_patterns
        }

        console.info(`start scanning files in ${this.entry.root}`)
        const startTime = Date.now();
        var patterns = this.entry.extnames.map(extname => `**/*.${extname}`);
        patterns.push(...this.entry.include_patterns);
        patterns = patterns.filter(pattern => pattern !== '');

        const result = fastGlob(patterns, options);
    }

}

module.exports = { FSScanner };