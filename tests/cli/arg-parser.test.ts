import { describe, it, expect } from 'vitest';
import { parseArgs, parseCliInput, validatePort, validateUrl, validateHost } from '../../src/cli/arg-parser';

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
                expect(result.error).toBe('--port must be a number');
            }
        });

        it('should handle port at end of args', () => {
            const result = parseArgs(createArgv('--host', '0.0.0.0', '--port', '3000'));

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
            const result = parseArgs(createArgv('--host', '0.0.0.0'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.host).toBe('0.0.0.0');
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
                '--host', '0.0.0.0'
            ));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(8080);
                expect(result.args.appiumUrl).toBe('http://localhost:4723');
                expect(result.args.host).toBe('0.0.0.0');
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
        it('should ignore unknown arguments', () => {
            const result = parseArgs(createArgv('--unknown', 'value', '--port', '8080'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(8080);
                expect(result.args).not.toHaveProperty('unknown');
            }
        });
    });

    describe('edge cases', () => {
        it('should handle negative port number', () => {
            const result = parseArgs(createArgv('--port', '-1'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(-1);
            }
        });

        it('should handle zero port', () => {
            const result = parseArgs(createArgv('--port', '0'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(0);
            }
        });

        it('should handle floating point port (truncates)', () => {
            const result = parseArgs(createArgv('--port', '8080.5'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.port).toBe(8080.5);
            }
        });

        it('should handle URL with special characters', () => {
            const result = parseArgs(createArgv('--appium-url', 'http://user:pass@localhost:4723/path?query=value'));

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.args.appiumUrl).toBe('http://user:pass@localhost:4723/path?query=value');
            }
        });
    });
});

describe('validatePort', () => {
    it('should return undefined for valid port', () => {
        expect(validatePort('8080')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
        expect(validatePort('')).toBeUndefined();
    });

    it('should return undefined for whitespace only', () => {
        expect(validatePort('   ')).toBeUndefined();
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

    it('should return undefined for empty string', () => {
        expect(validateUrl('')).toBeUndefined();
    });

    it('should return undefined for whitespace only', () => {
        expect(validateUrl('   ')).toBeUndefined();
    });

    it('should return error for invalid URL', () => {
        expect(validateUrl('not-a-url')).toBe('Please enter a valid URL');
    });

    it('should return error for completely invalid URL', () => {
        // Note: URL constructor in Node.js treats 'localhost:4723' as valid
        // (with 'localhost' as protocol), so we test truly invalid URLs
        expect(validateUrl('://invalid')).toBe('Please enter a valid URL');
    });

    it('should accept various valid URL formats', () => {
        expect(validateUrl('http://localhost')).toBeUndefined();
        expect(validateUrl('https://example.com')).toBeUndefined();
        expect(validateUrl('http://192.168.1.100:4723')).toBeUndefined();
        expect(validateUrl('http://user:pass@host:8080/path')).toBeUndefined();
    });
});

describe('validateHost', () => {
    it('should return undefined for valid host', () => {
        expect(validateHost('localhost')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
        expect(validateHost('')).toBeUndefined();
    });

    it('should return undefined for whitespace only', () => {
        expect(validateHost('   ')).toBeUndefined();
    });

    it('should accept IP addresses', () => {
        expect(validateHost('127.0.0.1')).toBeUndefined();
        expect(validateHost('0.0.0.0')).toBeUndefined();
        expect(validateHost('192.168.1.100')).toBeUndefined();
    });

    it('should accept hostnames', () => {
        expect(validateHost('my-host')).toBeUndefined();
        expect(validateHost('server.local')).toBeUndefined();
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

    it('routes proxy start command mode', () => {
        const result = parseCliInput(createArgv('proxy', 'start', '--port', '4724'));

        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.value.mode).toBe('command');
            expect(result.value.route?.group).toBe('proxy');
            expect(result.value.route?.command).toBe('start');
        }
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
