import { analyzeXml, type XmlAnalysis } from '../../../core/xml/xml-limits';

export function formatXml(xml: string, existingAnalysis?: XmlAnalysis): string {
    const analysis = existingAnalysis ?? analyzeXml(xml);
    if (!analysis) return '';
    if (analysis.tokens.some(token =>
        (token.kind === 'text' && token.value.trim())
        || ((token.kind === 'cdata' || token.kind === 'comment' || token.kind === 'instruction')
            && /\r?\n/.test(token.value)))) {
        return xml.endsWith('\n') ? xml : `${xml}\n`;
    }

    const out: string[] = [];
    let indent = 0;
    for (const token of analysis.tokens) {
        const trimmed = token.value.trim();
        if (!trimmed) continue;

        if (token.kind === 'close') indent = Math.max(0, indent - 1);

        for (const line of trimmed.split(/\r?\n/)) {
            out.push('  '.repeat(indent) + line.trim());
        }

        if (token.kind === 'open') indent++;
    }

    return out.length > 0 ? out.join('\n') + '\n' : '';
}
