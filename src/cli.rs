use crate::{appium::AppiumClient, core, server};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, IsTerminal, Read, Write},
    path::Path,
};

const HELP: &str = "Appium Session Recorder\n\nUsage:\n  appium-recorder [--host 127.0.0.1] [-p 4724] [-u http://127.0.0.1:4723]\n  appium-recorder <group> <command> [flags] [--pretty] [--output <path>]\n\nCommands:\n  proxy start\n  session create --appium-url <url> (--caps-file <path> | --caps-json <json>)\n  session delete --appium-url <url> --session-id <id>\n  screen snapshot|elements --appium-url <url> --session-id <id>\n  selectors best --appium-url <url> --session-id <id> --element-ref <ref>\n  drive tap|type|back|swipe|scroll --appium-url <url> --session-id <id>\n\nElement flags: --using <strategy> --value <selector>\nType flags: --text <text> [--clear-first]\nElements flags: [--only-actionable] [--limit <positive integer>]\nSwipe flags: --from <x,y> --to <x,y> [--duration-ms 300]\nScroll flags: --direction up|down|left|right [--duration-ms 300]\n\nLegacy environment: APPIUM_URL, PROXY_HOST, PROXY_PORT. Loopback bind hosts only.\n  -h, --help     Show help\n  -v, --version  Show version";

#[derive(Debug)]
struct CommandError {
    code: String,
    message: String,
    details: Option<Value>,
}
impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self {
            code: "COMMAND_EXECUTION_ERROR".into(),
            message,
            details: None,
        }
    }
}
impl From<crate::appium::AppiumError> for CommandError {
    fn from(e: crate::appium::AppiumError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            details: Some(json!({"status":e.status,"details":e.details})),
        }
    }
}
type Result<T> = std::result::Result<T, CommandError>;
type Flags = BTreeMap<String, Value>;

fn parse_flags(args: &[String], legacy: bool) -> std::result::Result<Flags, String> {
    let mut flags = Flags::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        let token = if legacy {
            match token.as_str() {
                "-p" => "--port",
                "-u" => "--appium-url",
                _ => token,
            }
        } else {
            token
        };
        let Some(raw) = token.strip_prefix("--") else {
            return Err(format!("Unexpected argument '{token}'"));
        };
        if raw.is_empty() {
            return Err("Invalid flag '--'".into());
        }
        if let Some((key, value)) = raw.split_once('=') {
            if key.is_empty() {
                return Err(format!("Invalid flag '{token}'"));
            }
            flags.insert(key.into(), Value::String(value.into()));
        } else if args.get(i + 1).is_some_and(|s| !s.starts_with("--")) {
            i += 1;
            flags.insert(raw.into(), Value::String(args[i].clone()));
        } else {
            flags.insert(raw.into(), Value::Bool(true));
        }
        i += 1;
    }
    Ok(flags)
}
fn allowed(flags: &Flags, keys: &[&str]) -> std::result::Result<(), String> {
    let unknown: Vec<_> = flags
        .keys()
        .filter(|s| !keys.contains(&s.as_str()))
        .map(|s| format!("--{s}"))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!("Unknown flags: {}", unknown.join(", ")))
    }
}
fn required<'a>(flags: &'a Flags, key: &str) -> std::result::Result<&'a str, String> {
    flags
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("--{key} is required"))
}
fn optional<'a>(flags: &'a Flags, key: &str) -> std::result::Result<Option<&'a str>, String> {
    match flags.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.trim())),
        _ => Err(format!("--{key} requires a non-empty value")),
    }
}
fn boolean(flags: &Flags, key: &str) -> std::result::Result<bool, String> {
    match flags.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("--{key} does not take a value")),
    }
}
fn integer(
    flags: &Flags,
    key: &str,
    default: u64,
    min: u64,
    max: u64,
) -> std::result::Result<u64, String> {
    let Some(s) = optional(flags, key)? else {
        return Ok(default);
    };
    let number = s
        .parse::<f64>()
        .map_err(|_| format!("--{key} must be an integer between {min} and {max}"))?;
    if !number.is_finite() || number.fract() != 0.0 || number < min as f64 || number > max as f64 {
        return Err(format!(
            "--{key} must be an integer between {min} and {max}"
        ));
    }
    Ok(number as u64)
}
fn point(flags: &Flags, key: &str) -> std::result::Result<Value, String> {
    let value = required(flags, key)?;
    let bad = || format!("--{key} must be in format x,y");
    let Some((x, y)) = value.split_once(',') else {
        return Err(bad());
    };
    let valid = |s: &str| -> bool {
        let s = s.strip_prefix('-').unwrap_or(s);
        !s.is_empty()
            && s.bytes().filter(|b| *b == b'.').count() <= 1
            && s.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            && s.bytes().any(|b| b.is_ascii_digit())
            && !s.ends_with('.')
    };
    if !valid(x) || !valid(y) {
        return Err(bad());
    }
    let x: f64 = x.parse().map_err(|_| bad())?;
    let y: f64 = y.parse().map_err(|_| bad())?;
    if !x.is_finite() || !y.is_finite() {
        return Err(bad());
    }
    Ok(json!({"x":x,"y":y}))
}
fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn success(command: &str, result: Value) -> Value {
    json!({"ok":true,"command":command,"timestamp":timestamp(),"result":result})
}
fn failure(command: &str, error: CommandError) -> Value {
    let mut v = json!({"ok":false,"command":command,"timestamp":timestamp(),"error":{"code":error.code,"message":error.message}});
    if let Some(details) = error.details {
        v["error"]["details"] = details;
    }
    v
}
fn emit(value: &Value, pretty: bool, output: Option<&str>) -> io::Result<()> {
    let mut text = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .map_err(io::Error::other)?;
    text.push('\n');
    if let Some(output) = output {
        let path = Path::new(output);
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, text)
    } else {
        io::stdout().lock().write_all(text.as_bytes())
    }
}

