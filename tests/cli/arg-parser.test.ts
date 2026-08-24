import { describe, it, expect } from 'vitest';
import {
    ensureNoUnexpectedFlags,
    expectOptionalString,
    expectStringFlag,
    parseArgs,
    parseBooleanFlag,
    parseCliInput,
    parseFlags,
    parseNumberFlag,
    validateHost,
    validatePort,
    validateUrl,
} from '../../src/cli/arg-parser';

describe('parseArgs', () => {
    // Helper to simulate argv (node, script, ...args)
    const createArgv = (...args: string[]) => ['node', 'script.js', ...args];

    describe('help flag', () => {
        it('should parse --help flag', () => {
            const result = parseArgs(createArgv('--help'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.help).toBe(true);
            }
        });

        it('should parse -h flag', () => {
            const result = parseArgs(createArgv('-h'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.help).toBe(true);
            }
        });
    });

    describe('version flag', () => {
        it('should parse --version flag', () => {
            const result = parseArgs(createArgv('--version'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.version).toBe(true);
            }
        });

        it('should parse -v flag', () => {
            const result = parseArgs(createArgv('-v'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.version).toBe(true);
            }
        });
    });

    describe('port option', () => {
        it('should parse --port option', () => {
            const result = parseArgs(createArgv('--port', '8080'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(8080);
            }
        });

        it('should parse -p option', () => {
            const result = parseArgs(createArgv('-p', '4724'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(4724);
            }
        });

        it('should return error when --port has no value', () => {
            const result = parseArgs(createArgv('--port'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe('--port requires a value');
            }
        });

        it('should return error when --port is not a number', () => {
            const result = parseArgs(createArgv('--port', 'abc'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe('--port must be an integer between 1 and 65535');
            }
        });

        it('should handle port at end of args', () => {
            const result = parseArgs(createArgv('--host', 'localhost', '--port', '3000'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(3000);
            }
        });
    });

    describe('appium-url option', () => {
        it('should parse --appium-url option', () => {
            const result = parseArgs(createArgv('--appium-url', 'http://localhost:4723'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.appiumUrl).toBe('http://localhost:4723');
            }
        });

        it('should parse -u option', () => {
            const result = parseArgs(createArgv('-u', 'http://192.168.1.100:4723'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.appiumUrl).toBe('http://192.168.1.100:4723');
            }
        });

        it('should return error when --appium-url has no value', () => {
            const result = parseArgs(createArgv('--appium-url'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe('--appium-url requires a value');
            }
        });
    });

    describe('host option', () => {
        it('should parse --host option', () => {
            const result = parseArgs(createArgv('--host', '::1'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.host).toBe('::1');
            }
        });

        it('should return error when --host has no value', () => {
            const result = parseArgs(createArgv('--host'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe('--host requires a value');
            }
        });
    });

    describe('multiple options', () => {
        it('should parse multiple options together', () => {
            const result = parseArgs(createArgv(
                '--port', '8080',
                '--appium-url', 'http://localhost:4723',
                '--host', '127.0.0.1'
            ));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(8080);
                expect(result.args.appiumUrl).toBe('http://localhost:4723');
                expect(result.args.host).toBe('127.0.0.1');
            }
        });

        it('should parse mixed flags and options', () => {
            const result = parseArgs(createArgv(
                '-p', '3000',
                '-u', 'http://test:4723'
            ));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(3000);
                expect(result.args.appiumUrl).toBe('http://test:4723');
            }
        });
    });

    describe('empty args', () => {
        it('should return empty args for no arguments', () => {
            const result = parseArgs(createArgv());

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args).toEqual({});
            }
        });
    });

    describe('unknown args', () => {
        it('should reject unknown arguments', () => {
            const result = parseArgs(createArgv('--unknown', 'value', '--port', '8080'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe("Unknown argument '--unknown'");
            }
        });
    });

    describe('edge cases', () => {
        it('should handle negative port number', () => {
            const result = parseArgs(createArgv('--port', '-1'));

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error).toBe('--port requires a value');
            }
        });

        it('should handle zero port', () => {
            const result = parseArgs(createArgv('--port', '0'));

            expect(result.success).toBe(false);
        });

        it('should reject a floating point port', () => {
            const result = parseArgs(createArgv('--port', '8080.5'));

            expect(result.success).toBe(false);
        });

        it('should reject URL credentials', () => {
            const result = parseArgs(createArgv('--appium-url', 'http://user:pass@localhost:4723/path?query=value'));

            expect(result.success).toBe(false);
        });
    });
});

describe('validatePort', () => {
    it('should return undefined for valid port', () => {
        expect(validatePort('8080')).toBeUndefined();
    });

    it('should reject an empty string', () => {
        expect(validatePort('')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should reject whitespace only', () => {
        expect(validatePort('   ')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for non-numeric string', () => {
        expect(validatePort('abc')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for port below 1', () => {
        expect(validatePort('0')).toBe('Please enter a valid port number (1-65535)');
        expect(validatePort('-1')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should return error for port above 65535', () => {
        expect(validatePort('65536')).toBe('Please enter a valid port number (1-65535)');
        expect(validatePort('99999')).toBe('Please enter a valid port number (1-65535)');
    });

    it('should accept valid port range', () => {
        expect(validatePort('1')).toBeUndefined();
        expect(validatePort('80')).toBeUndefined();
        expect(validatePort('443')).toBeUndefined();
        expect(validatePort('8080')).toBeUndefined();
        expect(validatePort('65535')).toBeUndefined();
    });
});

describe('validateUrl', () => {
    it('should return undefined for valid URL', () => {
        expect(validateUrl('http://localhost:4723')).toBeUndefined();
    });

    it('should reject an empty string', () => {
        expect(validateUrl('')).toBe('Please enter a valid HTTP(S) URL without credentials, query, or fragment');
    });

    it('should reject whitespace only', () => {
        expect(validateUrl('   ')).toBe('Please enter a valid HTTP(S) URL without credentials, query, or fragment');
    });

    it('should return error for invalid URL', () => {
        expect(validateUrl('not-a-url')).toBe('Please enter a valid HTTP(S) URL without credentials, query, or fragment');
    });

    it('should return error for completely invalid URL', () => {
        // Note: URL constructor in Node.js treats 'localhost:4723' as valid
        // (with 'localhost' as protocol), so we test truly invalid URLs
        expect(validateUrl('://invalid')).toBe('Please enter a valid HTTP(S) URL without credentials, query, or fragment');
    });

    it('should accept various valid URL formats', () => {
        expect(validateUrl('http://localhost')).toBeUndefined();
        expect(validateUrl('https://example.com')).toBeUndefined();
        expect(validateUrl('http://192.168.1.100:4723')).toBeUndefined();
        expect(validateUrl('http://host:8080/path')).toBeUndefined();
        expect(validateUrl('http://user:pass@host:8080/path')).toBe(
            'Please enter a valid HTTP(S) URL without credentials, query, or fragment',
        );
        expect(validateUrl('http://host:8080/path?token=x')).toBe(
            'Please enter a valid HTTP(S) URL without credentials, query, or fragment',
        );
        expect(validateUrl('http://host:8080/path#fragment')).toBe(
            'Please enter a valid HTTP(S) URL without credentials, query, or fragment',
        );
        expect(validateUrl('http://host:8080/path?')).toBe(
            'Please enter a valid HTTP(S) URL without credentials, query, or fragment',
        );
        expect(validateUrl('http://host:8080/path#')).toBe(
            'Please enter a valid HTTP(S) URL without credentials, query, or fragment',
        );
    });
});

describe('validateHost', () => {
    it('should return undefined for valid host', () => {
        expect(validateHost('localhost')).toBeUndefined();
    });

    it('should reject an empty string', () => {
        expect(validateHost('')).toBe('Please enter localhost, 127.0.0.1, or ::1');
    });

    it('should reject whitespace only', () => {
        expect(validateHost('   ')).toBe('Please enter localhost, 127.0.0.1, or ::1');
    });

    it('should accept loopback addresses', () => {
        expect(validateHost('127.0.0.1')).toBeUndefined();
        expect(validateHost('::1')).toBeUndefined();
    });

    it('should reject non-loopback hosts', () => {
        expect(validateHost('0.0.0.0')).toBe('Please enter localhost, 127.0.0.1, or ::1');
        expect(validateHost('server.local')).toBe('Please enter localhost, 127.0.0.1, or ::1');
    });
});

describe('parseCliInput', () => {
    const createArgv = (...args: string[]) => ['node', 'script.js', ...args];

    it('keeps no-subcommand invocation in legacy mode', () => {
        const result = parseCliInput(createArgv());

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.value.mode).toBe('legacy');
        }
    });

    it('keeps legacy proxy flags in legacy mode', () => {
        const argv = createArgv('--host', '127.0.0.1', '--port', '4724', '--appium-url', 'http://127.0.0.1:4723');
        const result = parseCliInput(argv);

        expect(result).toEqual({
            success: true,
            value: {
                mode: 'legacy',
                global: { pretty: false },
                legacyArgv: argv,
            },
        });
    });

    it('routes proxy start command mode', () => {
        const result = parseCliInput(createArgv('proxy', 'start', '--port', '4724'));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.value.mode).toBe('command');
            expect(result.value.route?.group).toBe('proxy');
            expect(result.value.route?.command).toBe('start');
        }
    });

    it('rejects an unknown command group in JSON command parsing', () => {
        const result = parseCliInput(createArgv('invalid-subcommand'));
        expect(result).toEqual({ success: false, error: "Unknown command group 'invalid-subcommand'" });
    });

    it('supports global output flags', () => {
        const result = parseCliInput(createArgv(
            'session',
            'delete',
            '--session-id',
            'abc',
            '--appium-url',
            'http://127.0.0.1:4723',
            '--pretty',
            '--output',
            'tmp/out.json',
        ));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.value.global.pretty).toBe(true);
            expect(result.value.global.output).toBe('tmp/out.json');
        }
    });

    it('rejects --pretty in legacy mode', () => {
        const result = parseCliInput(createArgv('--pretty', '--port', '4724'));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('--pretty and --output are only supported with <group> <command> mode');
        }
    });

    it('rejects --output in legacy mode', () => {
        const result = parseCliInput(createArgv('--output', 'out.json', '--appium-url', 'http://127.0.0.1:4723'));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('--pretty and --output are only supported with <group> <command> mode');
        }
    });

    it('rejects mixed --help with command-mode global flags', () => {
        const result = parseCliInput(createArgv('--help', '--pretty'));

        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error).toBe('--pretty and --output are only supported with <group> <command> mode');
        }
    });
});

