import type { RecorderOptions } from '../server/types';

export type ParsedArgs = Partial<RecorderOptions> & {
    help?: boolean;
    version?: boolean;
};

export type ParseArgsResult =
    | { success: true; args: ParsedArgs }
    | { success: false; error: string };

export function parseArgs(argv: string[]): ParseArgsResult {
    const args = argv.slice(2);
    const parsed: ParsedArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else if (arg === '--version' || arg === '-v') {
            parsed.version = true;
        } else if (arg === '--port' || arg === '-p') {
            if (i + 1 >= args.length) {
                return { success: false, error: '--port requires a value' };
            }
            parsed.port = Number(args[++i]);
            if (isNaN(parsed.port)) {
                return { success: false, error: '--port must be a number' };
            }
        } else if (arg === '--appium-url' || arg === '-u') {
            if (i + 1 >= args.length) {
                return { success: false, error: '--appium-url requires a value' };
            }
            parsed.appiumUrl = args[++i];
        } else if (arg === '--host') {
            if (i + 1 >= args.length) {
                return { success: false, error: '--host requires a value' };
            }
            parsed.host = args[++i];
        }
    }

    return { success: true, args: parsed };
}

export function validatePort(value: string): string | undefined {
    if (value.trim().length === 0) return undefined;
    const num = Number(value);
    if (isNaN(num) || num < 1 || num > 65535) {
        return 'Please enter a valid port number (1-65535)';
    }
    return undefined;
}

export function validateUrl(value: string): string | undefined {
    if (value.trim().length === 0) return undefined;
    try {
        new URL(value);
        return undefined;
    } catch {
        return 'Please enter a valid URL';
    }
}

export function validateHost(value: string): string | undefined {
    if (value.trim().length === 0) return undefined;
    if (!value || value.trim().length === 0) {
        return 'Please enter a valid host';
    }
    return undefined;
}
