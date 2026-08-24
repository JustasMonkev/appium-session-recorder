import * as p from '@clack/prompts';
import { runPrompts } from './prompts';
import { startServer } from '../server/server';
import { parseArgs, parseCliInput, validateHost, validatePort, validateUrl } from './arg-parser';
import { dispatchCommand } from './commands';
import { emitResponse, errorResponse, successResponse } from './response';
import { AppiumCommandError } from '../core/appium/client';
import { DEFAULT_RECORDER_OPTIONS, type RecorderOptions } from '../server/types';
import packageJson from '../../package.json';
import type { CommandResponse } from '../core/types';

function showHelp() {
    console.log(`
🎬 Appium Session Recorder

USAGE:
  appium-recorder [legacy-options]
  appium-recorder <group> <command> [flags]

LEGACY OPTIONS:
  -p, --port <number>        Proxy server port (default: 4724)
  -u, --appium-url <url>     Appium server URL (default: http://127.0.0.1:4723)
  --host <host>              Proxy server host (default: 127.0.0.1)
  -h, --help                 Show this help message
  -v, --version              Show version

GLOBAL COMMAND FLAGS:
  --pretty                   Pretty-print JSON output
  --output <path>            Write command JSON output to file
  (supported only with <group> <command> mode)

COMMAND GROUPS:
  proxy start                Start proxy server (JSON-first output)
  session create             Create Appium session
  session delete             Delete Appium session
  screen snapshot            Capture screenshot/source and parsed metadata
  screen elements            List parsed elements
  selectors best             Return top ranked selectors for an element
  drive tap                  Tap element by selector
  drive type                 Type text into element by selector
  drive back                 Navigate back
  drive swipe                Perform swipe gesture
  drive scroll               Scroll in a direction (up/down/left/right)
`);
}

function showVersion() {
    console.log(`Appium Session Recorder v${packageJson.version}`);
}

function readEnvironment(overrides: RecorderOptions): RecorderOptions {
    const options: RecorderOptions = {};
    if (overrides.port === undefined && process.env.PROXY_PORT !== undefined) {
        const error = validatePort(process.env.PROXY_PORT);
        if (error) throw new Error(`Invalid PROXY_PORT: ${error}`);
        options.port = Number(process.env.PROXY_PORT);
    }
    if (overrides.host === undefined && process.env.PROXY_HOST !== undefined) {
        const error = validateHost(process.env.PROXY_HOST);
        if (error) throw new Error(`Invalid PROXY_HOST: ${error}`);
        options.host = process.env.PROXY_HOST;
    }
    if (overrides.appiumUrl === undefined && process.env.APPIUM_URL !== undefined) {
        const error = validateUrl(process.env.APPIUM_URL);
        if (error) throw new Error(`Invalid APPIUM_URL: ${error}`);
        options.appiumUrl = process.env.APPIUM_URL;
    }
    return options;
}

async function runLegacyCLI(argv: string[]): Promise<void> {
    const result = parseArgs(argv);

    if (!result.success) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
    }

    const args = result.args;

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    if (args.version) {
        showVersion();
        process.exit(0);
    }

    const cliOptions: RecorderOptions = {};
    if (args.port !== undefined) cliOptions.port = args.port;
    if (args.appiumUrl !== undefined) cliOptions.appiumUrl = args.appiumUrl;
    if (args.host !== undefined) cliOptions.host = args.host;
    const hasExplicitArgs = Object.keys(cliOptions).length > 0;
    const environment = readEnvironment(cliOptions);
    let promptConfig: RecorderOptions = { ...DEFAULT_RECORDER_OPTIONS, ...environment, ...cliOptions };

    if (!hasExplicitArgs) {
        promptConfig = { ...await runPrompts({ ...DEFAULT_RECORDER_OPTIONS, ...environment }), ...cliOptions };
    }

    console.log('');
    p.intro('🎬 Starting Appium Session Recorder');

    const s = p.spinner();
    s.start('Initializing server...');

    try {
        const server = await startServer(promptConfig);
        s.stop('✅ Server initialized');

        console.log('');
        console.log(`📊 Configuration:`);
        console.log(`   Port:       ${promptConfig.port}`);
        console.log(`   Appium URL: ${promptConfig.appiumUrl}`);
        console.log(`   Host:       ${promptConfig.host}`);

        p.outro('🚀 Server is running! Press Ctrl+C to stop.');
        const shutdown = () => {
            console.log('\n');
            p.outro('👋 Shutting down...');
            server.close(() => process.exit(0));
            server.closeAllConnections?.();
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        s.stop('❌ Failed to start server');
        console.error(error);
        process.exit(1);
    }
}

export async function runCLI(): Promise<void> {
    const parsedInput = parseCliInput(process.argv);

    if (!parsedInput.success) {
        const response = errorResponse('cli.parse', 'CLI_PARSE_ERROR', parsedInput.error);
        await emitResponse(response, { pretty: true });
        process.exit(1);
    }

    const cliInput = parsedInput.value;

    if (cliInput.mode === 'legacy') {
        await runLegacyCLI(cliInput.legacyArgv ?? process.argv);
        return;
    }

    const route = cliInput.route;
    if (!route) throw new Error('Command route is missing');
    const commandName = `${route.group}.${route.command}`;
    let response: CommandResponse;

    try {
        const execution = await dispatchCommand(route.group, route.command, route.args);
        response = successResponse(execution.command, execution.result);
    } catch (error) {
        if (error instanceof AppiumCommandError) {
            response = errorResponse(commandName, error.code, error.message, {
                status: error.status,
                details: error.details,
            });
        } else {
            response = errorResponse(
                commandName,
                'COMMAND_EXECUTION_ERROR',
                error instanceof Error ? error.message : 'Unknown error',
            );
        }
    }

    try {
        await emitResponse(response, cliInput.global);
    } catch (error) {
        response = errorResponse(
            commandName,
            'OUTPUT_WRITE_ERROR',
            error instanceof Error ? error.message : 'Unable to write output file',
        );
        await emitResponse(response, { pretty: cliInput.global.pretty });
    }

    if (!response.ok) process.exit(1);
}
