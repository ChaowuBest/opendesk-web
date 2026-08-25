import type { PluginStructuredCommandDefinition } from '../../../../packages/plugin-sdk/src/index.js';
import {
    createPluginCommandInvocationFromText,
    parsePluginCommandArguments
} from '../../../main/applications/pluginmgr/runtime/command-arguments.js';

const deployCommand: PluginStructuredCommandDefinition<any> = {
    name: 'demo.deploy',
    description: 'Deploy a project',
    args(command) {
        command
            .argument('<environment>', 'Target environment')
            .option('-f, --force', 'Force deployment')
            .option('-r, --replicas <count>', 'Replica count', { type: 'number', defaultValue: 1 })
            .option('--format <format>', 'Output format', {
                choices: ['text', 'json'],
                defaultValue: 'text'
            });
    },
    execute() {}
};

describe('plugin command arguments', () => {
    test('parses named positionals and options into a structured value', () => {
        const result = parsePluginCommandArguments(deployCommand, {
            raw: 'production --replicas 3 --force',
            argv: ['production', '--replicas', '3', '--force']
        });

        expect(result).toEqual({
            status: 'parsed',
            args: {
                environment: 'production',
                force: true,
                replicas: 3,
                format: 'text'
            }
        });
    });

    test('reports missing, invalid and unknown arguments without returning parsed input', () => {
        const missing = parsePluginCommandArguments(deployCommand, { raw: '', argv: [] });
        const invalidNumber = parsePluginCommandArguments(deployCommand, {
            raw: 'production --replicas many',
            argv: ['production', '--replicas', 'many']
        });
        const unknown = parsePluginCommandArguments(deployCommand, {
            raw: 'production --unknown',
            argv: ['production', '--unknown']
        });

        expect(missing.status).toBe('invalid_arguments');
        expect(invalidNumber).toMatchObject({ status: 'invalid_arguments', code: 'commander.invalidArgument' });
        expect(unknown.status).toBe('invalid_arguments');
        for (const result of [missing, invalidNumber, unknown]) {
            if (result.status !== 'invalid_arguments') throw new Error('expected invalid arguments');
            expect(result.message).toBeTruthy();
            expect(result.usage).toContain('demo.deploy');
        }
    });

    test('tokenizes quoted text for TUI and GUI invocations', () => {
        expect(createPluginCommandInvocationFromText('"quality assurance" --format json')).toEqual({
            raw: '"quality assurance" --format json',
            argv: ['quality assurance', '--format', 'json']
        });
    });

    test('returns generated help without treating it as an error', () => {
        const result = parsePluginCommandArguments(deployCommand, { raw: '--help', argv: ['--help'] });

        expect(result.status).toBe('help');
        if (result.status === 'help') {
            expect(result.text).toContain('Usage: demo.deploy');
            expect(result.text).toContain('--replicas <count>');
        }
    });

    test('supports variadic arguments and mandatory options', () => {
        const command: PluginStructuredCommandDefinition<any> = {
            name: 'demo.upload',
            description: 'Upload files',
            args(builder) {
                builder.argument('<files...>', 'Files').requiredOption('--token <token>', 'Access token');
            },
            execute() {}
        };

        expect(
            parsePluginCommandArguments(command, {
                raw: 'one.txt two.txt --token secret',
                argv: ['one.txt', 'two.txt', '--token', 'secret']
            })
        ).toEqual({
            status: 'parsed',
            args: { files: ['one.txt', 'two.txt'], token: 'secret' }
        });
        expect(
            parsePluginCommandArguments(command, {
                raw: 'one.txt',
                argv: ['one.txt']
            })
        ).toMatchObject({ status: 'invalid_arguments', code: 'commander.missingMandatoryOptionValue' });
    });

    test('reports invalid choices', () => {
        const result = parsePluginCommandArguments(deployCommand, {
            raw: 'production --format yaml',
            argv: ['production', '--format', 'yaml']
        });

        expect(result).toMatchObject({ status: 'invalid_arguments', code: 'commander.invalidArgument' });
    });

    test('delegates duplicate option flag validation to Commander during registration', () => {
        const command: PluginStructuredCommandDefinition<any> = {
            name: 'demo.duplicate',
            description: 'Duplicate flags',
            args(builder) {
                builder.option('-f, --force').option('-f, --fresh');
            },
            execute() {}
        };

        expect(() => parsePluginCommandArguments(command, { raw: '', argv: [] })).toThrow(
            "due to conflicting flag '-f'"
        );
    });
});
