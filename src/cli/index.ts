import * as p from '@clack/prompts';
import { runPrompts } from './prompts';
import { startServer } from '../server';
import { parseArgs, parseCliInput } from './arg-parser';
import { dispatchCommand } from './commands';
import { emitResponse, errorResponse, successResponse } from './response';
import { AppiumCommandError } from '../core/appium/client';
import type { RecorderOptions } from '../server';

function showHelp() {
    console.log(`
🎬 Appium Session Recorder

USAGE:
  bun run cli [legacy-options]
  bun run cli <group> <command> [flags]

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
    console.log('Appium Session Recorder v3.0.0');
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

    // Determine if we need to run interactive prompts
    const hasRequiredArgs = args.port !== undefined || args.appiumUrl !== undefined;

    let promptConfig: Partial<RecorderOptions> = {
        port: args.port,
        appiumUrl: args.appiumUrl,
        host: args.host,
    };

    if (!hasRequiredArgs) {
        // Run interactive prompts
        promptConfig = await runPrompts();
    }

    // Display startup banner
    console.log('');
    p.intro('🎬 Starting Appium Session Recorder');

    const s = p.spinner();
    s.start('Initializing server...');

    try {
        // Start server
        startServer(promptConfig);
        s.stop('✅ Server initialized');

        console.log('');
        console.log(`📊 Configuration:`);
        console.log(`   Port:       ${promptConfig.port}`);
        console.log(`   Appium URL: ${promptConfig.appiumUrl}`);
        console.log(`   Host:       ${promptConfig.host}`);

        p.outro('🚀 Server is running! Press Ctrl+C to stop.');
    } catch (error) {
        s.stop('❌ Failed to start server');
        console.error(error);
        process.exit(1);
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n');
        p.outro('👋 Shutting down...');
        process.exit(0);
    });
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

    const route = cliInput.route!;
    const commandName = `${route.group}.${route.command}`;

    try {
        const execution = await dispatchCommand(route.group, route.command, route.args);
        const response = successResponse(execution.command, execution.result);
        await emitResponse(response, cliInput.global);
    } catch (error) {
        if (error instanceof AppiumCommandError) {
            const response = errorResponse(commandName, error.code, error.message, {
                status: error.status,
                details: error.details,
            });
            await emitResponse(response, cliInput.global);
            process.exit(1);
            return;
        }

        const response = errorResponse(
            commandName,
            'COMMAND_EXECUTION_ERROR',
            error instanceof Error ? error.message : 'Unknown error',
        );
        await emitResponse(response, cliInput.global);
        process.exit(1);
    }
}
