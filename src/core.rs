//! Bounded page-source parsing and deterministic Appium selector ranking.
use html5ever::tendril::TendrilSink;
use quick_xml::{Reader, events::Event};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::LazyLock;

pub const MAX_XML_ELEMENTS: usize = 10_000;
pub const MAX_XML_DEPTH: usize = 96;
pub const MAX_XML_CHARS: usize = 10_000_000;
pub const MAX_STABILITY_SNAPSHOTS: usize = 10;
pub const MAX_STABILITY_ELEMENTS: usize = 2_000;
pub const MAX_STABILITY_SOURCE_CHARS: usize = 512 * 1024;
const MAX_ATTRIBUTES: usize = 32_000;
const MAX_TOKENS: usize = 32_000;
const MAX_MARKUP: usize = 256 * 1024;
const MAX_PATH_CHARS: usize = 8 * 1024 * 1024;
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS: &str = "http://www.w3.org/2000/xmlns/";
static XML_NAME: LazyLock<Regex> = LazyLock::new(|| {
    let start = r":A-Za-z_\x{00C0}-\x{00D6}\x{00D8}-\x{00F6}\x{00F8}-\x{02FF}\x{0370}-\x{037D}\x{037F}-\x{1FFF}\x{200C}-\x{200D}\x{2070}-\x{218F}\x{2C00}-\x{2FEF}\x{3001}-\x{D7FF}\x{F900}-\x{FDCF}\x{FDF0}-\x{FFFD}";
    Regex::new(&format!(
        r"^[{start}][{start}\-.0-9\x{{00B7}}\x{{0300}}-\x{{036F}}\x{{203F}}-\x{{2040}}]*$"
    ))
    .unwrap()
});
static BOUNDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]").unwrap());
static ATTR_CONDITION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"@([\w-]+)=(?:"([^"]*)"|'([^']*)')"#).unwrap());
static DYNAMIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z])\d{5,}(?:$|[^a-z])|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|autogen|generated|tmp|temp|anonymous").unwrap()
});
static INDEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\d+\]").unwrap());

pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn bool_at(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
fn empty() -> Value {
    json!({"platform":"unknown","elements":[]})
}
fn xml_character(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r')
        || ('\u{20}'..='\u{d7ff}').contains(&c)
        || ('\u{e000}'..='\u{fffd}').contains(&c)
        || c as u32 >= 0x10000
}
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[derive(Default, Clone)]
struct Node {
    tag: String,
    attrs: HashMap<String, String>,
    children: Vec<usize>,
    namespace: String,
}
#[derive(Clone, Copy, Default)]
struct HtmlContext {
    disabled: bool,
    hidden: bool,
    inert: bool,
}

fn attribute<'a>(attrs: &'a HashMap<String, String>, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|k| attrs.get(*k).filter(|v| !v.is_empty()))
        .map(String::as_str)
        .unwrap_or("")
}
fn number(value: Option<&String>) -> f64 {
    value
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}
fn normalize(node: &Node, xpath: String, index: usize, html: Option<HtmlContext>) -> Value {
    let a = &node.attrs;
    let tag = node.tag.as_str();
    let ty = if html.is_some() {
        tag
    } else {
        let t = attribute(a, &["type", "class"]);
        if t.is_empty() { tag } else { t }
    };
    let platform = if html.is_some() {
        "unknown"
    } else if ty.starts_with("XCUIElementType") {
        "ios"
    } else if ty.starts_with("android.")
        || attribute(a, &["class"]).starts_with("android.")
        || !attribute(a, &["resource-id", "content-desc"]).is_empty()
    {
        "android"
    } else {
        "unknown"
    };
    let rid = attribute(
        a,
        if html.is_some() {
            &["id"][..]
        } else {
            &["resource-id", "resourceId", "id"][..]
        },
    );
    let desc = if html.is_some() {
        ""
    } else {
        attribute(a, &["content-desc", "contentDesc"])
    };
    let name = {
        let s = attribute(a, &["name"]);
        if !s.is_empty() {
            s
        } else if !desc.is_empty() {
            desc
        } else {
            rid
        }
    };
    let label = {
        let s = attribute(a, &["label", "text"]);
        if s.is_empty() { desc } else { s }
    };
    let visible = !["visible", "displayed"]
        .iter()
        .any(|k| matches!(attribute(a, &[*k]), "false" | "0"));
    let truth = |k| matches!(attribute(a, &[k]), "true" | "1");
    let mut enabled = truth("enabled");
    let mut clickable = truth("clickable");
    let mut visible = visible;
    if let Some(ctx) = html {
        let h_visible = !ctx.hidden
            && !a.contains_key("hidden")
            && !(tag == "input" && attribute(a, &["type"]).eq_ignore_ascii_case("hidden"));
        enabled = !ctx.inert
            && !a.contains_key("inert")
            && (!matches!(
                tag,
                "button" | "fieldset" | "input" | "optgroup" | "option" | "select" | "textarea"
            ) || (!ctx.disabled && !a.contains_key("disabled")));
        visible &= h_visible;
        clickable = h_visible
            && enabled
            && (matches!(tag, "button" | "input" | "select" | "textarea")
                || (tag == "a" && a.contains_key("href")));
    }
    let b = BOUNDS
        .captures(attribute(a, &["bounds"]))
        .map(|c| [1, 2, 3, 4].map(|i| c[i].parse::<f64>().unwrap_or(0.0)))
        .unwrap_or([0.0; 4]);
    let coordinate = |key, default| {
        if a.contains_key(key) {
            number(a.get(key))
        } else {
            default
        }
    };
    json!({"elementRef":format!("{platform}:{xpath}"),"index":index,"platform":platform,"type":ty,"xpath":xpath,"name":name,"label":label,"value":attribute(a,&["value"]),"text":attribute(a,&["text","value"]),"resourceId":rid,"contentDesc":desc,"enabled":enabled,"visible":visible,"accessible":truth("accessible"),"clickable":clickable,"x":coordinate("x",b[0]),"y":coordinate("y",b[1]),"width":coordinate("width",(b[2]-b[0]).max(0.0)),"height":coordinate("height",(b[3]-b[1]).max(0.0)),"attributes":a})
}

