import { AppiumCommandClient } from '../../core/appium/client';
import { downloadModel, getModelPath, isModelDownloaded, getModelSize } from '../../core/model/model-downloader';
import { findLitertBinary } from '../../core/model/litert-runner';
import { predictAction, parseFunctionCall, mapToAppiumActions } from '../../core/model/action-predictor';
import { executeActions } from '../../core/model/action-executor';
import { DEFAULT_MOBILE_FUNCTIONS } from '../../core/model/types';
import type { MobileFunction } from '../../core/model/types';
import { ensureNoUnexpectedFlags, expectStringFlag, expectOptionalString, parseFlags } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runModelSetup(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, []);

    const alreadyDownloaded = await isModelDownloaded();
    let modelPath = getModelPath();

    if (!alreadyDownloaded) {
        modelPath = await downloadModel((downloaded, total) => {
            const pct = Math.round((downloaded / total) * 100);
            process.stderr.write(`\rDownloading model... ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
        });
        process.stderr.write('\n');
    }

    const modelSize = await getModelSize();
    const litertBin = await findLitertBinary();

    return {
        command: 'model.setup',
        result: {
            modelPath,
            modelSize,
            modelSizeMB: (modelSize / 1024 / 1024).toFixed(1),
            litertBinaryPath: litertBin,
            litertAvailable: litertBin !== null,
            alreadyDownloaded,
            ready: litertBin !== null,
            message: litertBin
                ? 'Model is ready. Use "model predict" to run inference.'
                : 'Model downloaded but LiteRT-LM binary not found. Install it from https://github.com/nicfab/litert-lm',
        },
    };
}

export async function runModelPredict(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['query', 'litert-path', 'functions']);

    const query = expectStringFlag('query', parsed.flags.query);
    const litertPath = expectOptionalString(parsed.flags['litert-path']);

    let functions: MobileFunction[] = DEFAULT_MOBILE_FUNCTIONS;
    const functionsJson = expectOptionalString(parsed.flags.functions);
    if (functionsJson) {
        functions = JSON.parse(functionsJson);
    }

    const config = litertPath ? { litertBinaryPath: litertPath } : undefined;
    const prediction = await predictAction(query, functions, config);

    const appiumSteps = prediction.action
        ? mapToAppiumActions(prediction.action)
        : [];

    return {
        command: 'model.predict',
        result: {
            query,
            action: prediction.action,
            appiumSteps,
            rawOutput: prediction.rawOutput,
            durationMs: prediction.durationMs,
        },
    };
}

export async function runModelExecute(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['query', 'appium-url', 'session-id', 'litert-path', 'functions', 'dry-run']);

    const query = expectStringFlag('query', parsed.flags.query);
    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const litertPath = expectOptionalString(parsed.flags['litert-path']);
    const dryRun = parsed.flags['dry-run'] === true;

    let functions: MobileFunction[] = DEFAULT_MOBILE_FUNCTIONS;
    const functionsJson = expectOptionalString(parsed.flags.functions);
    if (functionsJson) {
        functions = JSON.parse(functionsJson);
    }

    const config = litertPath ? { litertBinaryPath: litertPath } : undefined;
    const prediction = await predictAction(query, functions, config);

    if (!prediction.action) {
        return {
            command: 'model.execute',
            result: {
                query,
                action: null,
                appiumActions: [],
                success: false,
                rawOutput: prediction.rawOutput,
                durationMs: prediction.durationMs,
                error: 'Model did not return a valid function call',
            },
        };
    }

    const steps = mapToAppiumActions(prediction.action);

    if (dryRun) {
        return {
            command: 'model.execute',
            result: {
                query,
                action: prediction.action,
                appiumActions: steps,
                success: true,
                dryRun: true,
                rawOutput: prediction.rawOutput,
                durationMs: prediction.durationMs,
            },
        };
    }

    const client = new AppiumCommandClient(appiumUrl);
    const execResult = await executeActions(client, sessionId, prediction.action, steps);
    execResult.query = query;

    return {
        command: 'model.execute',
        result: {
            ...execResult,
            rawOutput: prediction.rawOutput,
            durationMs: prediction.durationMs,
        },
    };
}