async fn dispatch(command: &str, flags: &Flags) -> Result<Value> {
    let appium_url = required(flags, "appium-url")?;
    let client = AppiumClient::new(appium_url)?;
    if command == "session.create" {
        allowed(flags, &["appium-url", "caps-file", "caps-json"])?;
        let file = optional(flags, "caps-file")?;
        let inline = optional(flags, "caps-json")?;
        const MAX_CAPS: usize = 10 * 1024 * 1024;
        let raw = match (file, inline) {
            (Some(path), None) => {
                let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
                if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                    return Err("Capabilities file must be a regular file".to_owned().into());
                }
                let mut raw = String::new();
                file.take(MAX_CAPS as u64 + 1)
                    .read_to_string(&mut raw)
                    .map_err(|e| e.to_string())?;
                raw
            }
            (None, Some(raw)) => raw.to_owned(),
            _ => {
                return Err("Provide exactly one of --caps-file or --caps-json"
                    .to_owned()
                    .into());
            }
        };
        if raw.len() > MAX_CAPS {
            return Err("Capabilities exceed 10 MiB".to_owned().into());
        }
        let caps = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let session = client.create_session(caps).await?;
        return Ok(
            json!({"appiumUrl":appium_url,"sessionId":session["sessionId"],"value":session["value"]}),
        );
    }
    let session = required(flags, "session-id")?;
    match command {
        "session.delete" => {
            allowed(flags, &["appium-url", "session-id"])?;
            client.delete_session(session).await?;
            Ok(json!({"appiumUrl":appium_url,"sessionId":session,"deleted":true}))
        }
        "screen.snapshot" => {
            allowed(flags, &["appium-url", "session-id"])?;
            let state = client.capture_state(session).await?;
            let source = state["source"].as_str().filter(|s| !s.is_empty());
            let screenshot = state["screenshot"].as_str().filter(|s| !s.is_empty());
            let (Some(source), Some(screenshot)) = (source, screenshot) else {
                return Err(CommandError {
                    code: "APPIUM_PARTIAL_CAPTURE".into(),
                    message: "Appium snapshot was incomplete".into(),
                    details: Some(json!({"status":502})),
                });
            };
            let parsed = core::parse_source(source)?;
            Ok(
                json!({"sessionId":session,"platform":parsed["platform"],"screenshot":screenshot,"source":source,"metadata":{"elementCount":parsed["elements"].as_array().map_or(0,Vec::len)}}),
            )
        }
        "screen.elements" | "selectors.best" => {
            if command == "screen.elements" {
                allowed(
                    flags,
                    &["appium-url", "session-id", "limit", "only-actionable"],
                )?;
            } else {
                allowed(flags, &["appium-url", "session-id", "element-ref"])?;
            }
            let only_actionable = boolean(flags, "only-actionable")?;
            let limit = integer(flags, "limit", u64::MAX, 1, u64::MAX)? as usize;
            let reference = if command == "selectors.best" {
                Some(required(flags, "element-ref")?)
            } else {
                None
            };
            let source = client.get_source(session).await?;
            let parsed = core::parse_source(&source)?;
            let elements = parsed["elements"]
                .as_array()
                .ok_or_else(|| "Source parser returned no elements".to_owned())?;
            if let Some(reference) = reference {
                let target = elements
                    .iter()
                    .find(|e| e["elementRef"] == reference)
                    .ok_or_else(|| format!("Element not found for --element-ref '{reference}'"))?;
                let ranked = core::rank_selectors(target, elements);
                Ok(
                    json!({"sessionId":session,"platform":parsed["platform"],"elementRef":reference,"target":target,"topSelectors":ranked.iter().take(5).collect::<Vec<_>>(),"allSelectors":ranked}),
                )
            } else {
                let selected: Vec<_> = elements
                    .iter()
                    .filter(|e| {
                        !only_actionable
                            || (e["enabled"] == true
                                && e["visible"] == true
                                && (e["clickable"] == true || e["accessible"] == true))
                    })
                    .take(limit)
                    .collect();
                Ok(
                    json!({"sessionId":session,"platform":parsed["platform"],"total":elements.len(),"returned":selected.len(),"onlyActionable":only_actionable,"elements":selected}),
                )
            }
        }
        "drive.tap" | "drive.type" => {
            let is_type = command == "drive.type";
            if is_type {
                allowed(
                    flags,
                    &[
                        "appium-url",
                        "session-id",
                        "using",
                        "value",
                        "text",
                        "clear-first",
                    ],
                )?;
            } else {
                allowed(flags, &["appium-url", "session-id", "using", "value"])?;
            }
            let using = required(flags, "using")?;
            let value = required(flags, "value")?;
            let mut result =
                json!({"sessionId":session,"using":using,"value":value,"performed":true});
            if is_type {
                let text = required(flags, "text")?;
                let clear = boolean(flags, "clear-first")?;
                client.type_text(session, using, value, text, clear).await?;
                result["textLength"] = json!(text.encode_utf16().count());
                result["clearFirst"] = json!(clear);
            } else {
                client.tap(session, using, value).await?;
            }
            Ok(result)
        }
        "drive.back" => {
            allowed(flags, &["appium-url", "session-id"])?;
            client.back(session).await?;
            Ok(json!({"sessionId":session,"performed":true}))
        }
        "drive.swipe" | "drive.scroll" => {
            let duration = integer(flags, "duration-ms", 300, 50, u64::MAX)?;
            if command == "drive.swipe" {
                allowed(
                    flags,
                    &["appium-url", "session-id", "from", "to", "duration-ms"],
                )?;
                let from = point(flags, "from")?;
                let to = point(flags, "to")?;
                client.swipe(session, &from, &to, duration).await?;
                Ok(
                    json!({"sessionId":session,"from":from,"to":to,"durationMs":duration,"performed":true}),
                )
            } else {
                allowed(
                    flags,
                    &["appium-url", "session-id", "direction", "duration-ms"],
                )?;
                let direction = required(flags, "direction")?;
                if !["up", "down", "left", "right"].contains(&direction) {
                    return Err("--direction must be one of: up, down, left, right"
                        .to_owned()
                        .into());
                }
                client.scroll(session, direction, duration).await?;
                Ok(
                    json!({"sessionId":session,"direction":direction,"durationMs":duration,"performed":true}),
                )
            }
        }
        _ => Err(format!("Unsupported command: {command}").into()),
    }
}

