import { XMLValidator } from 'fast-xml-parser';
import {
    Parser,
    Tokenizer,
    type DefaultTreeAdapterMap,
    type DefaultTreeAdapterTypes,
} from 'parse5';

export const MAX_XML_ELEMENTS = 10_000;
export const MAX_XML_DEPTH = 96;
export const MAX_XML_CHARS = 10_000_000;
export const MAX_XML_TOKENS = 32_000;
export const MAX_XML_ATTRIBUTES = 32_000;
export const MAX_XML_MARKUP_CHARS = 256 * 1024;
export const MAX_XML_PATH_SEGMENT_CHARS = 512;
export const MAX_XML_GENERATED_PATH_CHARS = 8 * 1024 * 1024;
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_HTML_ATTRIBUTES_PER_ELEMENT = 1_024;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SIMPLE_XPATH_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

function tagEnd(xml: string, start: number): number {
    let quote = '';
    for (let index = start; index < xml.length; index++) {
        if (index - start > MAX_XML_MARKUP_CHARS) return -1;
        const character = xml[index];
        if (quote) {
            if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }
    return -1;
}

function skipHtmlPrefix(source: string, start: number): number {
    let cursor = start;
    while (true) {
        while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
        if (!source.startsWith('<!--', cursor)) return cursor;
        let close = cursor + 4;
        while (
            close < source.length
            && !(
                source[close] === '-'
                && source[close + 1] === '-'
                && (
                    source[close + 2] === '>'
                    || (source[close + 2] === '!' && source[close + 3] === '>')
                )
            )
        ) close++;
        if (close >= source.length) return -1;
        cursor = close + (source[close + 2] === '>' ? 3 : 4);
    }
}

function isHtmlDocument(source: string): boolean {
    if (source.length > MAX_XML_CHARS) return false;
    let cursor = skipHtmlPrefix(source, 0);
    if (cursor < 0) return false;
    const doctype = '<!doctype';
    if (
        source.slice(cursor, cursor + doctype.length).toLowerCase() === doctype
        && /\s/.test(source[cursor + doctype.length] ?? '')
    ) {
        let nameStart = cursor + doctype.length + 1;
        while (nameStart < source.length && /\s/.test(source[nameStart])) nameStart++;
        if (
            source.slice(nameStart, nameStart + 4).toLowerCase() !== 'html'
            || !/[\s>]/.test(source[nameStart + 4] ?? '')
        ) return false;
        const end = tagEnd(source, cursor + 1);
        if (end < 0) return false;
        cursor = skipHtmlPrefix(source, end + 1);
        if (cursor < 0) return false;
    }
    return source.slice(cursor, cursor + 5).toLowerCase() === '<html'
        && /[\s>]/.test(source[cursor + 5] ?? '');
}

function attributeCount(content: string): number {
    let count = 0;
    let quote = '';
    for (const character of content) {
        if (quote) {
            if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '=') {
            count++;
        }
    }
    return count;
}

function xmlAttributes(content: string): Array<{ name: string; value: string }> {
    return Array.from(
        content.matchAll(/\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
        match => ({ name: match[1], value: match[2] ?? match[3] }),
    );
}

function qualifiedName(name: string): { prefix?: string; localName: string } | undefined {
    const colon = name.indexOf(':');
    if (colon < 0) return name ? { localName: name } : undefined;
    if (colon === 0 || colon === name.length - 1 || name.indexOf(':', colon + 1) >= 0) return undefined;
    return { prefix: name.slice(0, colon), localName: name.slice(colon + 1) };
}

function decodeXmlReferences(value: string): string {
    return value.replace(/[\t\n\r]/g, ' ').replace(
        /&(?:#(\d+)|#x([\da-fA-F]+)|(amp|lt|gt|quot|apos));/g,
        (_reference, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
            if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
            if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
            if (name === 'amp') return '&';
            if (name === 'lt') return '<';
            if (name === 'gt') return '>';
            if (name === 'quot') return '"';
            return "'";
        },
    );
}

type NamespaceScope = {
    parent?: NamespaceScope;
    bindings: Map<string, string | undefined>;
};

function namespaceBinding(scope: NamespaceScope, prefix: string): string | undefined {
    for (let current: NamespaceScope | undefined = scope; current; current = current.parent) {
        if (current.bindings.has(prefix)) return current.bindings.get(prefix);
    }
    return undefined;
}

function elementNamespaceScope(content: string, parent: NamespaceScope): NamespaceScope | undefined {
    const scope: NamespaceScope = { parent, bindings: new Map() };
    const attributes = xmlAttributes(content);
    for (const attribute of attributes) {
        const { name } = attribute;
        if (!qualifiedName(name)) return undefined;
        const value = decodeXmlReferences(attribute.value);
        if (name === 'xmlns') {
            if (value === XML_NAMESPACE || value === XMLNS_NAMESPACE) return undefined;
            scope.bindings.set('', value || undefined);
            continue;
        }
        if (!name.startsWith('xmlns:')) continue;
        const prefix = name.slice('xmlns:'.length);
        if (
            !prefix
            || prefix === 'xmlns'
            || !value
            || value === XMLNS_NAMESPACE
            || (prefix === 'xml') !== (value === XML_NAMESPACE)
        ) return undefined;
        scope.bindings.set(prefix, value);
    }

    const tagName = content.match(/^([^\s/>]+)/)?.[1];
    const elementName = tagName && qualifiedName(tagName);
    if (!elementName || (elementName.prefix && !namespaceBinding(scope, elementName.prefix))) return undefined;
    const expandedAttributes = new Set<string>();
    for (const { name } of attributes) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const attributeName = qualifiedName(name)!;
        const namespace = attributeName.prefix && namespaceBinding(scope, attributeName.prefix);
        if (attributeName.prefix && !namespace) return undefined;
        const expandedName = `${namespace ?? ''}\0${attributeName.localName}`;
        if (expandedAttributes.has(expandedName)) return undefined;
        expandedAttributes.add(expandedName);
    }
    return scope;
}

function isXmlCharacter(codePoint: number): boolean {
    return codePoint === 0x9
        || codePoint === 0xa
        || codePoint === 0xd
        || (codePoint >= 0x20 && codePoint <= 0xd7ff)
        || (codePoint >= 0xe000 && codePoint <= 0xfffd)
        || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function hasInvalidRawCharacter(value: string): boolean {
    for (const character of value) {
        if (!isXmlCharacter(character.codePointAt(0)!)) return true;
    }
    return false;
}

function hasInvalidHtmlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint !== 0xc && !isXmlCharacter(codePoint)) return true;
    }
    return false;
}

