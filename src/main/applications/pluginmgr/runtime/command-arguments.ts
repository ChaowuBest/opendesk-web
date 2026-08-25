/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { parse as parseShellArguments } from 'shell-quote';
import type {
    PluginCommandArgumentOptions,
    PluginCommandArgsBuilder,
    PluginCommandDefinition,
    PluginCommandOptionOptions,
    PluginCommandResult,
    PluginParsedCommandArgs,
    PluginStructuredCommandDefinition
} from '../../../../../packages/plugin-sdk/src/index.js';

export interface PluginCommandInvocation {
    raw: string;
    argv?: readonly string[];
}

export type PluginCommandArgumentParseResult =
    | { status: 'parsed'; args: string | PluginParsedCommandArgs }
    | { status: 'help'; text: string }
    | { status: 'invalid_arguments'; code: string; message: string; usage: string };

export type PluginCommandRunOutcome =
    | { status: 'success'; result: PluginCommandResult }
    | Exclude<PluginCommandArgumentParseResult, { status: 'parsed' }>;

interface ConfiguredCommandArguments {
    arguments: readonly Argument[];
    options: readonly Option[];
}

interface ConfiguredCommandParser extends ConfiguredCommandArguments {
    command: Command;
    readOutput(): string;
}

const configuredArguments = new WeakMap<PluginStructuredCommandDefinition, ConfiguredCommandArguments>();

export function createPluginCommandInvocationFromText(raw: string): PluginCommandInvocation {
    const tokens = parseShellArguments(raw, (name) => `$${name}`);
    const unsupported = tokens.find((token) => typeof token !== 'string');
    if (unsupported) throw new Error('plugin.command_shell_operator_unsupported');
    return { raw, argv: tokens as string[] };
}

export function preparePluginCommandDefinition(definition: PluginCommandDefinition): void {
    if (definition.args === undefined) return;
    configuredArguments.set(definition, configureArguments(definition.args));
}

export function pluginCommandAcceptsArgs(definition: PluginCommandDefinition): boolean {
    if (definition.args === undefined) return true;
    const configured = getConfiguredArguments(definition);
    return configured.arguments.length > 0 || configured.options.length > 0;
}

export function parsePluginCommandArguments(
    definition: PluginCommandDefinition,
    invocation: PluginCommandInvocation
): PluginCommandArgumentParseResult {
    if (definition.args === undefined) return { status: 'parsed', args: invocation.raw };

    const configured = getConfiguredArguments(definition);
    let argv: readonly string[];
    try {
        argv = invocation.argv ?? createPluginCommandInvocationFromText(invocation.raw).argv ?? [];
    } catch (error) {
        return {
            status: 'invalid_arguments',
            code: 'plugin.command_tokenize_failed',
            message: error instanceof Error ? error.message : String(error),
            usage: createConfiguredParser(definition, configured).command.helpInformation()
        };
    }

    const parser = createConfiguredParser(definition, configured);
    try {
        parser.command.parse([...argv], { from: 'user' });
    } catch (error) {
        if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
            return { status: 'help', text: parser.readOutput() || parser.command.helpInformation() };
        }
        return {
            status: 'invalid_arguments',
            code: error instanceof CommanderError ? error.code : 'plugin.command_parse_failed',
            message: normalizeCommanderMessage(error),
            usage: parser.command.helpInformation()
        };
    }

    return { status: 'parsed', args: buildStructuredArgs(parser) };
}

function configureArguments(configure: (builder: PluginCommandArgsBuilder) => void): ConfiguredCommandArguments {
    const builder = new CommandArgsBuilder();
    configure(builder);
    return builder.finish();
}

function getConfiguredArguments(definition: PluginStructuredCommandDefinition): ConfiguredCommandArguments {
    const existing = configuredArguments.get(definition);
    if (existing) return existing;
    const configured = configureArguments(definition.args);
    configuredArguments.set(definition, configured);
    return configured;
}

class CommandArgsBuilder implements PluginCommandArgsBuilder {
    private readonly definition = new Command();
    private readonly fieldNames = new Set<string>();
    private optionalArgumentSeen = false;

    argument(flags: string, description?: string, options: PluginCommandArgumentOptions = {}): this {
        const argument = new Argument(flags, description);
        validateFieldName(argument.name());
        this.addFieldName(argument.name());
        if (this.optionalArgumentSeen && argument.required) {
            throw new Error(`plugin.command_required_argument_after_optional:${argument.name()}`);
        }
        if (!argument.required) this.optionalArgumentSeen = true;
        configureArgument(argument, options);
        this.definition.addArgument(argument);
        return this;
    }

    option(flags: string, description?: string, options: PluginCommandOptionOptions = {}): this {
        return this.addOption(flags, description, options, false);
    }

    requiredOption(flags: string, description?: string, options: PluginCommandOptionOptions = {}): this {
        return this.addOption(flags, description, options, true);
    }

    finish(): ConfiguredCommandArguments {
        return {
            arguments: [...this.definition.registeredArguments],
            options: [...this.definition.options]
        };
    }