fn qualified(name: &str) -> Option<(Option<&str>, &str)> {
    if !XML_NAME.is_match(name) {
        return None;
    }
    match name.split_once(':') {
        Some((prefix, local))
            if !prefix.is_empty() && !local.is_empty() && !local.contains(':') =>
        {
            Some((Some(prefix), local))
        }
        Some(_) => None,
        None => Some((None, name)),
    }
}
#[derive(Default)]
struct NamespaceScope {
    parent: Option<Rc<NamespaceScope>>,
    bindings: HashMap<String, String>,
}
impl NamespaceScope {
    fn lookup(&self, prefix: &str) -> Option<&str> {
        let mut scope = Some(self);
        while let Some(current) = scope {
            if let Some(value) = current.bindings.get(prefix) {
                return Some(value);
            }
            scope = current.parent.as_deref();
        }
        None
    }
}
fn namespaces(
    tag: &str,
    attrs: &HashMap<String, String>,
    parent: &Rc<NamespaceScope>,
) -> Option<Rc<NamespaceScope>> {
    let mut scope = NamespaceScope {
        parent: Some(Rc::clone(parent)),
        bindings: HashMap::new(),
    };
    for (key, value) in attrs {
        qualified(key)?;
        if key == "xmlns" {
            if value == XML_NS || value == XMLNS_NS {
                return None;
            }
            scope.bindings.insert(String::new(), value.clone());
        } else if let Some(prefix) = key.strip_prefix("xmlns:") {
            if prefix == "xmlns"
                || value.is_empty()
                || value == XMLNS_NS
                || (prefix == "xml") != (value == XML_NS)
            {
                return None;
            }
            scope.bindings.insert(prefix.into(), value.clone());
        }
    }
    let (prefix, _) = qualified(tag)?;
    if prefix.is_some_and(|p| !scope.lookup(p).is_some_and(|v| !v.is_empty())) {
        return None;
    }
    let mut expanded = HashSet::new();
    for key in attrs
        .keys()
        .filter(|k| *k != "xmlns" && !k.starts_with("xmlns:"))
    {
        let (prefix, local) = qualified(key)?;
        let ns = if let Some(p) = prefix {
            scope.lookup(p).filter(|v| !v.is_empty())?
        } else {
            ""
        };
        if !expanded.insert((ns, local)) {
            return None;
        }
    }
    Some(Rc::new(scope))
}
fn decode_xml(s: &str) -> Option<String> {
    let s = quick_xml::escape::unescape(s).ok()?.into_owned();
    if s.chars().all(xml_character) {
        Some(s)
    } else {
        None
    }
}
fn xml_tree(source: &str) -> Option<Vec<Node>> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut reader = Reader::from_str(source);
    reader.config_mut().check_comments = true;
    let mut nodes: Vec<Node> = Vec::new();
    let mut stack: Vec<(usize, Rc<NamespaceScope>)> = Vec::new();
    let root_ns = Rc::new(NamespaceScope {
        parent: None,
        bindings: HashMap::from([("xml".to_string(), XML_NS.to_string())]),
    });
    let mut roots = 0;
    let mut tokens = 0;
    let mut attrs_total = 0;
    loop {
        let before = reader.buffer_position();
        let event = reader.read_event().ok()?;
        if matches!(event, Event::Eof) {
            break;
        }
        tokens += 1;
        if tokens > MAX_TOKENS {
            return None;
        }
        if !matches!(event, Event::Text(_) | Event::CData(_))
            && (reader.buffer_position() - before) as usize > MAX_MARKUP + 2
        {
            return None;
        }
        match event {
            Event::Start(e) | Event::Empty(e) => {
                let is_empty = source
                    .as_bytes()
                    .get(reader.buffer_position().saturating_sub(2) as usize)
                    == Some(&b'/');
                let tag = std::str::from_utf8(e.name().as_ref()).ok()?.to_owned();
                // quick-xml accepts adjacent quoted attributes; the original XML validator rejects them.
                let raw = e.as_ref();
                let mut quote = None;
                for (i, byte) in raw.iter().copied().enumerate() {
                    if quote == Some(byte) {
                        quote = None;
                        if raw
                            .get(i + 1)
                            .is_some_and(|next| !next.is_ascii_whitespace())
                        {
                            return None;
                        }
                    } else if quote.is_none() && matches!(byte, b'\'' | b'"') {
                        quote = Some(byte);
                    }
                }
                let mut attrs = HashMap::new();
                for attr in e.attributes() {
                    let attr = attr.ok()?;
                    let key = std::str::from_utf8(attr.key.as_ref()).ok()?.to_owned();
                    let raw = std::str::from_utf8(attr.value.as_ref())
                        .ok()?
                        .replace(['\t', '\n', '\r'], " ");
                    if raw.contains('<') {
                        return None;
                    }
                    let value = decode_xml(&raw)?;
                    if attrs.insert(key, value).is_some() {
                        return None;
                    }
                    attrs_total += 1;
                    if attrs_total > MAX_ATTRIBUTES {
                        return None;
                    }
                }
                let ns = namespaces(
                    &tag,
                    &attrs,
                    stack.last().map(|(_, ns)| ns).unwrap_or(&root_ns),
                )?;
                if nodes.len() >= MAX_XML_ELEMENTS || stack.len() + 1 > MAX_XML_DEPTH {
                    return None;
                }
                let index = nodes.len();
                nodes.push(Node {
                    tag,
                    attrs,
                    ..Node::default()
                });
                if let Some((parent, _)) = stack.last() {
                    nodes[*parent].children.push(index);
                } else {
                    roots += 1;
                    if roots > 1 {
                        return None;
                    }
                }
                if !is_empty {
                    stack.push((index, ns));
                }
            }
            Event::End(_) => {
                stack.pop()?;
            }
            Event::Text(t) => {
                let value = t.decode().ok()?;
                decode_xml(&value)?;
                if value.contains("]]>") || (stack.is_empty() && !value.trim().is_empty()) {
                    return None;
                }
            }
            Event::GeneralRef(reference) => {
                let reference = reference.decode().ok()?;
                decode_xml(&format!("&{reference};"))?;
                if stack.is_empty() {
                    return None;
                }
            }
            Event::CData(_) if stack.is_empty() => return None,
            Event::DocType(_) => return None,
            _ => {}
        }
    }
    if roots != 1 || !stack.is_empty() {
        None
    } else {
        Some(nodes)
    }
}
fn html_prefix(mut source: &str) -> Option<&str> {
    loop {
        source = source.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if !source.starts_with("<!--") {
            return Some(source);
        }
        let end = source
            .find("-->")
            .map(|i| i + 3)
            .into_iter()
            .chain(source.find("--!>").map(|i| i + 4))
            .min()?;
        source = &source[end..];
    }
}
fn is_html(source: &str) -> bool {
    let Some(mut rest) = html_prefix(source) else {
        return false;
    };
    if rest
        .get(..9)
        .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))
    {
        let Some(end) = rest.find('>') else {
            return false;
        };
        if !rest[9..end]
            .trim_start()
            .get(..4)
            .is_some_and(|s| s.eq_ignore_ascii_case("html"))
        {
            return false;
        }
        let Some(after) = html_prefix(&rest[end + 1..]) else {
            return false;
        };
        rest = after;
    }
    rest.get(..5)
        .is_some_and(|s| s.eq_ignore_ascii_case("<html"))
        && rest
            .as_bytes()
            .get(5)
            .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>')
}
// Bound markup before the HTML parser allocates its recovered document tree.
fn html_preflight(source: &str) -> Option<()> {
    let bytes = source.as_bytes();
    let lower = source.to_ascii_lowercase();
    let mut cursor = 0;
    let mut tokens = 0;
    let mut elements = 0;
    let mut total_attrs = 0;
    while cursor < bytes.len() {
        let Some(offset) = source[cursor..].find('<') else {
            break;
        };
        cursor += offset;
        tokens += 1;
        if tokens > MAX_TOKENS {
            return None;
        }
        if source[cursor..].starts_with("<!--") {
            let remaining = &source[cursor + 4..];
            let close = remaining
                .find("-->")
                .map(|n| n + 3)
                .into_iter()
                .chain(remaining.find("--!>").map(|n| n + 4))
                .min();
            let end = close.map(|n| cursor + 4 + n).unwrap_or(bytes.len());
            if end - cursor > MAX_MARKUP {
                return None;
            }
            cursor = end;
            continue;
        }
        let start = cursor;
        let mut at = cursor + 1;
        let closing = bytes.get(at) == Some(&b'/');
        if closing {
            at += 1;
        }
        if !bytes.get(at).is_some_and(u8::is_ascii_alphabetic) {
            if bytes.get(at).is_some_and(|b| matches!(b, b'!' | b'?')) {
                let end = source[at..]
                    .find('>')
                    .map(|n| at + n + 1)
                    .unwrap_or(bytes.len());
                if end - start > MAX_MARKUP {
                    return None;
                }
                if lower[start..].starts_with("<!doctype") && source[start..end].contains('[') {
                    return None;
                }
                cursor = end;
            } else {
                cursor += 1;
            }
            continue;
        }
        let name_start = at;
        while at < bytes.len()
            && !bytes[at].is_ascii_whitespace()
            && !matches!(bytes[at], b'/' | b'>')
        {
            at += 1;
        }
        let tag = &lower[name_start..at];
        if !closing {
            elements += 1;
            if elements > MAX_XML_ELEMENTS {
                return None;
            }
        }
        let mut tag_attrs = 0;
        while at < bytes.len() && bytes[at] != b'>' {
            if at - start > MAX_MARKUP {
                return None;
            }
            if bytes[at].is_ascii_whitespace() || bytes[at] == b'/' {
                at += 1;
                continue;
            }
            tag_attrs += 1;
            total_attrs += 1;
            if tag_attrs > 1024 || total_attrs > MAX_ATTRIBUTES {
                return None;
            }
            while at < bytes.len()
                && !bytes[at].is_ascii_whitespace()
                && !matches!(bytes[at], b'/' | b'>' | b'=')
            {
                at += 1;
            }
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            if bytes.get(at) == Some(&b'=') {
                at += 1;
                while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                if let Some(quote @ (b'\'' | b'"')) = bytes.get(at).copied() {
                    at += 1;
                    while at < bytes.len() && bytes[at] != quote {
                        at += 1;
                        if at - start > MAX_MARKUP {
                            return None;
                        }
                    }
                    if at < bytes.len() {
                        at += 1;
                    }
                } else {
                    while at < bytes.len() && !bytes[at].is_ascii_whitespace() && bytes[at] != b'>'
                    {
                        at += 1;
                        if at - start > MAX_MARKUP {
                            return None;
                        }
                    }
                }
            }
        }
        if at - start > MAX_MARKUP {
            return None;
        }
        cursor = (at + 1).min(bytes.len());
        if !closing
            && matches!(
                tag,
                "script" | "style" | "xmp" | "iframe" | "noembed" | "textarea" | "title"
            )
        {
            if let Some(offset) = lower[cursor..].find(&format!("</{tag}")) {
                cursor += offset;
            } else {
                break;
            }
        }
    }
    Some(())
}
fn html_tree(source: &str) -> Option<Vec<Node>> {
    html_preflight(source)?;
    let mut options = html5ever::ParseOpts::default();
    options.tree_builder.scripting_enabled = false;
    let document = html5ever::parse_document(
        scraper::HtmlTreeSink::new(scraper::Html::new_document()),
        options,
    )
    .one(source);
    let mut nodes: Vec<Node> = Vec::new();
    let mut mapping = HashMap::new();
    let mut depths = HashMap::new();
    let mut total_attrs = 0;
    let mut excluded = HashSet::new();
    for node in document.tree.root().descendants() {
        let Some(element) = node.value().as_element() else {
            continue;
        };
        let parent = node.parent();
        let parent_id = parent.as_ref().map(|p| p.id());
        let depth = parent_id
            .and_then(|id| depths.get(&id).copied())
            .unwrap_or(0)
            + 1;
        depths.insert(node.id(), depth);
        total_attrs += element.attrs().count();
        if depths.len() > MAX_XML_ELEMENTS || depth > MAX_XML_DEPTH || total_attrs > MAX_ATTRIBUTES
        {
            return None;
        }
        if parent_id.is_some_and(|id| excluded.contains(&id)) {
            excluded.insert(node.id());
            continue;
        }
        let attrs = element
            .attrs
            .iter()
            .map(|(k, v)| {
                let name = k
                    .prefix
                    .as_ref()
                    .map(|p| format!("{p}:{}", k.local))
                    .unwrap_or_else(|| k.local.to_string());
                (name, v.to_string())
            })
            .collect();
        let index = nodes.len();
        nodes.push(Node {
            tag: element.name().to_owned(),
            attrs,
            children: Vec::new(),
            namespace: element.name.ns.to_string(),
        });
        mapping.insert(node.id(), index);
        if let Some(parent_index) = parent_id.and_then(|id| mapping.get(&id)) {
            nodes[*parent_index].children.push(index);
        }
        if element.name() == "template" {
            excluded.insert(node.id());
        }
    }
    if nodes.is_empty() { None } else { Some(nodes) }
}
fn flatten(nodes: &[Node], html: bool) -> Option<Value> {
    let mut stack = vec![(0, String::new(), 1, HtmlContext::default())];
    let mut elements = Vec::new();
    let mut path_chars = 0;
    while let Some((index, parent, sibling, ctx)) = stack.pop() {
        let node = &nodes[index];
        let segment = if html
            && (node.namespace != "http://www.w3.org/1999/xhtml"
                || !node.tag.chars().enumerate().all(|(i, c)| {
                    c.is_ascii_alphabetic()
                        || c == '_'
                        || (i > 0 && (c.is_ascii_digit() || matches!(c, '.' | '-')))
                })) {
            format!("*[local-name(.)={}]", xpath_literal_full(&node.tag))
        } else {
            node.tag.clone()
        };
        if utf16_len(&segment) > 512 {
            return None;
        }
        let xpath = format!("{parent}/{segment}[{sibling}]");
        path_chars += utf16_len(&xpath);
        if path_chars > MAX_PATH_CHARS {
            return None;
        }
        elements.push(normalize(
            node,
            xpath.clone(),
            elements.len(),
            if html { Some(ctx) } else { None },
        ));
        let mut counts: HashMap<String, usize> = HashMap::new();
        let fieldset = node.tag == "fieldset" && node.attrs.contains_key("disabled");
        let mut legend_seen = false;
        let mut children = Vec::new();
        for child in &node.children {
            let child_node = &nodes[*child];
            let count = counts
                .entry(format!("{}:{}", child_node.namespace, child_node.tag))
                .or_default();
            *count += 1;
            let first_legend = fieldset && child_node.tag == "legend" && !legend_seen;
            legend_seen |= first_legend;
            let child_ctx = HtmlContext {
                disabled: ctx.disabled
                    || (fieldset && !first_legend)
                    || (matches!(node.tag.as_str(), "select" | "optgroup")
                        && node.attrs.contains_key("disabled")),
                hidden: ctx.hidden || node.attrs.contains_key("hidden"),
                inert: ctx.inert || node.attrs.contains_key("inert"),
            };
            children.push((*child, xpath.clone(), *count, child_ctx));
        }
        stack.extend(children.into_iter().rev());
    }
    let platform = if elements.iter().any(|e| string(e, "platform") == "ios") {
        "ios"
    } else if elements.iter().any(|e| string(e, "platform") == "android") {
        "android"
    } else {
        "unknown"
    };
    if platform != "unknown" {
        for e in &mut elements {
            if string(e, "platform") == "unknown" {
                e["platform"] = json!(platform);
                e["elementRef"] = json!(format!("{platform}:{}", string(e, "xpath")));
            }
        }
    }
    Some(json!({"platform":platform,"elements":elements}))
}
/// Invalid, unsupported, or oversized page source produces an empty source, as in the original CLI.
pub fn parse_source(source: &str) -> Result<Value, String> {
    if source.trim().is_empty()
        || source.len() > MAX_XML_CHARS * 4
        || utf16_len(source) > MAX_XML_CHARS
    {
        return Ok(empty());
    }
    let html = is_html(source);
    if source
        .chars()
        .any(|c| !xml_character(c) && !(html && c == '\u{c}'))
    {
        return Ok(empty());
    }
    let nodes = if html {
        html_tree(source)
    } else {
        xml_tree(source)
    };
    Ok(nodes
        .and_then(|nodes| flatten(&nodes, html))
        .unwrap_or_else(empty))
}
pub fn is_source_within_limits(source: &str) -> bool {
    parse_source(source)
        .ok()
        .is_some_and(|v| v["elements"].as_array().is_some_and(|e| !e.is_empty()))
}
fn is_html_element(element: &Value) -> bool {
    string(element, "platform") == "unknown" && string(element, "xpath").starts_with("/html[")
}
fn quoted(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || matches!(c, '\u{7f}' | '\u{2028}' | '\u{2029}') => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            _ => out.push(c),
        }
    }
    out
}
fn xpath_literal(value: &str) -> Option<String> {
    if !value.contains('"') {
        Some(format!("\"{value}\""))
    } else if !value.contains('\'') {
        Some(format!("'{value}'"))
    } else {
        None
    }
}
fn xpath_literal_full(value: &str) -> String {
    if !value.contains('"') {
        return format!("\"{value}\"");
    }
    let mut parts = Vec::new();
    for (i, p) in value.split('"').enumerate() {
        if i > 0 {
            parts.push("'\"'".to_string());
        }
        if !p.is_empty() {
            parts.push(format!("\"{p}\""));
        }
    }
    format!("concat({})", parts.join(","))
}
fn actual_attr<'a>(
    element: &'a Value,
    names: &'a [&str],
    value: &'a str,
) -> Option<(&'a str, &'a str)> {
    if value.is_empty() {
        return None;
    }
    names
        .iter()
        .find(|n| string(&element["attributes"], n) == value)
        .map(|n| (*n, value))
}
fn xpath_node(element: &Value) -> &str {
    string(element, "xpath")
        .rsplit('/')
        .next()
        .unwrap_or("")
        .split('[')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("*")
}
pub fn generate_candidates(element: &Value, _elements: &[Value]) -> Vec<Value> {
    let mut candidates = Vec::new();
    let platform = string(element, "platform");
    let html = is_html_element(element);
    let mut push = |strategy: &str, value: String, p: &str| {
        if !value.is_empty()
            && !candidates
                .iter()
                .any(|e: &Value| string(e, "strategy") == strategy && string(e, "value") == value)
        {
            candidates.push(json!({"strategy":strategy,"value":value,"platform":p}));
        }
    };
    let name = string(element, "name");
    let label = string(element, "label");
    let desc = string(element, "contentDesc");
    let rid = string(element, "resourceId");
    let text = string(element, "text");
    let ty = string(element, "type");
    let primary = if platform == "android" {
        desc
    } else if platform == "ios" || !html {
        [name, label, desc]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("")
    } else {
        ""
    };
    push("accessibility id", primary.into(), platform);
    if platform == "ios" {
        if label != primary {
            push("accessibility id", label.into(), platform);
        }
        if !name.is_empty() {
            push(
                "-ios predicate string",
                format!("name == \"{}\"", quoted(name)),
                platform,
            );
            push(
                "-ios class chain",
                format!(
                    "**/{ty}[`name == \"{}\"`]",
                    quoted(name).replace('`', "\\`")
                ),
                platform,
            );
        }
        if !label.is_empty() {
            push(
                "-ios predicate string",
                format!("label == \"{}\"", quoted(label)),
                platform,
            );
        }
    }
    if platform != "ios" {
        push("id", rid.into(), platform);
    }
    if platform == "android" {
        for (method, value) in [("resourceId", rid), ("description", desc), ("text", text)] {
            if !value.is_empty() {
                push(
                    "-android uiautomator",
                    format!("new UiSelector().{method}(\"{}\")", quoted(value)),
                    platform,
                );
            }
        }
    }
    if !ty.is_empty() {
        let attr = match platform {
            "android" => actual_attr(element, &["resource-id", "resourceId", "id"], rid)
                .or_else(|| actual_attr(element, &["content-desc", "contentDesc"], desc))
                .or_else(|| {
                    actual_attr(
                        element,
                        &["text", "value", "label"],
                        if text.is_empty() { label } else { text },
                    )
                }),
            "ios" => actual_attr(element, &["name"], name)
                .or_else(|| actual_attr(element, &["label"], label)),
            _ => actual_attr(element, &["id", "resource-id", "resourceId"], rid)
                .or_else(|| actual_attr(element, &["name"], name))
                .or_else(|| actual_attr(element, &["label"], label)),
        };
        if let Some((attribute, value)) = attr {
            if let Some(literal) = xpath_literal(value) {
                let mut node = xpath_node(element);
                let mut conditions = Vec::new();
                if !html {
                    if let Some(type_literal) = xpath_literal(ty) {
                        if string(&element["attributes"], "type") == ty {
                            node = "*";
                            conditions.push(format!("@type={type_literal}"));
                        } else if string(&element["attributes"], "class") == ty {
                            node = "*";
                            conditions.push(format!("@class={type_literal}"));
                        }
                    }
                }
                conditions.push(format!("@{attribute}={literal}"));
                push(
                    "xpath",
                    format!("//{node}[{}]", conditions.join(" and ")),
                    "generic",
                );
            }
        }
    }
    push("xpath", string(element, "xpath").into(), "generic");
    let class = if html {
        string(&element["attributes"], "class")
            .split_ascii_whitespace()
            .next()
            .unwrap_or("")
    } else {
        ty
    };
    push("class name", class.into(), "generic");
    candidates
}