function hasInvalidCharacterReference(value: string): boolean {
    for (const match of value.matchAll(/&#(?:x([\da-fA-F]+)|(\d+));/g)) {
        const hexadecimal = match[1] !== undefined;
        const digits = match[1] ?? match[2];
        let firstSignificant = 0;
        while (digits[firstSignificant] === '0') firstSignificant++;
        const significantLength = digits.length - firstSignificant;
        if (significantLength > (hexadecimal ? 6 : 7)) return true;
        const codePoint = Number.parseInt(digits.slice(firstSignificant) || '0', hexadecimal ? 16 : 10);
        if (!isXmlCharacter(codePoint)) return true;
    }
    return false;
}

function hasInvalidEntityReference(value: string): boolean {
    for (let index = value.indexOf('&'); index >= 0; index = value.indexOf('&', index + 1)) {
        const reference = value.slice(index).match(/^&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/);
        if (!reference) return true;
        index += reference[0].length - 1;
    }
    return false;
}

export type XmlInspection = { elementCount: number };

const HTML_LIMIT_EXCEEDED = Symbol('HTML_LIMIT_EXCEEDED');
type HtmlParser = Parser<DefaultTreeAdapterMap>;
type HtmlStartTag = Parameters<HtmlParser['onStartTag']>[0];
type HtmlEndTag = Parameters<HtmlParser['onEndTag']>[0];
type HtmlComment = Parameters<HtmlParser['onComment']>[0];
type HtmlDoctype = Parameters<HtmlParser['onDoctype']>[0];
type HtmlCharacters = Parameters<HtmlParser['onCharacter']>[0];
type HtmlMarkup = HtmlStartTag | HtmlEndTag | HtmlComment | HtmlDoctype;
type HtmlLimitToken = HtmlMarkup | HtmlCharacters;

class MarkupLimitTokenizer extends Tokenizer {
    private attributes = 0;
    private tagAttributes = 0;

    private checkMarkupLength(): void {
        const start = this.currentToken?.location?.startOffset;
        if (start !== undefined && this.preprocessor.offset - start + 1 > MAX_XML_MARKUP_CHARS) {
            throw HTML_LIMIT_EXCEEDED;
        }
    }

    protected override _consume(): number {
        const codePoint = super._consume();
        this.checkMarkupLength();
        return codePoint;
    }

    protected override _advanceBy(count: number): void {
        super._advanceBy(count);
        this.checkMarkupLength();
    }

    protected override _createStartTagToken(): void {
        this.tagAttributes = 0;
        super._createStartTagToken();
    }

    protected override _createEndTagToken(): void {
        this.tagAttributes = 0;
        super._createEndTagToken();
    }

    protected override _leaveAttrName(): void {
        this.attributes++;
        this.tagAttributes++;
        if (
            this.attributes > MAX_XML_ATTRIBUTES
            || this.tagAttributes > MAX_HTML_ATTRIBUTES_PER_ELEMENT
        ) {
            throw HTML_LIMIT_EXCEEDED;
        }
        super._leaveAttrName();
    }
}

class HtmlLimitParser extends Parser<DefaultTreeAdapterMap> {
    attributes = 0;
    elements = 0;
    tokens = 0;
    private readonly seen = new WeakSet<HtmlLimitToken>();

    constructor(private readonly source: string) {
        super({ scriptingEnabled: false, sourceCodeLocationInfo: true });
        this.tokenizer = new MarkupLimitTokenizer(this.options, this);
    }

    private token(token: HtmlLimitToken): boolean {
        if (this.seen.has(token)) return false;
        this.seen.add(token);
        if (++this.tokens > MAX_XML_TOKENS) throw HTML_LIMIT_EXCEEDED;
        return true;
    }

    private markup(token: HtmlMarkup): boolean {
        if (!this.token(token)) return false;
        if (!token.location || token.location.endOffset - token.location.startOffset > MAX_XML_MARKUP_CHARS) {
            throw HTML_LIMIT_EXCEEDED;
        }
        return true;
    }

    override onStartTag(token: HtmlStartTag): void {
        if (this.markup(token)) {
            this.elements++;
            this.attributes += token.attrs.length;
            if (this.elements > MAX_XML_ELEMENTS || this.attributes > MAX_XML_ATTRIBUTES) {
                throw HTML_LIMIT_EXCEEDED;
            }
        }
        super.onStartTag(token);
    }

    override onEndTag(token: HtmlEndTag): void {
        this.markup(token);
        super.onEndTag(token);
    }

    override onComment(token: HtmlComment): void {
        this.markup(token);
        super.onComment(token);
    }

    override onDoctype(token: HtmlDoctype): void {
        if (this.markup(token)) {
            const location = token.location!;
            if (this.source.slice(location.startOffset, location.endOffset).includes('[')) {
                throw HTML_LIMIT_EXCEEDED;
            }
        }
        super.onDoctype(token);
    }

    override onCharacter(token: HtmlCharacters): void {
        this.token(token);
        super.onCharacter(token);
    }

    override onWhitespaceCharacter(token: HtmlCharacters): void {
        this.token(token);
        super.onWhitespaceCharacter(token);
    }

    override onNullCharacter(): void {
        throw HTML_LIMIT_EXCEEDED;
    }
}

function inspectHtmlTree(document: DefaultTreeAdapterTypes.Document): XmlInspection | undefined {
    const stack = document.childNodes.map(node => ({
        node,
        depth: 1,
        live: true,
        xpath: '',
        siblingIndex: 1,
    })).reverse();
    let attributes = 0;
    let elements = 0;
    let liveElements = 0;
    let generatedPathChars = 0;
    while (stack.length > 0) {
        const entry = stack.pop()!;
        if (!('tagName' in entry.node)) continue;

        elements++;
        if (entry.live) liveElements++;
        attributes += entry.node.attrs.length;
        if (
            elements > MAX_XML_ELEMENTS
            || attributes > MAX_XML_ATTRIBUTES
            || entry.depth > MAX_XML_DEPTH
        ) return undefined;

        let xpath = '';
        if (entry.live) {
            const segment = htmlXpathSegment(entry.node.tagName, entry.node.namespaceURI);
            const path = appendXmlPath(
                entry.xpath,
                segment,
                entry.siblingIndex,
                generatedPathChars,
            );
            if (!path) return undefined;
            xpath = path.path;
            generatedPathChars = path.generatedChars;
        }

        const children: DefaultTreeAdapterTypes.ChildNode[] = 'content' in entry.node
            ? entry.node.content.childNodes
            : entry.node.childNodes;
        const childCounts = new Map<string, number>();
        const childEntries = children.flatMap(node => {
            if (!('tagName' in node)) return [];
            const live = entry.live && !('content' in entry.node);
            const segment = live ? htmlXpathSegment(node.tagName, node.namespaceURI) : '';
            const siblingIndex = (childCounts.get(segment) ?? 0) + 1;
            childCounts.set(segment, siblingIndex);
            return [{
                node,
                depth: entry.depth + 1,
                live,
                xpath,
                siblingIndex,
            }];
        });
        stack.push(...childEntries.reverse());
    }
    return elements > 0 ? { elementCount: liveElements } : undefined;
}

function inspectHtml(html: string): XmlInspection | undefined {
    if (
        !isHtmlDocument(html)
        || html.length > MAX_XML_CHARS
        || hasInvalidHtmlCharacter(html)
    ) return undefined;

    const parser = new HtmlLimitParser(html);
    try {
        parser.tokenizer.write(html, true);
    } catch {
        /* parser failures classify untrusted input as invalid */
        return undefined;
    }
    return inspectHtmlTree(parser.document);
}

export function inspectXml(xml: string): XmlInspection | undefined {
    if (!xml.trim() || xml.length > MAX_XML_CHARS || hasInvalidRawCharacter(xml)) return undefined;

    let depth = 0;
    let elements = 0;
    let tokens = 0;
    let attributes = 0;
    let roots = 0;
    let cursor = 0;
    const openElements: string[] = [];
    const namespaceScopes: NamespaceScope[] = [];
    const rootNamespaceScope: NamespaceScope = {
        bindings: new Map([['xml', XML_NAMESPACE]]),
    };
    while (true) {
        const start = xml.indexOf('<', cursor);
        const textEnd = start < 0 ? xml.length : start;
        if (textEnd > cursor && ++tokens > MAX_XML_TOKENS) return undefined;
        const text = xml.slice(cursor, textEnd);
        if (hasInvalidCharacterReference(text) || hasInvalidEntityReference(text)) return undefined;
        if (depth === 0 && xml.slice(cursor, textEnd).trim()) return undefined;
        if (start < 0) break;
        if (++tokens > MAX_XML_TOKENS) return undefined;

        if (xml.startsWith('<!--', start)) {
            const end = xml.indexOf('-->', start + 4);
            if (end < 0) return undefined;
            if (xml.indexOf('--', start + 4) !== end) return undefined;
            cursor = end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', start)) {
            if (depth === 0) return undefined;
            const end = xml.indexOf(']]>', start + 9);
            if (end < 0) return undefined;
            cursor = end + 3;
            continue;
        }
        if (xml.startsWith('<?', start)) {
            const end = xml.indexOf('?>', start + 2);
            if (end < 0) return undefined;
            cursor = end + 2;
            continue;
        }
        if (xml.startsWith('<!', start)) return undefined;

        const end = tagEnd(xml, start + 1);
        if (end < 0) return undefined;
        const content = xml.slice(start + 1, end).trim();
        if (!content) return undefined;

        const closing = content.startsWith('/');
        const tagName = (closing ? content.slice(1) : content).match(/^([^\s/>]+)/)?.[1];
        if (!tagName) return undefined;

        if (closing) {
            if (openElements.pop() !== tagName) return undefined;
            namespaceScopes.pop();
            depth = openElements.length;
        } else {
            if (
                hasInvalidCharacterReference(content)
                || hasInvalidEntityReference(content)
                || /\sxmlns:[^\s=]+\s*=\s*(["'])\1/.test(content)
            ) return undefined;
            attributes += attributeCount(content);
            if (attributes > MAX_XML_ATTRIBUTES) return undefined;
            const namespaceScope = elementNamespaceScope(
                content,
                namespaceScopes[namespaceScopes.length - 1] ?? rootNamespaceScope,
            );
            if (!namespaceScope) return undefined;
            elements++;
            if (elements > MAX_XML_ELEMENTS) return undefined;
            if (!content.endsWith('/')) {
                if (depth === 0 && ++roots > 1) return undefined;
                openElements.push(tagName);
                namespaceScopes.push(namespaceScope);
                depth = openElements.length;
                if (depth > MAX_XML_DEPTH) return undefined;
            } else if (depth === 0 && ++roots > 1) {
                return undefined;
            }
        }
        cursor = end + 1;
    }

    if (elements === 0 || roots !== 1 || depth !== 0) return undefined;
    let valid = false;
    try {
        valid = XMLValidator.validate(xml) === true;
    } catch {
        /* parser failures classify untrusted input as invalid */
    }
    return valid ? { elementCount: elements } : undefined;
}

export function isXmlWithinLimits(xml: string): boolean {
    return inspectXml(xml) !== undefined;
}

export type PageSourceInspection =
    | (XmlInspection & { format: 'html' })
    | (XmlInspection & { format: 'xml' });

export function inspectPageSource(source: string): PageSourceInspection | undefined {
    const format = isHtmlDocument(source) ? 'html' : 'xml';
    const inspection = format === 'html' ? inspectHtml(source) : inspectXml(source);
    return inspection ? { ...inspection, format } : undefined;
}

export function isSourceWithinLimits(source: string): boolean {
    return inspectPageSource(source) !== undefined;
}

export type XmlToken = {
    kind: 'open' | 'close' | 'self' | 'text' | 'comment' | 'cdata' | 'instruction';
    value: string;
};

function tokenizeValidatedXml(xml: string): XmlToken[] | undefined {
    const tokens: XmlToken[] = [];
    let cursor = 0;
    while (cursor < xml.length) {
        const start = xml.indexOf('<', cursor);
        if (start < 0) {
            tokens.push({ kind: 'text', value: xml.slice(cursor) });
            break;
        }
        if (start > cursor) tokens.push({ kind: 'text', value: xml.slice(cursor, start) });

        let end: number;
        let kind: XmlToken['kind'];
        if (xml.startsWith('<!--', start)) {
            end = xml.indexOf('-->', start + 4) + 3;
            kind = 'comment';
        } else if (xml.startsWith('<![CDATA[', start)) {
            end = xml.indexOf(']]>', start + 9) + 3;
            kind = 'cdata';
        } else if (xml.startsWith('<?', start)) {
            end = xml.indexOf('?>', start + 2) + 2;
            kind = 'instruction';
        } else {
            const tagClose = tagEnd(xml, start + 1);
            end = tagClose + 1;
            const content = xml.slice(start + 1, tagClose).trim();
            kind = content.startsWith('/') ? 'close' : content.endsWith('/') ? 'self' : 'open';
        }
        if (end <= start) return undefined;
        tokens.push({ kind, value: xml.slice(start, end) });
        cursor = end;
    }
    return tokens;
}

export type XmlAnalysis = XmlInspection & { tokens: XmlToken[] };

export function analyzeXml(xml: string): XmlAnalysis | undefined {
    const inspection = inspectXml(xml);
    if (!inspection) return undefined;
    const tokens = tokenizeValidatedXml(xml);
    return tokens ? { ...inspection, tokens } : undefined;
}

export type PageSourceAnalysis =
    | (XmlAnalysis & { format: 'xml' })
    | (XmlInspection & { format: 'html' });

export function analyzePageSource(source: string): PageSourceAnalysis | undefined {
    const inspection = inspectPageSource(source);
    if (!inspection) return undefined;
    if (inspection.format === 'html') return inspection;
    const tokens = tokenizeValidatedXml(source);
    return tokens ? { ...inspection, tokens } : undefined;
}

export function appendXmlPath(
    parent: string,
    segment: string,
    siblingIndex: number,
    generatedChars: number,
): { path: string; generatedChars: number } | undefined {
    if (!segment || segment.length > MAX_XML_PATH_SEGMENT_CHARS) return undefined;

    const suffix = `/${segment}[${siblingIndex}]`;
    const pathLength = parent.length + suffix.length;
    const nextGeneratedChars = generatedChars + pathLength;
    if (nextGeneratedChars > MAX_XML_GENERATED_PATH_CHARS) return undefined;

    return {
        path: parent + suffix,
        generatedChars: nextGeneratedChars,
    };
}

function xpathLiteral(value: string): string {
    if (!value.includes('"')) return `"${value}"`;
    const parts: string[] = [];
    for (const [index, part] of value.split('"').entries()) {
        if (index > 0) parts.push(`'"'`);
        if (part) parts.push(`"${part}"`);
    }
    return parts.length === 1 ? parts[0] : `concat(${parts.join(',')})`;
}

export function htmlXpathSegment(tag: string, namespace: string | null | undefined): string {
    return namespace === HTML_NAMESPACE && SIMPLE_XPATH_NAME.test(tag)
        ? tag
        : `*[local-name(.)=${xpathLiteral(tag)}]`;
}
