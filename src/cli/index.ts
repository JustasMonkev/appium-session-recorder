import * as p from '@clack/prompts';
import { resolveConfig, saveConfig } from './config.js';
import { runPrompts } from './prompts.js';
import { startServer } from '../server/index.js';
import type { RecorderOptions } from '../server/types.js';

function parseArgs(): Partial<RecorderOptions> & { help?: boolean; version?: boolean } {
    const args = process.argv.slice(2);
    const parsed: any = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else if (arg === '--version' || arg === '-v') {
            parsed.version = true;
        } else if (arg === '--port' || arg === '-p') {
            if (i + 1 >= args.length) {
                console.error('Error: --port requires a value');
                process.exit(1);
            }
            parsed.port = Number(args[++i]);
            if (isNaN(parsed.port)) {
                console.error('Error: --port must be a number');
                process.exit(1);
            }
        } else if (arg === '--appium-url' || arg === '-u') {
            if (i + 1 >= args.length) {
                console.error('Error: --appium-url requires a value');
                process.exit(1);
            }
            parsed.appiumUrl = args[++i];
        } else if (arg === '--host') {
            if (i + 1 >= args.length) {
                console.error('Error: --host requires a value');
                process.exit(1);
            }
            parsed.host = args[++i];
        }
    }

    return parsed;
}

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
  3. .appiumrc.json file (current directory or home directory)
  4. Environment variables (PROXY_PORT, APPIUM_URL, PROXY_HOST)
  5. Default values
`);
}

function showVersion() {
    console.log('Appium Session Recorder v2.0.0');
}

export async function runCLI() {
    const args = parseArgs();

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

    let promptConfig: Partial<RecorderOptions> & { saveConfig?: boolean } = {};

    if (!hasRequiredArgs) {
        // Run interactive prompts
        promptConfig = await runPrompts();

        if (promptConfig.saveConfig) {
            const configToSave: RecorderOptions = {
                port: promptConfig.port!,
                appiumUrl: promptConfig.appiumUrl!,
                host: promptConfig.host || '127.0.0.1',
            };
            saveConfig(configToSave);
            p.outro('✅ Configuration saved to .appiumrc.json');
        }
    }

    // Resolve final configuration
    const config = resolveConfig(args, promptConfig);

    // Display startup banner
    console.log('');
    p.intro('🎬 Starting Appium Session Recorder');

    const s = p.spinner();
    s.start('Initializing server...');

    try {
        // Start server
        startServer(config);
        s.stop('✅ Server initialized');

        console.log('');
        console.log(`📊 Configuration:`);
        console.log(`   Port:       ${config.port}`);
        console.log(`   Appium URL: ${config.appiumUrl}`);
        console.log(`   Host:       ${config.host}`);

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