fn proxy_config(flags: &Flags, legacy: bool) -> std::result::Result<(String, u16, String), String> {
    allowed(flags, &["host", "port", "appium-url"])?;
    let get = |key, env_key, default: &str| -> std::result::Result<String, String> {
        Ok(optional(flags, key)?
            .map(str::to_owned)
            .or_else(|| {
                if legacy {
                    std::env::var(env_key).ok()
                } else {
                    None
                }
            })
            .unwrap_or_else(|| default.to_owned()))
    };
    let host = get("host", "PROXY_HOST", "127.0.0.1")?;
    if !["localhost", "127.0.0.1", "::1"].contains(&host.as_str()) {
        return Err("--host must be localhost, 127.0.0.1, or ::1".into());
    }
    let port = get("port", "PROXY_PORT", "4724")?;
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err("--port must be an integer between 1 and 65535".into());
    }
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|p| *p > 0)
        .ok_or_else(|| "--port must be an integer between 1 and 65535".to_owned())?;
    let url = get("appium-url", "APPIUM_URL", "http://127.0.0.1:4723")?;
    AppiumClient::new(&url).map_err(|e| e.to_string())?;
    Ok((host, port, url))
}

fn prompt(
    input: &mut impl io::BufRead,
    label: &str,
    current: &str,
    validate: impl Fn(&str) -> bool,
) -> std::result::Result<String, String> {
    loop {
        eprint!("{label} [{current}]: ");
        io::stderr().flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        if input.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("Input closed".into());
        }
        let value = if line.trim().is_empty() {
            current
        } else {
            line.trim()
        };
        if validate(value) {
            return Ok(value.to_owned());
        }
        eprintln!("Invalid {label}; please try again.");
    }
}