    private addOption(
        flags: string,
        description: string | undefined,
        options: PluginCommandOptionOptions,
        mandatory: boolean
    ): this {
        const option = new Option(flags, description);
        const type = options.type ?? (option.isBoolean() ? 'boolean' : 'string');
        if (type === 'boolean' && !option.isBoolean()) {
            throw new Error(`plugin.command_boolean_option_value_invalid:${option.attributeName()}`);
        }
        if (type !== 'boolean' && option.isBoolean()) {
            throw new Error(`plugin.command_option_value_required:${option.attributeName()}`);
        }
        if (type === 'number' && option.optional) {
            throw new Error(`plugin.command_optional_number_unsupported:${option.attributeName()}`);
        }
        validateFieldName(option.attributeName());
        this.addFieldName(option.attributeName());
        configureOption(option, type, options);
        if (mandatory) option.makeOptionMandatory();
        this.definition.addOption(option);
        return this;
    }

    private addFieldName(name: string): void {
        if (this.fieldNames.has(name)) throw new Error(`plugin.command_argument_duplicate:${name}`);
        this.fieldNames.add(name);
    }
}

function configureArgument(argument: Argument, options: PluginCommandArgumentOptions): void {
    const type = options.type ?? 'string';
    if (options.defaultValue !== undefined) {
        argument.default(normalizeDefaultValue(type, options.defaultValue, options.choices));
    }
    configureValueParser(argument, type, options.choices);
}

function configureOption(
    option: Option,
    type: 'string' | 'number' | 'boolean',
    options: PluginCommandOptionOptions
): void {
    if (options.defaultValue !== undefined) {
        option.default(normalizeDefaultValue(type, options.defaultValue, options.choices));
    }
    if (type !== 'boolean') configureValueParser(option, type, options.choices);
}

function configureValueParser(
    target: Argument | Option,
    type: 'string' | 'number',
    choices?: readonly (string | number)[]
): void {
    if (type === 'string' && choices) {
        target.choices(choices.map(String));
        return;
    }
    if (type === 'number') {
        const numericChoices = choices?.map((choice) => parseFiniteNumber(String(choice), target.name()));
        const defaultValue = target.defaultValue;
        target.argParser((value: string, previous: unknown) => {
            const parsed = parseFiniteNumber(value, target.name());
            if (numericChoices && !numericChoices.includes(parsed)) {
                throw new InvalidArgumentError(`Allowed choices are ${numericChoices.join(', ')}.`);
            }
            if (target.variadic) return collectVariadicValue(parsed, previous, defaultValue);
            return parsed;
        });
    }
}

function normalizeDefaultValue(
    type: 'string' | 'number' | 'boolean',
    value: string | number | boolean | readonly (string | number)[],
    choices?: readonly (string | number)[]
): unknown {
    if (type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error('plugin.command_boolean_default_invalid');
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => normalizeScalarDefault(type, item, choices));
    return normalizeScalarDefault(type, value as string | number, choices);
}

function normalizeScalarDefault(
    type: 'string' | 'number',
    value: string | number,
    choices?: readonly (string | number)[]
): string | number {
    const normalized = type === 'number' ? parseFiniteNumber(String(value), 'default') : String(value);
    const normalizedChoices = choices?.map((choice) =>
        type === 'number' ? parseFiniteNumber(String(choice), 'choice') : String(choice)
    );
    if (normalizedChoices && !normalizedChoices.includes(normalized)) {
        throw new Error(`plugin.command_default_not_in_choices:${String(value)}`);
    }
    return normalized;
}

function parseFiniteNumber(value: string, name: string): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new InvalidArgumentError(`Expected a finite number for '${name}'.`);
    return numeric;
}

function collectVariadicValue(value: unknown, previous: unknown, defaultValue: unknown): unknown[] {
    if (previous === defaultValue || !Array.isArray(previous)) return [value];
    return [...previous, value];
}

function createConfiguredParser(
    definition: PluginStructuredCommandDefinition,
    configured: ConfiguredCommandArguments
): ConfiguredCommandParser {
    let output = '';
    const command = new Command(definition.name)
        .description(definition.description)
        .exitOverride()
        .allowExcessArguments(false)
        .configureOutput({
            writeOut: (text) => {
                output += text;
            },
            writeErr: (text) => {
                output += text;
            }
        });

    for (const argument of configured.arguments) command.addArgument(argument);
    for (const option of configured.options) command.addOption(option);
    return { command, ...configured, readOutput: () => output };
}

function buildStructuredArgs(parser: ConfiguredCommandParser): PluginParsedCommandArgs {
    const result: Record<string, unknown> = {};
    parser.arguments.forEach((argument, index) => {
        result[argument.name()] = parser.command.processedArgs[index];
    });
    const parsedOptions = parser.command.opts<Record<string, unknown>>();
    for (const option of parser.options) {
        const name = option.attributeName();
        const value = parsedOptions[name];
        result[name] = option.isBoolean() && value === undefined ? false : value;
    }
    return result;
}

function validateFieldName(name: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`plugin.command_argument_name_invalid:${name}`);
}

function normalizeCommanderMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^error:\s*/i, '').trim();
}
