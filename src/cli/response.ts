import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResponse } from '../core/types';

export type CliOutputOptions = {
    pretty: boolean;
    output?: string;
};

export function successResponse<T>(command: string, result: T): CommandResponse<T> {
    return {
        ok: true,
        command,
        timestamp: new Date().toISOString(),
        result,
    };
}

export function errorResponse(command: string, code: string, message: string, details?: unknown): CommandResponse {
    return {
        ok: false,
        command,
        timestamp: new Date().toISOString(),
        error: {
            code,
            message,
            details,
        },
    };
}

export async function emitResponse(response: CommandResponse, options: CliOutputOptions): Promise<void> {
    const output = options.pretty
        ? `${JSON.stringify(response, null, 2)}\n`
        : `${JSON.stringify(response)}\n`;

    process.stdout.write(output);

    if (options.output) {
        const outPath = path.resolve(options.output);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, output, 'utf8');
    }
}
