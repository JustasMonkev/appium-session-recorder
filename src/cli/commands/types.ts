import type { CliOutputOptions } from '../response';

export type CommandHandlerInput = {
    args: string[];
    output: CliOutputOptions;
};

export type CommandExecutionResult = {
    command: string;
    result: unknown;
};
