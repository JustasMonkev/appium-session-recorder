import { startServer } from '../../server/server';
import { DEFAULT_RECORDER_OPTIONS, httpHost } from '../../server/types';
import { ensureNoUnexpectedFlags, expectOptionalString, parseFlags, parseNumberFlag } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runProxyStart(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['host', 'port', 'appium-url']);

    const host = expectOptionalString('host', parsed.flags.host) ?? DEFAULT_RECORDER_OPTIONS.host;
    const port = parseNumberFlag('port', parsed.flags.port) ?? DEFAULT_RECORDER_OPTIONS.port;
    const appiumUrl = expectOptionalString('appium-url', parsed.flags['appium-url'])
        ?? DEFAULT_RECORDER_OPTIONS.appiumUrl;

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer between 1 and 65535');
    }

    const server = await startServer({ host, port, appiumUrl });
    const urlHost = httpHost(host);

    const shutdown = () => {
        server.close(() => process.exit(0));
        server.closeAllConnections?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return {
        command: 'proxy.start',
        result: {
            host,
            port,
            appiumUrl,
            proxyUrl: `http://${urlHost}:${port}`,
            viewerUrl: `http://${urlHost}:${port}/_recorder`,
            running: true,
        },
    };
}