fn unquoted(value: &str) -> Option<String> {
    let delimiter = value.chars().next()?;
    if !matches!(delimiter, '\'' | '"') || !value.ends_with(delimiter) || value.len() < 2 {
        return None;
    }
    let inner = &value[1..value.len() - 1];
    let mut chars = inner.chars();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == delimiter {
            return None;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let escaped = chars.next()?;
        match escaped {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() != 4 {
                    return None;
                }
                out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
            }
            '\\' | '"' | '\'' | '`' => out.push(escaped),
            _ => {
                out.push('\\');
                out.push(escaped);
            }
        }
    }
    Some(out)
}
fn predicate_matches(predicate: &str, element: &Value) -> bool {
    let predicate = predicate.trim();
    let Some((field, remainder)) = predicate
        .find(|c: char| c.is_ascii_whitespace() || c == '=')
        .map(|i| predicate.split_at(i))
    else {
        return false;
    };
    let field = field.to_ascii_lowercase();
    if !matches!(field.as_str(), "name" | "label" | "type") {
        return false;
    }
    let remainder = remainder.trim_start();
    let (contains, literal) = if let Some(s) = remainder.strip_prefix("==") {
        (false, s.trim())
    } else if remainder
        .get(..8)
        .is_some_and(|s| s.eq_ignore_ascii_case("contains"))
    {
        (true, remainder[8..].trim())
    } else {
        return false;
    };
    let Some(expected) = unquoted(literal) else {
        return false;
    };
    if contains {
        string(element, &field).contains(&expected)
    } else {
        string(element, &field) == expected
    }
}
/// Match the supported Appium selector subset against one normalized element.
pub fn candidate_matches(candidate: &Value, element: &Value) -> bool {
    let value = string(candidate, "value");
    match string(candidate, "strategy") {
        "id" => {
            string(
                element,
                if string(candidate, "platform") == "ios" {
                    "name"
                } else {
                    "resourceId"
                },
            ) == value
        }
        "accessibility id" => match string(candidate, "platform") {
            "android" => string(element, "contentDesc") == value,
            _ => {
                (string(candidate, "platform") == "ios" || !is_html_element(element))
                    && ["name", "label", "contentDesc"]
                        .iter()
                        .any(|k| string(element, k) == value)
            }
        },
        "class name" => {
            if is_html_element(element) {
                string(&element["attributes"], "class")
                    .split_ascii_whitespace()
                    .any(|s| s == value)
            } else {
                string(element, "type") == value
            }
        }
        "xpath" => {
            if value == string(element, "xpath") {
                return true;
            }
            let attrs: Vec<_> = ATTR_CONDITION.captures_iter(value).collect();
            if attrs.is_empty() {
                return false;
            }
            if let Some(desc) = value.strip_prefix("//") {
                let node = desc.split(['/', '[']).next().unwrap_or("");
                if node != "*" && node != xpath_node(element) {
                    return false;
                }
            }
            attrs.iter().all(|c| {
                element["attributes"].get(&c[1]).and_then(Value::as_str)
                    == c.get(2).or_else(|| c.get(3)).map(|v| v.as_str())
            })
        }
        "-ios predicate string" => predicate_matches(value, element),
        "-ios class chain" => {
            let Some(rest) = value.strip_prefix("**/") else {
                return false;
            };
            if let Some((ty, predicate)) = rest.split_once("[`") {
                ty == string(element, "type")
                    && predicate
                        .strip_suffix("`]")
                        .is_some_and(|p| predicate_matches(p, element))
            } else {
                rest == string(element, "type")
            }
        }
        "-android uiautomator" => {
            let Some(mut rest) = value.strip_prefix("new UiSelector()") else {
                return false;
            };
            if rest.is_empty() {
                return false;
            }
            while !rest.is_empty() {
                let Some(after_dot) = rest.strip_prefix('.') else {
                    return false;
                };
                let Some((method, args)) = after_dot.split_once('(') else {
                    return false;
                };
                let field = match method {
                    "resourceId" => "resourceId",
                    "description" => "contentDesc",
                    "text" => "text",
                    "className" => "type",
                    _ => return false,
                };
                if !args.starts_with('"') {
                    return false;
                }
                let mut escape = false;
                let mut closing = None;
                for (i, c) in args.char_indices().skip(1) {
                    if escape {
                        escape = false;
                    } else if c == '\\' {
                        escape = true;
                    } else if c == '"' {
                        closing = Some(i);
                        break;
                    }
                }
                let Some(closing) = closing else {
                    return false;
                };
                if args.as_bytes().get(closing + 1) != Some(&b')') {
                    return false;
                }
                let Some(expected) = unquoted(&args[..=closing]) else {
                    return false;
                };
                if string(element, field) != expected {
                    return false;
                }
                rest = &args[closing + 2..];
            }
            true
        }
        _ => false,
    }
}
pub fn score_candidates(candidates: Vec<Value>, element: &Value, elements: &[Value]) -> Vec<Value> {
    let mut scored: Vec<Value> = candidates
        .into_iter()
        .map(|mut candidate| {
            let strategy = string(&candidate, "strategy");
            let mut score = match strategy {
                "id" => 100,
                "accessibility id" => 95,
                "-ios predicate string" => 90,
                "-ios class chain" | "-android uiautomator" => 85,
                "xpath" => 70,
                "class name" => 55,
                _ => 50,
            };
            let mut reasons = vec!["BASE_STRATEGY_PRIORITY"];
            let count = elements
                .iter()
                .filter(|e| candidate_matches(&candidate, e))
                .count();
            match count {
                0 => {
                    score -= 40;
                    reasons.push("NO_MATCH");
                }
                1 => {
                    score += 25;
                    reasons.push("UNIQUE_MATCH");
                }
                _ => {
                    score -= 10;
                    reasons.push("MULTIPLE_MATCHES");
                }
            }
            if count > 0 {
                score += 5;
                reasons.push("VALID_MATCH");
            }
            if bool_at(element, "enabled")
                && bool_at(element, "visible")
                && (bool_at(element, "clickable") || bool_at(element, "accessible"))
            {
                score += 8;
                reasons.push("ACTIONABLE_ELEMENT_BONUS");
            }
            let value = string(&candidate, "value");
            if DYNAMIC.is_match(value) {
                score -= 18;
                reasons.push("DYNAMIC_TOKEN_PENALTY");
            }
            if strategy == "xpath" && value.starts_with('/') {
                let mut penalty = 0;
                if value.split('/').filter(|s| !s.is_empty()).count() > 5 {
                    penalty += 8;
                }
                if INDEX.find_iter(value).count() > 3 {
                    penalty += 8;
                }
                if penalty > 0 {
                    score -= penalty;
                    reasons.push("FRAGILE_XPATH_PENALTY");
                }
            }
            candidate["score"] = json!(score);
            candidate["matchCount"] = json!(count);
            candidate["reasons"] = json!(reasons);
            candidate
        })
        .collect();
    scored.sort_by(|a, b| {
        b["score"]
            .as_i64()
            .cmp(&a["score"].as_i64())
            .then(a["matchCount"].as_u64().cmp(&b["matchCount"].as_u64()))
            .then_with(|| string(a, "value").cmp(string(b, "value")))
    });
    for value in &mut scored {
        value["score"] = json!(value["score"].as_i64().unwrap_or(0).clamp(0, 100));
    }
    scored
}
pub fn rank_selectors(element: &Value, elements: &[Value]) -> Vec<Value> {
    score_candidates(generate_candidates(element, elements), element, elements)
}
pub fn evaluate_stability(candidates: &[Value], snapshots: &[Vec<Value>]) -> Value {
    let mut results:Vec<Value>=candidates.iter().map(|candidate|{
        let stable=snapshots.iter().take_while(|elements|elements.iter().filter(|e|candidate_matches(candidate,e)).count()==1).count();
        json!({"candidate":candidate,"stableSteps":stable,"firstFailureStep":if stable==snapshots.len(){0}else{stable+1},"totalSteps":snapshots.len()})
    }).collect();
    results.sort_by(|a, b| b["stableSteps"].as_u64().cmp(&a["stableSteps"].as_u64()));
    let best = results
        .first()
        .filter(|v| v["stableSteps"].as_u64().unwrap_or(0) > 0)
        .map(|v| v["candidate"].clone())
        .unwrap_or(Value::Null);
    json!({"results":results,"bestCandidate":best})
}
pub fn selector_stability(history: &[Value], selector: &Value) -> Value {
    let snapshots: Vec<Vec<Value>> = history
        .iter()
        .filter_map(|v| v.as_array().or_else(|| v["elements"].as_array()))
        .cloned()
        .collect();
    evaluate_stability(std::slice::from_ref(selector), &snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn elements(source: &str) -> Vec<Value> {
        parse_source(source).unwrap()["elements"]
            .as_array()
            .unwrap()
            .clone()
    }
    #[test]
    fn android_normalization_and_unique_ranking() {
        let all = elements(
            r#"<hierarchy><node class="android.widget.Button" resource-id="app:id/go" content-desc="Go" text="Continue" bounds="[-5,2][15,32]" enabled="true" clickable="true"/></hierarchy>"#,
        );
        assert_eq!(all[0]["platform"], "android");
        assert_eq!(all[1]["x"], -5.0);
        assert_eq!(all[1]["width"], 20.0);
        assert_eq!(all[1]["xpath"], "/hierarchy[1]/node[1]");
        let ranked = rank_selectors(&all[1], &all);
        assert_eq!(ranked[0]["strategy"], "id");
        assert_eq!(ranked[0]["matchCount"], 1);
        assert_eq!(ranked[0]["score"], 100);
        for candidate in generate_candidates(&all[1], &all) {
            assert!(candidate_matches(&candidate, &all[1]), "{candidate}");
        }
    }
    #[test]
    fn invalid_and_bounded_source() {
        for source in [
            "<a><b></a>",
            "<!DOCTYPE a [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><a>&x;</a>",
            "<a bad='&unknown;'/>",
            "<a/ ><b/>",
            "<a/><b/>",
            "<a>&#0;</a>",
            "<x:a/>",
            "<a xmlns:x='urn:a' xmlns:y='urn:a' x:k='a' y:k='b'/>",
            "<a>\0</a>",
        ] {
            assert!(elements(source).is_empty(), "accepted {source}");
        }
        assert!(elements(&format!("{}{}", "<n>".repeat(97), "</n>".repeat(97))).is_empty());
        assert!(elements(&format!("<n>{}</n>", "<b/>".repeat(10_000))).is_empty());
        assert_eq!(
            elements("<a xmlns:p='urn:p'><p:b p:x='&amp;'/></a>").len(),
            2
        );
    }
    #[test]
    fn escaped_values_and_stability_stop_at_first_failure() {
        let all = elements(
            r#"<App><XCUIElementTypeButton name="Say &quot;Hi&quot;\Again" label="Label" enabled="true" accessible="true"/></App>"#,
        );
        let candidates = generate_candidates(&all[1], &all);
        for c in &candidates {
            assert!(candidate_matches(c, &all[1]), "{c}");
        }
        let report = evaluate_stability(&candidates, &[all.clone(), Vec::new(), all]);
        assert_eq!(report["results"][0]["stableSteps"], 1);
        assert_eq!(report["results"][0]["firstFailureStep"], 2);
    }
    #[test]
    fn html_ancestry_and_selectors() {
        let all = elements(
            "<!doctype html><html><body><fieldset disabled><legend><input id='allowed'></legend><input id='blocked'></fieldset><div hidden><button id='hidden'>H</button></div><div inert><a href='/' id='inert'>I</a></div><button id='go' class='first second'>Go</button></body></html>",
        );
        let find = |id| all.iter().find(|e| string(e, "resourceId") == id).unwrap();
        assert_eq!(find("allowed")["enabled"], true);
        assert_eq!(find("blocked")["enabled"], false);
        assert_eq!(find("hidden")["visible"], false);
        assert_eq!(find("inert")["enabled"], false);
        let ranked = rank_selectors(find("go"), &all);
        assert_eq!(ranked[0]["strategy"], "id");
        assert!(
            !ranked
                .iter()
                .any(|c| string(c, "strategy") == "accessibility id")
        );
        assert!(candidate_matches(
            &json!({"strategy":"class name","value":"second","platform":"generic"}),
            find("go")
        ));
    }
    #[test]
    fn duplicate_matches_and_false_state_remain_visible() {
        let all = elements(
            r#"<root><node resource-id="same" enabled="false" visible="0"/><node resource-id="same"/></root>"#,
        );
        let ranked = rank_selectors(&all[1], &all);
        let id = ranked
            .iter()
            .find(|c| string(c, "strategy") == "id")
            .unwrap();
        assert_eq!(id["matchCount"], 2);
        assert_eq!(id["score"], 95);
        assert_eq!(all[1]["enabled"], false);
        assert_eq!(all[1]["visible"], false);
    }
    #[test]
    fn html_raw_text_template_and_namespace_attributes() {
        let all = elements(
            r#"<html><head><style>.x::before { content: "<fake id=style>" }</style></head><body><script>if (a < b) value = "<fake id=script>";</script><template><button id=template-only>Hidden</button></template><button id=real>Real</button><svg><a href="plain" xlink:href="linked" xml:lang="en"/></svg></body></html>"#,
        );
        assert_eq!(
            all.iter()
                .filter_map(|e| e["resourceId"].as_str())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>(),
            vec!["real"]
        );
        let a = all.iter().find(|e| string(e, "type") == "a").unwrap();
        assert_eq!(a["attributes"]["href"], "plain");
        assert_eq!(a["attributes"]["xlink:href"], "linked");
        assert_eq!(a["attributes"]["xml:lang"], "en");
        let unusual = elements(
            r#"<html><body><x"y id=quoted></x"y><x:y id=colon></x:y><math-α id=unicode></math-α></body></html>"#,
        );
        assert_eq!(
            unusual
                .iter()
                .find(|e| string(e, "resourceId") == "quoted")
                .unwrap()["xpath"],
            "/html[1]/body[1]/*[local-name(.)=concat(\"x\",'\"',\"y\")][1]"
        );
    }
    #[test]
    fn exact_resource_boundaries_and_inherited_namespaces() {
        assert_eq!(
            elements(&format!("{}{}", "<n>".repeat(96), "</n>".repeat(96))).len(),
            96
        );
        assert_eq!(
            elements(&format!("<n>{}</n>", "<b/>".repeat(9999))).len(),
            10_000
        );
        let declarations = (0..10_000)
            .map(|i| format!(" xmlns:p{i}=\"urn:{i}\""))
            .collect::<String>();
        assert_eq!(
            elements(&format!(
                "<root{declarations}>{}</root>",
                "<item/>".repeat(9999)
            ))
            .len(),
            10_000
        );
        let prefix = "Root value=\"";
        let suffix = "\"/";
        let boundary = MAX_MARKUP - prefix.len() - suffix.len();
        assert!(is_source_within_limits(&format!(
            "<{prefix}{}{suffix}>",
            "x".repeat(boundary)
        )));
        assert!(!is_source_within_limits(&format!(
            "<{prefix}{}{suffix}>",
            "x".repeat(boundary + 1)
        )));
        assert!(is_source_within_limits(
            "\u{feff}<!--before--><!doctype html><html><body>1 < 2</body></html>"
        ));
        assert!(!is_source_within_limits(&format!(
            "<html{}></html>",
            " a".repeat(1025)
        )));
        assert!(is_source_within_limits(&format!(
            "<html{}></html>",
            (0..1024).map(|i| format!(" a{i}")).collect::<String>()
        )));
        assert!(!is_source_within_limits(&format!(
            "<html><body><noscript>{}</noscript></body></html>",
            "<i></i>".repeat(10001)
        )));
    }
    #[test]
    fn reviewed_xml_validation_and_html_prefix_contracts() {
        assert_eq!(elements("\u{feff}<a/>").len(), 1);
        assert_eq!(elements("\u{feff}<?xml version=\"1.0\"?><a/>").len(), 1);
        assert!(elements(r#"<a b="1"c="2"/>"#).is_empty());
        assert_eq!(elements(r#"<a b="1" c="2"/>"#).len(), 1);
        for name in ["a·b", "a\u{200c}b", "a\u{200d}b", "a‿b", "a⁀b"] {
            assert_eq!(elements(&format!("<{name}/>"))[0]["type"], name);
            assert_eq!(
                elements(&format!(r#"<root {name}="1"/>"#))[0]["attributes"][name],
                "1"
            );
        }
        assert!(elements("<a𐀀b/>").is_empty());
        let all = elements("<!doctype html><!--a--!><html><body><input disabled></body></html>");
        assert_eq!(all.len(), 4);
        assert_eq!(all[3]["enabled"], false);
        let all = elements(r#"<root><a absent=""/><a/></root>"#);
        let candidate =
            json!({"strategy":"xpath", "value":"//*[@absent=\"\"]", "platform":"generic"});
        assert!(candidate_matches(&candidate, &all[1]));
        assert!(!candidate_matches(&candidate, &all[0]));
        assert!(!candidate_matches(&candidate, &all[2]));
    }
}
