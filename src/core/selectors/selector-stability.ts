import type { ParsedElement, SelectorCandidate } from '../types';
import { candidateMatchesElement } from './score-candidates';

export type StabilityResult = {
    candidate: SelectorCandidate;
    /** Number of consecutive steps where the selector resolves to exactly one element */
    stableSteps: number;
    /** 1-based index of the first step where the selector fails (0 = never fails) */
    firstFailureStep: number;
    /** Total steps evaluated */
    totalSteps: number;
};

export type StabilityReport = {
    results: StabilityResult[];
    bestCandidate: SelectorCandidate | null;
};

/**
 * Evaluate how stable a set of selector candidates are across a sequence of snapshots.
 * Each snapshot is a list of ParsedElements (one per recorded step).
 *
 * A selector is "stable" at a step if it matches exactly one element in that snapshot.
 */
export function evaluateSelectorStability(
    candidates: SelectorCandidate[],
    snapshots: ParsedElement[][],
): StabilityReport {
    const results: StabilityResult[] = candidates.map((candidate) => {
        let stableSteps = 0;
        let firstFailureStep = 0;

        for (let i = 0; i < snapshots.length; i++) {
            const elements = snapshots[i];
            const matchCount = elements.filter(el => candidateMatchesElement(candidate, el)).length;

            if (matchCount === 1) {
                stableSteps++;
            } else if (firstFailureStep === 0) {
                firstFailureStep = i + 1; // 1-based
            }
        }

        return {
            candidate,
            stableSteps,
            firstFailureStep,
            totalSteps: snapshots.length,
        };
    });

    // Sort by most stable steps descending, then by latest first-failure
    results.sort((a, b) => {
        if (b.stableSteps !== a.stableSteps) return b.stableSteps - a.stableSteps;
        return a.firstFailureStep - b.firstFailureStep; // 0 means never fails, sorts first
    });

    return {
        results,
        bestCandidate: results.length > 0 && results[0].stableSteps > 0
            ? results[0].candidate
            : null,
    };
}
