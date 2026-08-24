import type { RecorderOptions } from '../server/types';
import { isSafeAppiumUrl } from '../core/appium/client';

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
            if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
                return { success: false, error: '--port requires a value' };
            }
            const value = args[++i];
            if (validatePort(value)) return { success: false, error: '--port must be an integer between 1 and 65535' };
            parsed.port = Number(value);
        } else if (arg === '--appium-url' || arg === '-u') {
            if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
                return { success: false, error: '--appium-url requires a value' };
            }
            const value = args[++i];
            if (validateUrl(value)) {
                return { success: false, error: '--appium-url must be an HTTP(S) URL without credentials, query, or fragment' };
            }
            parsed.appiumUrl = value;
        } else if (arg === '--host') {
            if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
                return { success: false, error: '--host requires a value' };
            }
            const value = args[++i];
            if (validateHost(value)) return { success: false, error: '--host must be localhost, 127.0.0.1, or ::1' };
            parsed.host = value;
        } else {
            return { success: false, error: `Unknown argument '${arg}'` };
        }
    }

    return { success: true, args: parsed };
}

export function validatePort(value: string): string | undefined {
    const num = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(num) || num < 1 || num > 65535) {
        return 'Please enter a valid port number (1-65535)';
    }
    return undefined;
}

export function validateUrl(value: string): string | undefined {
    return isSafeAppiumUrl(value)
        ? undefined
        : 'Please enter a valid HTTP(S) URL without credentials, query, or fragment';
}

export function validateHost(value: string): string | undefined {
    return ['localhost', '127.0.0.1', '::1'].includes(value)
        ? undefined
        : 'Please enter localhost, 127.0.0.1, or ::1';
}

export type GlobalCliOptions = {
    pretty: boolean;
    output?: string;
};

export type CommandRoute = {
    group: 'proxy' | 'session' | 'screen' | 'selectors' | 'drive';
    command: string;
    args: string[];
};

export type ParsedCliInput = {
    mode: 'legacy' | 'command';
    global: GlobalCliOptions;
    legacyArgv?: string[];
    route?: CommandRoute;
};

export type ParseCliInputResult =
    | { success: true; value: ParsedCliInput }
    | { success: false; error: string };

const commandSubcommands: Record<CommandRoute['group'], string[]> = {
    proxy: ['start'],
    session: ['create', 'delete'],
    screen: ['snapshot', 'elements'],
    selectors: ['best'],
    drive: ['tap', 'type', 'back', 'swipe', 'scroll'],
};

function isCommandGroup(value: string): value is CommandRoute['group'] {
    return Object.hasOwn(commandSubcommands, value);
}

const LEGACY_GLOBAL_FLAGS_ERROR = '--pretty and --output are only supported with <group> <command> mode';

function hasLegacyOnlyGlobalFlags(global: GlobalCliOptions): boolean {
    return global.pretty || global.output !== undefined;
}

