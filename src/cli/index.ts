import * as p from '@clack/prompts';
import { runPrompts } from './prompts';
import { startServer } from '../server';
import { parseArgs } from './arg-parser';
import type { RecorderOptions } from '../server';

function showHelp() {
    console.log(`
🎬 Appium Session Recorder

USAGE:
  bun run cli [options]

OPTIONS:
  -p, --port <number>        Proxy server port (default: 4724)
  -u, --appium-url <url>     Appium server URL (default: http://127.0.0.1:4723)
  --host <host>              Proxy server host (default: 127.0.0.1)
  -h, --help                 Show this help message
  -v, --version              Show version

EXAMPLES:
  bun run cli
  bun run cli --port 8080 --appium-url http://192.168.1.100:4723

CONFIGURATION:
  Configuration is resolved in this order (highest to lowest priority):
  1. Command-line arguments
  2. Interactive prompts
  3. Environment variables (PROXY_PORT, APPIUM_URL, PROXY_HOST)
  4. Default values
`);
}

function showVersion() {
    console.log('Appium Session Recorder v2.0.0');
}

export async function runCLI() {
    const result = parseArgs(process.argv);

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

    let promptConfig: Partial<RecorderOptions> = {};

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
