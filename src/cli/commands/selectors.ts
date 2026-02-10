import { AppiumCommandClient } from '../../core/appium/client';
import { generateSelectorCandidates } from '../../core/selectors/generate-candidates';
import { rankSelectorCandidates } from '../../core/selectors/score-candidates';
import { parseSource } from '../../core/xml/parse-source';
import { ensureNoUnexpectedFlags, expectStringFlag, parseFlags } from '../arg-parser';
import type { CommandExecutionResult } from './types';

export async function runSelectorsBest(args: string[]): Promise<CommandExecutionResult> {
    const parsed = parseFlags(args);
    if (!parsed.success) throw new Error(parsed.error);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected arguments: ${parsed.positionals.join(', ')}`);

    ensureNoUnexpectedFlags(parsed.flags, ['appium-url', 'session-id', 'element-ref']);

    const appiumUrl = expectStringFlag('appium-url', parsed.flags['appium-url']);
    const sessionId = expectStringFlag('session-id', parsed.flags['session-id']);
    const elementRef = expectStringFlag('element-ref', parsed.flags['element-ref']);

    const client = new AppiumCommandClient(appiumUrl);
    const source = await client.getSource(sessionId);
    const parsedSource = parseSource(source);

    const target = parsedSource.elements.find(element => element.elementRef === elementRef);
    if (!target) {
        throw new Error(`Element not found for --element-ref '${elementRef}'`);
    }

    const candidates = generateSelectorCandidates(target);
    const ranked = rankSelectorCandidates(target, parsedSource.elements, candidates);

    return {
        command: 'selectors.best',
        result: {
            sessionId,
            platform: parsedSource.platform,
            elementRef,
            target,
            topSelectors: ranked.slice(0, 5),
            allSelectors: ranked,
        },
    };
}
