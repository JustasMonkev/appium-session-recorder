import { createServer } from '../../server/server';
import { ensureNoUnexpectedFlags, expectOptionalString, parseFlags, parseNumberFlag } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runProxyStart(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['host', 'port', 'appium-url']);

    const host = expectOptionalString(parsed.flags.host) ?? '127.0.0.1';
    const port = parseNumberFlag('port', parsed.flags.port) ?? 4724;
    const appiumUrl = expectOptionalString(parsed.flags['appium-url']) ?? 'http://127.0.0.1:4723';

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer between 1 and 65535');
    }

    const { app } = createServer({ host, port, appiumUrl });
    const server = app.listen(port, host);

    process.on('SIGINT', () => {
        server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
        server.close(() => process.exit(0));
    });

    return {
        command: 'proxy.start',
        result: {
            host,
            port,
            appiumUrl,
            proxyUrl: `http://${host}:${port}`,
            viewerUrl: `http://${host}:${port}/_recorder`,
            running: true,
        },
    };
}