export function parseCliInput(argv: string[]): ParseCliInputResult {
    const input = argv.slice(2);
    const global: GlobalCliOptions = { pretty: false };
    const remaining: string[] = [];
    let wantsHelp = false;
    let wantsVersion = false;

    for (let i = 0; i < input.length; i++) {
        const token = input[i];

        if (token === '--pretty') {
            global.pretty = true;
            continue;
        }

        if (token === '--output') {
            const value = input[i + 1];
            if (!value || value.startsWith('-')) {
                return { success: false, error: '--output requires a file path value' };
            }
            global.output = value;
            i++;
            continue;
        }

        if (token === '--help' || token === '-h') {
            wantsHelp = true;
            continue;
        }

        if (token === '--version' || token === '-v') {
            wantsVersion = true;
            continue;
        }

        remaining.push(token);
    }

    if (wantsHelp) {
        if (hasLegacyOnlyGlobalFlags(global)) {
            return { success: false, error: LEGACY_GLOBAL_FLAGS_ERROR };
        }
        return {
            success: true,
            value: {
                mode: 'legacy',
                global,
                legacyArgv: ['node', 'script', '--help'],
            },
        };
    }

    if (wantsVersion) {
        if (hasLegacyOnlyGlobalFlags(global)) {
            return { success: false, error: LEGACY_GLOBAL_FLAGS_ERROR };
        }
        return {
            success: true,
            value: {
                mode: 'legacy',
                global,
                legacyArgv: ['node', 'script', '--version'],
            },
        };
    }

    if (remaining.length === 0) {
        if (hasLegacyOnlyGlobalFlags(global)) {
            return { success: false, error: LEGACY_GLOBAL_FLAGS_ERROR };
        }
        return {
            success: true,
            value: {
                mode: 'legacy',
                global,
                legacyArgv: ['node', 'script'],
            },
        };
    }

    const maybeGroup = remaining[0];
    if (maybeGroup.startsWith('-')) {
        if (hasLegacyOnlyGlobalFlags(global)) {
            return { success: false, error: LEGACY_GLOBAL_FLAGS_ERROR };
        }
        return {
            success: true,
            value: {
                mode: 'legacy',
                global,
                legacyArgv: [...argv.slice(0, 2), ...remaining],
            },
        };
    }
    if (!isCommandGroup(maybeGroup)) {
        if (hasLegacyOnlyGlobalFlags(global)) {
            return { success: false, error: LEGACY_GLOBAL_FLAGS_ERROR };
        }
        return { success: false, error: `Unknown command group '${maybeGroup}'` };
    }

    const subcommand = remaining[1];
    if (!subcommand) {
        return { success: false, error: `Missing subcommand for '${maybeGroup}'` };
    }

    const allowed = commandSubcommands[maybeGroup];
    if (!allowed.includes(subcommand)) {
        return {
            success: false,
            error: `Unknown subcommand '${subcommand}' for '${maybeGroup}'. Allowed: ${allowed.join(', ')}`,
        };
    }

    return {
        success: true,
        value: {
            mode: 'command',
            global,
            route: {
                group: maybeGroup,
                command: subcommand,
                args: remaining.slice(2),
            },
        },
    };
}

export type ParseFlagsResult =
    | { success: true; flags: Record<string, string | boolean>; positionals: string[] }
    | { success: false; error: string };

export function parseFlags(args: string[]): ParseFlagsResult {
    const flags: Record<string, string | boolean> = Object.create(null);
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];

        if (!token.startsWith('-')) {
            positionals.push(token);
            continue;
        }

        if (!token.startsWith('--')) {
            return { success: false, error: `Short options are not supported in command mode: '${token}'` };
        }

        const equalsIndex = token.indexOf('=');
        if (equalsIndex > -1) {
            const key = token.slice(2, equalsIndex);
            const value = token.slice(equalsIndex + 1);
            if (!key) return { success: false, error: `Invalid flag '${token}'` };
            flags[key] = value;
            continue;
        }

        const key = token.slice(2);
        if (!key) return { success: false, error: `Invalid flag '${token}'` };

        const next = args[i + 1];
        if (!next || next.startsWith('--')) {
            flags[key] = true;
            continue;
        }

        flags[key] = next;
        i++;
    }

    return { success: true, flags, positionals };
}

export function parseNumberFlag(name: string, value: string | boolean | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`--${name} requires a value`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`--${name} must be a number`);
    }
    return parsed;
}

export function expectStringFlag(name: string, value: string | boolean | undefined): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`--${name} is required`);
    }
    return value;
}

export function expectOptionalString(name: string, value: string | boolean | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`--${name} requires a value`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`--${name} requires a non-empty value`);
    return trimmed;
}

export function parseBooleanFlag(name: string, value: string | boolean | undefined): boolean {
    if (typeof value === 'string') throw new Error(`--${name} does not take a value`);
    return value ?? false;
}

export function ensureNoUnexpectedFlags(
    flags: Record<string, string | boolean>,
    allowed: string[],
): void {
    const unknown = Object.keys(flags).filter(key => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`Unknown flags: ${unknown.map(flag => `--${flag}`).join(', ')}`);
    }
}