describe('command flag parsing', () => {
    it('preserves positionals and supports both flag syntaxes', () => {
        expect(parseFlags(['item', '--name', 'value', '--count=2', '--enabled'])).toEqual({
            success: true,
            flags: { name: 'value', count: '2', enabled: true },
            positionals: ['item'],
        });
    });

    it.each(['-', '-p', '--'])('rejects malformed option %s', option => {
        expect(parseFlags([option]).success).toBe(false);
    });

    it('distinguishes missing, numeric, and invalid numeric values', () => {
        expect(parseNumberFlag('limit', undefined)).toBeUndefined();
        expect(parseNumberFlag('limit', '2.5')).toBe(2.5);
        expect(() => parseNumberFlag('limit', true)).toThrow('--limit requires a value');
        expect(() => parseNumberFlag('limit', 'NaN')).toThrow('--limit must be a number');
    });

    it('requires non-empty string values', () => {
        expect(expectStringFlag('name', ' value ')).toBe(' value ');
        expect(() => expectStringFlag('name', true)).toThrow('--name is required');
        expect(() => expectStringFlag('name', '   ')).toThrow('--name is required');
        expect(expectOptionalString('name', undefined)).toBeUndefined();
        expect(expectOptionalString('name', ' value ')).toBe('value');
        expect(() => expectOptionalString('name', true)).toThrow('--name requires a value');
        expect(() => expectOptionalString('name', '')).toThrow('--name requires a non-empty value');
        expect(() => expectOptionalString('name', '   ')).toThrow('--name requires a non-empty value');
    });

    it('only accepts bare boolean flags', () => {
        expect(parseBooleanFlag('enabled', true)).toBe(true);
        expect(parseBooleanFlag('enabled', undefined)).toBe(false);
        expect(() => parseBooleanFlag('enabled', 'false')).toThrow('--enabled does not take a value');
    });

    it('reports every unexpected flag', () => {
        expect(() => ensureNoUnexpectedFlags({ first: true, second: 'x' }, [])).toThrow(
            'Unknown flags: --first, --second',
        );
    });

    it.each(['__proto__', 'constructor', 'prototype'])('rejects inherited-name flag --%s', key => {
        const result = parseFlags([`--${key}`]);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(() => ensureNoUnexpectedFlags(result.flags, [])).toThrow(`--${key}`);
        }
    });
});