pub async fn run(args: Vec<String>) -> i32 {
    let mut pretty = false;
    let mut output = None;
    let mut remaining = Vec::new();
    let mut parse_error = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pretty" => pretty = true,
            "--output" => {
                if let Some(value) = args
                    .get(i + 1)
                    .filter(|s| !s.is_empty() && !s.starts_with('-'))
                {
                    output = Some(value.clone());
                    i += 1;
                } else {
                    parse_error = Some("--output requires a file path value".to_owned());
                    break;
                }
            }
            _ => remaining.push(args[i].clone()),
        }
        i += 1;
    }
    let command_mode = remaining.first().is_some_and(|s| !s.starts_with('-'));
    if (!command_mode
        || remaining
            .iter()
            .any(|s| ["--help", "-h", "--version", "-v"].contains(&s.as_str())))
        && (pretty || output.is_some())
    {
        parse_error =
            Some("--pretty and --output are only supported with <group> <command> mode".into());
    }
    if let Some(error) = parse_error {
        let _ = emit(
            &failure(
                "cli.parse",
                CommandError {
                    code: "CLI_PARSE_ERROR".into(),
                    message: error,
                    details: None,
                },
            ),
            true,
            None,
        );
        return 1;
    }
    if remaining.iter().any(|s| s == "--help" || s == "-h") {
        println!("{HELP}");
        return 0;
    }
    if remaining.iter().any(|s| s == "--version" || s == "-v") {
        println!("Appium Session Recorder v{}", env!("CARGO_PKG_VERSION"));
        return 0;
    }
    let (command, flag_args) = if command_mode {
        let group = remaining[0].as_str();
        let commands: &[&str] = match group {
            "proxy" => &["start"],
            "session" => &["create", "delete"],
            "screen" => &["snapshot", "elements"],
            "selectors" => &["best"],
            "drive" => &["tap", "type", "back", "swipe", "scroll"],
            _ => &[],
        };
        let sub = remaining.get(1).map(String::as_str).unwrap_or("");
        if !commands.contains(&sub) {
            let error = if commands.is_empty() {
                format!("Unknown command group '{group}'")
            } else if sub.is_empty() {
                format!("Missing subcommand for '{group}'")
            } else {
                format!(
                    "Unknown subcommand '{sub}' for '{group}'. Allowed: {}",
                    commands.join(", ")
                )
            };
            let _ = emit(
                &failure(
                    "cli.parse",
                    CommandError {
                        code: "CLI_PARSE_ERROR".into(),
                        message: error,
                        details: None,
                    },
                ),
                true,
                None,
            );
            return 1;
        }
        (format!("{group}.{sub}"), &remaining[2..])
    } else {
        ("proxy.start".to_owned(), remaining.as_slice())
    };
    let mut prompt_cancelled = false;
    let mut listener = None;
    let mut proxy_url = None;
    let result:Result<Value> = async {
        let flags = parse_flags(flag_args,!command_mode)?;
        if command=="proxy.start" {
            let (mut host,mut port,mut url)=proxy_config(&flags,!command_mode)?;
            if !command_mode && flags.is_empty() && io::stdin().is_terminal() {
                let settings = tokio::task::spawn_blocking(move || -> std::result::Result<_,String> {
                    // A private reader lets process shutdown proceed while terminal input is blocked.
                    let terminal = std::fs::File::open(if cfg!(windows) {"CONIN$"} else {"/dev/stdin"}).map_err(|e|e.to_string())?;
                    let mut input = io::BufReader::new(terminal);
                    let host = prompt(&mut input,"Host",&host,|s| ["localhost","127.0.0.1","::1"].contains(&s))?;
                    let url = prompt(&mut input,"Appium URL",&url,crate::appium::is_safe_appium_url)?;
                    let port = prompt(&mut input,"Port",&port.to_string(),|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && s.parse::<u16>().is_ok_and(|p|p>0))?;
                    Ok((host,port.parse::<u16>().map_err(|e|e.to_string())?,url))
                });
                (host,port,url) = tokio::select! {
                    result=settings => result.map_err(|e|e.to_string())??,
                    _=tokio::signal::ctrl_c()=>{prompt_cancelled=true;return Ok(Value::Null);}
                };
            }
            let checked=BTreeMap::from([("host".into(),json!(host)),("port".into(),json!(port.to_string())),("appium-url".into(),json!(url))]);
            let (host,port,url)=proxy_config(&checked,false)?;
            // Construct before binding so configuration failures never report a running server.
            let _ = server::router(&url)?;
            listener=Some(tokio::net::TcpListener::bind((host.as_str(),port)).await.map_err(|e| e.to_string())?);
            proxy_url=Some(url.clone());
            let http_host=if host.contains(':') {format!("[{host}]")} else {host.clone()};
            Ok(json!({"host":host,"port":port,"appiumUrl":url,"proxyUrl":format!("http://{http_host}:{port}"),"viewerUrl":format!("http://{http_host}:{port}/_recorder"),"running":true}))
        } else { dispatch(&command,&flags).await }
    }.await;
    if prompt_cancelled {
        return 0;
    }
    let mut response = match result {
        Ok(value) => success(&command, value),
        Err(error) => failure(&command, error),
    };
    if let Err(error) = emit(&response, pretty, output.as_deref()) {
        response = failure(
            &command,
            CommandError {
                code: "OUTPUT_WRITE_ERROR".into(),
                message: error.to_string(),
                details: None,
            },
        );
        if let Err(error) = emit(&response, pretty, None) {
            eprintln!("Unable to write response: {error}");
        }
    }
    if response["ok"] != true {
        return 1;
    }
    if let (Some(listener), Some(url)) = (listener, proxy_url) {
        if let Err(error) = server::serve(listener, &url).await {
            eprintln!("{error}");
            return 1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    fn flags(args: &[&str]) -> Flags {
        parse_flags(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            false,
        )
        .unwrap()
    }
    #[test]
    fn booleans_and_negative_points_preserve_explicit_values() {
        let f = flags(&["--from", "-1,.5", "--clear-first=false"]);
        assert_eq!(point(&f, "from").unwrap(), json!({"x":-1.0,"y":0.5}));
        assert!(boolean(&f, "clear-first").is_err());
        assert!(point(&flags(&["--from", "1,NaN"]), "from").is_err());
        assert!(point(&flags(&["--from", "1,2,3"]), "from").is_err());
        assert_eq!(
            integer(&flags(&["--limit", "0"]), "limit", 80, 1, 100).unwrap_err(),
            "--limit must be an integer between 1 and 100"
        );
    }
    #[test]
    fn rejects_unknown_flags_and_unsafe_proxy_configuration() {
        assert!(allowed(&flags(&["--typo"]), &["host"]).is_err());
        assert!(proxy_config(&flags(&["--host", "0.0.0.0"]), false).is_err());
        assert!(proxy_config(&flags(&["--port", "0"]), false).is_err());
        assert!(
            proxy_config(
                &flags(&["--appium-url", "http://user:secret@example.com"]),
                false
            )
            .is_err()
        );
        assert_eq!(proxy_config(&Flags::new(), false).unwrap().1, 4724);
    }
}
