#!/usr/bin/env bun
import { runCLI } from './cli/index';

runCLI().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
