use crate::appium::AppiumClient;
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{SecondsFormat, Utc};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{
    Mutex as AsyncMutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore, mpsc, watch,
};
use tokio_stream::wrappers::ReceiverStream;
use url::Url;

const MAX_REQUEST: usize = 10 * 1024 * 1024;
const MAX_HISTORY_BYTES: usize = 100 * 1024 * 1024;
const MAX_SELECTOR_RESPONSE: usize = 1024 * 1024;
const MAX_SELECTOR_FIELD: usize = 64 * 1024;
const MAX_SELECTOR_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAM_MESSAGE: usize = 2 * 1024 * 1024;
const MAX_STREAM_QUEUE: usize = 4 * 1024 * 1024;
const CSP: &str = "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'";
const ELEMENT_KEY: &str = "element-6066-11e4-a52e-4f735466cecf";

struct Stored {
    data: Value,
    screenshot: Option<Vec<u8>>,
    bytes: usize,
}
struct SelectorEntry {
    session: String,
    element: String,
    selector: Value,
    bytes: usize,
}
struct StreamMessage {
    text: Arc<str>,
    _permit: OwnedSemaphorePermit,
}
struct Listener {
    sender: mpsc::Sender<StreamMessage>,
    budget: Arc<Semaphore>,
}
#[derive(Default)]
struct Recorder {
    history: VecDeque<Stored>,
    bytes: usize,
    next_id: u64,
    selectors: VecDeque<SelectorEntry>,
    selector_bytes: usize,
    listeners: HashMap<u64, Listener>,
    next_listener: u64,
}

fn truncate(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
fn stream_interaction(data: &Value, compact: bool) -> Value {
    if !compact
        && data["source"].as_str().unwrap_or("").len() <= MAX_STREAM_MESSAGE / 2
        && serde_json::to_vec(data).is_ok_and(|v| v.len() <= MAX_STREAM_MESSAGE)
    {
        return data.clone();
    }
    let mut bounded = json!({"id":data["id"],"timestamp":truncate(data["timestamp"].as_str().unwrap_or(""),128),
        "method":truncate(data["method"].as_str().unwrap_or(""),32),"path":truncate(data["path"].as_str().unwrap_or(""),1024),
        "detailsUrl":format!("/_recorder/api/interaction/{}",data["id"]),"detailsTruncated":true});
    for key in ["actionKind", "captureStatus", "screenshotUrl"] {
        if let Some(value) = data.get(key) {
            bounded[key] = value.clone();
        }
    }
    if let Some(info) = data.get("elementInfo") {
        if info["using"].as_str().is_some_and(|s| s.len() <= 128)
            && info["value"].as_str().is_some_and(|s| s.len() <= 1024)
        {
            bounded["elementInfo"] = info.clone();
        }
    }
    bounded
}
impl Recorder {
    fn emit(&mut self, kind: &str, data: Value) {
        let event = if kind == "interaction" {
            stream_interaction(&data, false)
        } else {
            data
        };
        let text: Arc<str> = format!("data: {}\n\n", json!({"type":kind,"data":event})).into();
        self.listeners.retain(|_, listener| {
            let Ok(permit) = listener
                .budget
                .clone()
                .try_acquire_many_owned(text.len() as u32)
            else {
                return false;
            };
            listener
                .sender
                .try_send(StreamMessage {
                    text: text.clone(),
                    _permit: permit,
                })
                .is_ok()
        });
    }
    fn evict(&mut self) {
        let mut ids = Vec::new();
        while self.history.len() > 500 || self.bytes > MAX_HISTORY_BYTES {
            let Some(entry) = self.history.pop_front() else {
                break;
            };
            self.bytes -= entry.bytes;
            ids.push(entry.data["id"].clone());
        }
        if !ids.is_empty() {
            self.emit("evict", json!({"ids":ids}));
        }
    }
    fn record(&mut self, path: &str, kind: &str, selector: Option<Value>) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let mut data = json!({"id":id,"timestamp":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"method":"POST","path":path,"actionKind":kind});
        if kind != "unknown" {
            data["captureStatus"] = json!("pending");
        }
        if let Some(selector) = selector {
            data["elementInfo"] = selector;
        }
        let bytes = serde_json::to_vec(&data).unwrap().len();
        self.bytes += bytes;
        self.history.push_back(Stored {
            data: data.clone(),
            screenshot: None,
            bytes,
        });
        self.emit("interaction", data);
        self.evict();
        id
    }
    fn update(&mut self, id: u64, state: Option<Value>, status: &str) {
        let Some(entry) = self.history.iter_mut().find(|e| e.data["id"] == id) else {
            return;
        };
        if let Some(state) = state {
            if let Some(encoded) = state["screenshot"].as_str() {
                if let Ok(png) = STANDARD.decode(encoded) {
                    if !png.is_empty() {
                        entry.screenshot = Some(png);
                        entry.data["screenshotUrl"] = json!(format!(
                            "/_recorder/api/screenshot/{id}?v={}",
                            Utc::now().timestamp_millis()
                        ));
                    }
                }
            }
            if let Some(source) = state["source"].as_str() {
                if crate::core::is_source_within_limits(source) {
                    entry.data["source"] = json!(source);
                }
            }
            let complete = entry.screenshot.is_some() && entry.data.get("source").is_some();
            let partial = entry.screenshot.is_some() || entry.data.get("source").is_some();
            entry.data["captureStatus"] = json!(if complete {
                "complete"
            } else if partial {
                "partial"
            } else {
                "failed"
            });
        } else {
            entry.data["captureStatus"] = json!(status);
        }
        self.bytes -= entry.bytes;
        entry.bytes = serde_json::to_vec(&entry.data).unwrap().len()
            + entry.screenshot.as_ref().map_or(0, Vec::len);
        self.bytes += entry.bytes;
        let data = entry.data.clone();
        self.evict();
        if self.history.iter().any(|e| e.data["id"] == id) {
            self.emit("interaction", data);
        }
    }
    fn clear(&mut self) {
        self.history.clear();
        self.bytes = 0;
        self.selectors.clear();
        self.selector_bytes = 0;
        self.emit("clear", Value::Null);
    }
    fn clear_session(&mut self, session: &str) {
        self.selectors.retain(|entry| entry.session != session);
        self.selector_bytes = self.selectors.iter().map(|e| e.bytes).sum();
    }
    fn selector(&mut self, session: &str, element: &str) -> Option<Value> {
        let index = self
            .selectors
            .iter()
            .position(|e| e.session == session && e.element == element)?;
        let entry = self.selectors.remove(index)?;
        let selector = entry.selector.clone();
        self.selectors.push_back(entry);
        Some(selector)
    }
    fn store_selector(&mut self, session: &str, element: &str, selector: &Value) {
        let using = selector["using"].as_str().unwrap_or("");
        let value = selector["value"].as_str().unwrap_or("");
        let fields = [session, element, using, value];
        if fields.iter().any(|s| s.len() > MAX_SELECTOR_FIELD) {
            return;
        }
        if let Some(index) = self
            .selectors
            .iter()
            .position(|e| e.session == session && e.element == element)
        {
            self.selector_bytes -= self.selectors.remove(index).unwrap().bytes;
        }
        let bytes = fields.iter().map(|s| s.len()).sum();
        self.selector_bytes += bytes;
        self.selectors.push_back(SelectorEntry {
            session: session.into(),
            element: element.into(),
            selector: selector.clone(),
            bytes,
        });
        while self.selectors.len() > 5000 || self.selector_bytes > MAX_SELECTOR_BYTES {
            self.selector_bytes -= self.selectors.pop_front().unwrap().bytes;
        }
    }
}
#[derive(Clone)]
struct AppState {
    recorder: Arc<Mutex<Recorder>>,
    client: AppiumClient,
    http: reqwest::Client,
    base: String,
    gates: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    capture_slots: Arc<Semaphore>,
    capture_jobs: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}
fn loopback(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().trim_matches(['[', ']']),
        "localhost" | "127.0.0.1" | "::1"
    )
}
fn allowed_request(headers: &HeaderMap) -> bool {
    let host = headers.get("host").and_then(|s| s.to_str().ok());
    let Some(host) = host else {
        return false;
    };
    let Ok(host) = Url::parse(&format!("http://{host}")) else {
        return false;
    };
    if host.host_str().is_none_or(|s| !loopback(s))
        || !host.username().is_empty()
        || host.password().is_some()
        || host.path() != "/"
        || host.query().is_some()
        || host.fragment().is_some()
    {
        return false;
    }
    match headers.get("origin") {
        None => true,
        Some(origin) => origin
            .to_str()
            .ok()
            .and_then(|s| Url::parse(s).ok())
            .is_some_and(|u| u.host_str().is_some_and(loopback)),
    }
}
fn response(status: StatusCode, data: Value) -> Response {
    (status, axum::Json(data)).into_response()
}
fn error(status: StatusCode, message: &str) -> Response {
    response(status, json!({"error":message}))
}
fn canonical_id(value: &str) -> Option<u64> {
    if value.starts_with('0') || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|&n| n > 0 && n <= 9_007_199_254_740_991)
}
fn decode(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let source = value.as_bytes();
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            let pair = source.get(index + 1..index + 3)?;
            let hex = |c: u8| match c {
                b'0'..=b'9' => Some(c - b'0'),
                b'a'..=b'f' => Some(c - b'a' + 10),
                b'A'..=b'F' => Some(c - b'A' + 10),
                _ => None,
            };
            bytes.push(hex(pair[0])? * 16 + hex(pair[1])?);
            index += 3;
        } else {
            bytes.push(source[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
fn session_path(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/session/")?;
    let (session, suffix) = rest.split_once('/').map_or((rest, ""), |(s, p)| (s, p));
    if session.is_empty() {
        return None;
    }
    Some((decode(session)?, format!("/{suffix}")))
}
pub fn classify_action(method: &str, path: &str) -> &'static str {
    if method != "POST" {
        return "unknown";
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    let pieces = path.rsplit('/').collect::<Vec<_>>();
    if pieces.len() >= 3 && pieces[2] == "element" && !pieces[1].is_empty() {
        match pieces[0] {
            "click" => return "tap",
            "value" => return "type",
            "clear" => return "clear",
            _ => {}
        }
    }
    match pieces.first().copied().unwrap_or("") {
        "element" | "elements" => "find",
        "actions" => "swipe",
        "perform" if path.ends_with("/touch/perform") => "swipe",
        "back" => "back",
        "forward" => "forward",
        "refresh" => "refresh",
        _ => "unknown",
    }
}
fn request_selector(body: &[u8]) -> Option<Value> {
    let parsed: Value = serde_json::from_slice(body).ok()?;
    let using = parsed["using"].as_str()?;
    let value = parsed["value"].as_str()?;
    if [using, value]
        .iter()
        .any(|s| s.is_empty() || s.len() > MAX_SELECTOR_FIELD)
    {
        return None;
    }
    Some(json!({"using":using,"value":value}))
}
fn action_element(path: &str) -> Option<String> {
    let path = path.strip_suffix('/').unwrap_or(path);
    let pieces = path.rsplit('/').collect::<Vec<_>>();
    if pieces.len() < 3
        || pieces[2] != "element"
        || !matches!(pieces[0], "click" | "value" | "clear")
    {
        return None;
    }
    decode(pieces[1])
}
fn hop_header(name: &str, headers: &HeaderMap) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
    ) || headers
        .get("connection")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.split(',').any(|n| n.trim().eq_ignore_ascii_case(name)))
}

pub fn router(appium_url: &str) -> Result<Router, String> {
    build_router(appium_url).map(|(router, _)| router)
}
fn build_router(appium_url: &str) -> Result<(Router, watch::Sender<bool>), String> {
    let client = AppiumClient::new(appium_url).map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|e| e.to_string())?;
    let (shutdown, _) = watch::channel(false);
    let state = AppState {
        shutdown: shutdown.clone(),
        recorder: Arc::new(Mutex::new(Recorder::default())),
        client,
        http,
        base: appium_url.trim_end_matches('/').into(),
        gates: Arc::new(Mutex::new(HashMap::new())),
        capture_slots: Arc::new(Semaphore::new(2)),
        capture_jobs: Arc::new(Semaphore::new(18)),
    };
    Ok((Router::new().fallback(handle).with_state(state), shutdown))
}
pub async fn run(host: &str, port: u16, appium_url: &str) -> Result<(), String> {
    if !matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return Err("Recorder host must be localhost, 127.0.0.1, or ::1".into());
    }
    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .map_err(|e| e.to_string())?;
    serve(listener, appium_url).await
}
pub async fn serve(listener: tokio::net::TcpListener, appium_url: &str) -> Result<(), String> {
    if !listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .ip()
        .is_loopback()
    {
        return Err("Recorder listener must bind to loopback".into());
    }
    let (router, signal) = build_router(appium_url)?;
    let serving = axum::serve(listener, router).with_graceful_shutdown(async move {
        shutdown().await;
        let _ = signal.send(true);
    });
    serving.await.map_err(|e| e.to_string())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install signal handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
async fn handle(State(state): State<AppState>, request: Request) -> Response {
    let mut shutdown = state.shutdown.subscribe();
    let mut result = if *shutdown.borrow() {
        error(StatusCode::SERVICE_UNAVAILABLE, "Recorder is shutting down")
    } else if allowed_request(request.headers()) {
        tokio::select! {result=dispatch(state,request)=>result,_=shutdown.changed()=>error(StatusCode::SERVICE_UNAVAILABLE,"Recorder is shutting down")}
    } else {
        error(StatusCode::FORBIDDEN, "Recorder is local-only")
    };
    result
        .headers_mut()
        .insert("content-security-policy", HeaderValue::from_static(CSP));
    result.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    result
}
async fn dispatch(state: AppState, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    if method == Method::GET {
        let asset = match path.as_str() {
            "/_recorder" | "/_recorder/" => {
                Some(("text/html; charset=utf-8", include_str!("viewer.html")))
            }
            "/_recorder/viewer.js" => {
                Some(("text/javascript; charset=utf-8", include_str!("viewer.js")))
            }
            "/_recorder/viewer.css" => {
                Some(("text/css; charset=utf-8", include_str!("viewer.css")))
            }
            _ => None,
        };
        if let Some((mime, body)) = asset {
            return ([("content-type", mime)], body).into_response();
        }
    }
    let mut result = match (method.clone(), path.as_str()) {
        (Method::GET, "/_recorder/api/history") => {
            let data: Vec<Value> = state
                .recorder
                .lock()
                .unwrap()
                .history
                .iter()
                .map(|e| e.data.clone())
                .collect();
            response(StatusCode::OK, json!(data))
        }
        (Method::DELETE, "/_recorder/api/history") => {
            state.recorder.lock().unwrap().clear();
            response(StatusCode::OK, json!({"ok":true}))
        }
        (Method::GET, "/_recorder/api/stream") => return open_stream(&state),
        (Method::POST, "/_recorder/api/inspect") => return inspect(request).await,
        _ if method == Method::GET && path.starts_with("/_recorder/api/interaction/") => {
            let id = canonical_id(path.trim_start_matches("/_recorder/api/interaction/"));
            let data = state
                .recorder
                .lock()
                .unwrap()
                .history
                .iter()
                .find(|e| Some(e.data["id"].as_u64().unwrap()) == id)
                .map(|e| e.data.clone());
            match data {
                Some(data) => response(StatusCode::OK, data),
                None => error(StatusCode::NOT_FOUND, "Interaction not found"),
            }
        }
        _ if method == Method::GET && path.starts_with("/_recorder/api/screenshot/") => {
            let id = canonical_id(path.trim_start_matches("/_recorder/api/screenshot/"));
            let screenshot = state
                .recorder
                .lock()
                .unwrap()
                .history
                .iter()
                .find(|e| Some(e.data["id"].as_u64().unwrap()) == id)
                .and_then(|e| e.screenshot.clone());
            match screenshot {
                Some(bytes) => ([("content-type", "image/png")], bytes).into_response(),
                None => error(StatusCode::NOT_FOUND, "Screenshot not found"),
            }
        }
        _ if path.starts_with("/_recorder/") => {
            error(StatusCode::NOT_FOUND, "Recorder route not found")
        }
        _ => return proxy(state, request).await,
    };
    result.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    result
}
struct StreamSubscription {
    recorder: Arc<Mutex<Recorder>>,
    id: u64,
}
impl Drop for StreamSubscription {
    fn drop(&mut self) {
        if let Ok(mut recorder) = self.recorder.lock() {
            recorder.listeners.remove(&self.id);
        }
    }
}
fn open_stream(state: &AppState) -> Response {
    let mut recorder = state.recorder.lock().unwrap();
    recorder.listeners.retain(|_, l| !l.sender.is_closed());
    if recorder.listeners.len() >= 32 {
        return error(StatusCode::TOO_MANY_REQUESTS, "Too many event streams");
    }
    let (sender, receiver) = mpsc::channel(1024);
    let budget = Arc::new(Semaphore::new(MAX_STREAM_QUEUE));
    let history = recorder
        .history
        .iter()
        .map(|e| stream_interaction(&e.data, true))
        .collect::<Vec<_>>();
    let mut batch = Vec::new();
    let mut length = 64;
    let mut remainder = Vec::new();
    for value in history {
        let size = serde_json::to_vec(&value).unwrap().len() + 1;
        if length + size <= MAX_STREAM_MESSAGE && remainder.is_empty() {
            length += size;
            batch.push(value);
        } else {
            remainder.push(value);
        }
    }
    let mut initial = VecDeque::new();
    initial.push_back(format!("data: {}\n\n", json!({"type":"init","data":batch})));
    for value in remainder {
        initial.push_back(format!(
            "data: {}\n\n",
            json!({"type":"interaction","data":value})
        ));
    }
    recorder.next_listener += 1;
    let id = recorder.next_listener;
    recorder.listeners.insert(id, Listener { sender, budget });
    drop(recorder);
    let guard = StreamSubscription {
        recorder: state.recorder.clone(),
        id,
    };
    let shutdown = state.shutdown.subscribe();
    let stream = futures_util::stream::unfold(
        (receiver, guard, initial, shutdown),
        |(mut receiver, guard, mut initial, mut shutdown)| async move {
            if *shutdown.borrow() {
                return None;
            }
            if let Some(text) = initial.pop_front() {
                return Some((
                    Ok::<_, Infallible>(Bytes::from(text)),
                    (receiver, guard, initial, shutdown),
                ));
            }
            tokio::select! {
                _=shutdown.changed()=>None,
                message=receiver.recv()=>message.map(|message|(Ok::<_,Infallible>(Bytes::copy_from_slice(message.text.as_bytes())),(receiver,guard,initial,shutdown)))
            }
        },
    );
    (
        [
            ("content-type", "text/event-stream"),
            ("cache-control", "private, no-store"),
            ("connection", "keep-alive"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn inspect(request: Request) -> Response {
    let bytes = match to_bytes(request.into_body(), MAX_REQUEST).await {
        Ok(b) => b,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Inspector request exceeds 10 MiB",
            );
        }
    };
    let input: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Inspector body must be valid JSON"),
    };
    let Some(source) = input["source"].as_str() else {
        return error(StatusCode::BAD_REQUEST, "source is required");
    };
    let parsed = match crate::core::parse_source(source) {
        Ok(v) => v,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    // Parsing/ranking is bounded by the same limits used by direct commands.
    let elements = parsed["elements"].as_array().cloned().unwrap_or_default();
    let mut output = parsed;
    if let Some(reference) = input["elementRef"].as_str() {
        if let Some(element) = elements.iter().find(|e| e["elementRef"] == reference) {
            output["element"] = element.clone();
            output["selectors"] = json!(crate::core::rank_selectors(element, &elements));
        }
    }
    let query = input
        .get("query")
        .filter(|q| q["strategy"].is_string() && q["value"].is_string());
    if let Some(query) = query {
        output["matches"] = json!(
            elements
                .iter()
                .filter(|e| crate::core::candidate_matches(query, e))
                .collect::<Vec<_>>()
        );
    }
    if let Some(snapshots) = input["snapshots"].as_array() {
        if snapshots.len() > 10 {
            return error(
                StatusCode::BAD_REQUEST,
                "At most 10 stability snapshots are allowed",
            );
        }
        let mut parsed = Vec::new();
        for snapshot in snapshots {
            let Some(source) = snapshot.as_str() else {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Stability snapshots must be source strings",
                );
            };
            if source.chars().count() > 512 * 1024 {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Stability snapshot exceeds 512 KiB",
                );
            }
            let source = match crate::core::parse_source(source) {
                Ok(v) => v,
                Err(message) => return error(StatusCode::BAD_REQUEST, &message),
            };
            let elements = source["elements"].as_array().cloned().unwrap_or_default();
            if elements.len() > 2000 {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Stability snapshot exceeds 2000 elements",
                );
            }
            parsed.push(elements);
        }
        let candidates = output["selectors"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| query.map(|q| vec![q.clone()]).unwrap_or_default());
        output["stability"] = crate::core::evaluate_stability(&candidates, &parsed);
    }
    let mut response = response(StatusCode::OK, output);
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static("private, no-store"),
    );
    response
}

async fn upgrade(state: AppState, mut request: Request) -> Response {
    let on_upgrade = hyper::upgrade::on(&mut request);
    let target = format!(
        "{}{}",
        state.base,
        request.uri().path_and_query().map_or("/", |p| p.as_str())
    );
    let mut builder = state.http.request(request.method().clone(), target);
    for (name, value) in request.headers() {
        if name != "host" && name != "content-length" {
            builder = builder.header(name, value);
        }
    }
    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return error(
                if e.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                "Appium proxy request failed",
            );
        }
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    if status != StatusCode::SWITCHING_PROTOCOLS {
        let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
        *response.status_mut() = status;
        for (name, value) in &headers {
            if !hop_header(name.as_str(), &headers) {
                response.headers_mut().append(name, value.clone());
            }
        }
        return response;
    }
    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(async move {
        if *shutdown.borrow() {
            return;
        }
        let upgrade = async { tokio::join!(on_upgrade, upstream.upgrade()) };
        let result = tokio::select! {result=upgrade=>Some(result),_=shutdown.changed()=>None};
        if let Some((Ok(client), Ok(mut upstream))) = result {
            let mut client = hyper_util::rt::TokioIo::new(client);
            tokio::select! {_=tokio::io::copy_bidirectional(&mut client,&mut upstream)=>{},_=shutdown.changed()=>{}}
        }
    });
    let mut response = Response::new(Body::empty());
    *response.status_mut() = status;
    for (name, value) in &headers {
        response.headers_mut().append(name, value.clone());
    }
    response
}

async fn proxy(state: AppState, request: Request) -> Response {
    if request.headers().contains_key("upgrade") {
        return upgrade(state, request).await;
    }
    let (mut sender, receiver) = tokio::sync::oneshot::channel();
    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(async move {
        if *shutdown.borrow() {
            return;
        }
        let response = tokio::select! {response=proxy_request(state,request,&mut sender)=>response,_=shutdown.changed()=>error(StatusCode::SERVICE_UNAVAILABLE,"Recorder is shutting down")};
        let _ = sender.send(response);
    });
    receiver
        .await
        .unwrap_or_else(|_| error(StatusCode::BAD_GATEWAY, "Appium proxy request failed"))
}
async fn proxy_request(
    state: AppState,
    request: Request,
    cancelled: &mut tokio::sync::oneshot::Sender<Response>,
) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_string();

    let is_session = path == "/session" || path.starts_with("/session/");
    if is_session {
        if let Some(length) = parts.headers.get("content-length") {
            if length
                .to_str()
                .ok()
                .and_then(|s| s.parse::<usize>().ok())
                .is_none_or(|n| n > MAX_REQUEST)
            {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Appium request body exceeds 10 MiB",
                );
            }
        }
    }
    let bytes = match to_bytes(body, MAX_REQUEST).await {
        Ok(b) => b,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Appium request body exceeds 10 MiB",
            );
        }
    };
    if is_session && !bytes.is_empty() {
        let mime = parts
            .headers
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if mime != "application/json"
            && !(mime.starts_with("application/") && mime.ends_with("+json"))
        {
            return error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Appium request bodies must be JSON",
            );
        }
        if serde_json::from_slice::<Value>(&bytes).is_err() {
            return error(
                StatusCode::BAD_REQUEST,
                "Appium request body must be valid JSON",
            );
        }
    }
    let session = session_path(&path);
    if path.starts_with("/session/") && session.is_none() {
        return error(StatusCode::BAD_REQUEST, "Invalid session ID");
    }
    let gate: Option<OwnedMutexGuard<()>> = if let Some((session, _)) = &session {
        let mutex = {
            let mut gates = state.gates.lock().unwrap();
            gates.retain(|_, g| g.strong_count() > 0);
            let gate = gates
                .get(session)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(AsyncMutex::new(())));
            gates.insert(session.clone(), Arc::downgrade(&gate));
            gate
        };
        Some(
            tokio::select! {guard=mutex.lock_owned()=>guard,_=cancelled.closed()=>return StatusCode::from_u16(499).unwrap().into_response()},
        )
    } else {
        None
    };
    if cancelled.is_closed() {
        return StatusCode::from_u16(499).unwrap().into_response();
    }
    let mut interaction = None;
    let mut selector = None;
    let mut kind = "unknown";
    if let Some((sid, suffix)) = &session {
        let mut recorder = state.recorder.lock().unwrap();
        if parts.method == Method::DELETE && suffix == "/" {
            recorder.clear_session(sid);
        }
        if parts.method == Method::POST {
            kind = classify_action("POST", suffix);
            selector = request_selector(&bytes)
                .or_else(|| action_element(suffix).and_then(|e| recorder.selector(sid, &e)));
            interaction = Some(recorder.record(suffix, kind, selector.clone()));
        }
    }
    let target = format!(
        "{}{}",
        state.base,
        parts.uri.path_and_query().map_or("/", |p| p.as_str())
    );
    let mut builder = state.http.request(parts.method.clone(), target);
    for (name, value) in &parts.headers {
        if !hop_header(name.as_str(), &parts.headers) && name != "content-length" {
            builder = builder.header(name, value);
        }
    }
    if !bytes.is_empty() {
        builder = builder.body(bytes);
    }
    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if let Some(id) = interaction {
                state.recorder.lock().unwrap().update(id, None, "failed");
            }
            return error(
                if e.is_timeout() {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::BAD_GATEWAY
                },
                "Appium proxy request failed",
            );
        }
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let (sender, receiver) = mpsc::channel(2);
    let map_selector = kind == "find" && selector.is_some();
    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(async move {
        let _gate = gate;
        let mut stream = upstream.bytes_stream();
        let mut captured = Vec::new();
        let mut too_large = false;
        let mut success = true;
        loop {
            if *shutdown.borrow() {
                success = false;
                break;
            }
            let chunk = tokio::select! {chunk=stream.next()=>chunk,_=shutdown.changed()=>{success=false;break;}};
            let Some(chunk) = chunk else {
                break;
            };
            match chunk {
                Ok(bytes) => {
                    if map_selector && !too_large {
                        if captured.len() + bytes.len() > MAX_SELECTOR_RESPONSE {
                            captured.clear();
                            too_large = true;
                        } else {
                            captured.extend_from_slice(&bytes);
                        }
                    }
                    if tokio::select! {result=sender.send(Ok::<_,std::io::Error>(bytes))=>result.is_err(),_=shutdown.changed()=>true}
                    {
                        success = false;
                        break;
                    }
                }
                Err(e) => {
                    let _ = sender.send(Err(std::io::Error::other(e))).await;
                    success = false;
                    break;
                }
            }
        }
        drop(sender);
        if !success {
            if let Some(id) = interaction {
                state.recorder.lock().unwrap().update(id, None, "failed");
            }
            return;
        }
        if let (Some((sid, _)), Some(selector)) = (&session, &selector) {
            if map_selector && !too_large && status.is_success() {
                if let Ok(value) = serde_json::from_slice::<Value>(&captured) {
                    let elements = value["value"]
                        .as_array()
                        .cloned()
                        .unwrap_or_else(|| vec![value["value"].clone()]);
                    let mut recorder = state.recorder.lock().unwrap();
                    for element in elements {
                        if let Some(id) = element[ELEMENT_KEY]
                            .as_str()
                            .or_else(|| element["ELEMENT"].as_str())
                            .filter(|s| !s.is_empty())
                        {
                            recorder.store_selector(sid, id, selector);
                        }
                    }
                }
            }
        }
        if let (Some(id), Some((sid, _))) = (interaction, session) {
            if kind == "unknown" {
                return;
            }
            if !status.is_success() {
                state.recorder.lock().unwrap().update(id, None, "skipped");
                return;
            }
            let Ok(_job) = state.capture_jobs.clone().try_acquire_owned() else {
                state.recorder.lock().unwrap().update(id, None, "skipped");
                return;
            };
            let Ok(_slot) = state.capture_slots.clone().acquire_owned().await else {
                return;
            };
            if *shutdown.borrow() {
                return;
            }
            match tokio::select! {result=state.client.capture_state(&sid)=>Some(result),_=shutdown.changed()=>None}
            {
                Some(Ok(capture)) => {
                    state
                        .recorder
                        .lock()
                        .unwrap()
                        .update(id, Some(capture), "failed")
                }
                Some(Err(_)) | None => state.recorder.lock().unwrap().update(id, None, "failed"),
            }
        }
    });
    let mut response = Response::new(Body::from_stream(ReceiverStream::new(receiver)));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if !hop_header(name.as_str(), &headers) {
            response.headers_mut().append(name, value.clone());
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;
    #[test]
    fn actions_and_selector_bounds() {
        assert_eq!(classify_action("POST", "/element/abc/click/"), "tap");
        assert_eq!(classify_action("GET", "/back"), "unknown");
        assert_eq!(classify_action("POST", "/element//click"), "unknown");
        assert_eq!(
            session_path("/session/a%2Fb/element").unwrap(),
            ("a/b".into(), "/element".into())
        );
        assert!(session_path("/session/a%zz/element").is_none());
        assert!(canonical_id("001").is_none());
        assert!(request_selector(br#"{"using":"id","value":""}"#).is_none());
    }
    #[test]
    fn history_eviction_and_stale_capture() {
        let mut recorder = Recorder::default();
        let old = recorder.record("/old", "tap", None);
        recorder.clear();
        let current = recorder.record("/current", "tap", None);
        recorder.update(old, Some(json!({"source":"<stale/>"})), "failed");
        assert!(current > old);
        assert!(recorder.history[0].data.get("source").is_none());
        recorder.update(
            current,
            Some(json!({"source":"<screen/>","screenshot":STANDARD.encode(b"png")})),
            "failed",
        );
        assert_eq!(recorder.history[0].data["captureStatus"], "complete");
        for _ in 0..500 {
            recorder.record("/next", "unknown", None);
        }
        assert_eq!(recorder.history.len(), 500);
        assert!(recorder.history.iter().all(|e| e.screenshot.is_none()));
    }
    #[test]
    fn selectors_are_scoped_and_lru_bounded() {
        let mut recorder = Recorder::default();
        let selector = json!({"using":"id","value":"button"});
        recorder.store_selector("a", "same", &selector);
        assert!(recorder.selector("b", "same").is_none());
        for n in 0..5000 {
            recorder.store_selector("b", &n.to_string(), &selector);
        }
        assert_eq!(recorder.selectors.len(), 5000);
        assert!(recorder.selector("a", "same").is_none());
        recorder.clear();
        assert!(recorder.selector("b", "1").is_none());
    }
    #[tokio::test]
    async fn routes_reject_foreign_hosts_and_origins_and_serve_history() {
        let router = router("http://127.0.0.1:4723").unwrap();
        for (host, origin) in [("evil.com", None), ("127.0.0.1", Some("https://evil.com"))] {
            let mut builder = axum::http::Request::builder()
                .uri("/_recorder/api/history")
                .header("host", host);
            if let Some(origin) = origin {
                builder = builder.header("origin", origin);
            }
            let response = router
                .clone()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let request = axum::http::Request::builder()
            .uri("/_recorder/api/history")
            .header("host", "localhost:4724")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "[]");
    }
    async fn http_fixture(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base, task)
    }
    #[tokio::test]
    async fn real_proxy_waits_for_capture_maps_selectors_and_clears_resources() {
        let (source_seen, mut source_receiver) = mpsc::channel::<()>(8);
        let release = Arc::new(Semaphore::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fixture = Router::new().fallback({
            let release = release.clone();
            let seen = seen.clone();
            move |request: Request| {
                let release = release.clone();
                let seen = seen.clone();
                let source_seen = source_seen.clone();
                async move {
                    let path = request.uri().path().to_string();
                    seen.lock().unwrap().push(path.clone());
                    if path.ends_with("/source") {
                        source_seen.send(()).await.unwrap();
                        let _permit = release.acquire().await.unwrap();
                        axum::Json(
                            json!({"value":"<hierarchy><node resource-id=\"login\"/></hierarchy>"}),
                        )
                    } else if path.ends_with("/screenshot") {
                        axum::Json(json!({"value":STANDARD.encode(b"png-bytes")}))
                    } else if path.ends_with("/element") {
                        axum::Json(json!({"value":{ELEMENT_KEY:"button /?"}}))
                    } else {
                        axum::Json(json!({"value":null}))
                    }
                }
            }
        });
        let (upstream, upstream_task) = http_fixture(fixture).await;
        let (base, proxy_task) = http_fixture(router(&upstream).unwrap()).await;
        let http = reqwest::Client::new();
        let events = http
            .get(format!("{base}/_recorder/api/stream"))
            .send()
            .await
            .unwrap();
        assert_eq!(events.headers()["content-type"], "text/event-stream");
        let mut events = events.bytes_stream();
        let initial = events.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&initial).contains("\"type\":\"init\""));
        let find = http
            .post(format!("{base}/session/opaque-secret/element"))
            .json(&json!({"using":"id","value":"login"}))
            .send()
            .await
            .unwrap();
        assert_eq!(find.status(), StatusCode::OK);
        let _ = find.bytes().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), source_receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let click = tokio::spawn({
            let http = http.clone();
            let base = base.clone();
            async move {
                http.post(format!(
                    "{base}/session/opaque-secret/element/button%20%2F%3F/click"
                ))
                .json(&json!({}))
                .send()
                .await
                .unwrap()
            }
        });
        tokio::task::yield_now().await;
        assert!(!seen.lock().unwrap().iter().any(|p| p.ends_with("/click")));
        release.add_permits(2);
        let click = tokio::time::timeout(Duration::from_secs(3), click)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(click.status(), StatusCode::OK);
        let _ = click.bytes().await.unwrap();
        // A same-session GET waits through the preceding capture before forwarding.
        let barrier = http
            .get(format!("{base}/session/opaque-secret/title"))
            .send()
            .await
            .unwrap();
        assert_eq!(barrier.status(), StatusCode::OK);
        let history: Value = http
            .get(format!("{base}/_recorder/api/history"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history.as_array().unwrap().len(), 2);
        assert_eq!(
            history[1]["elementInfo"],
            json!({"using":"id","value":"login"})
        );
        assert_eq!(history[1]["captureStatus"], "complete");
        assert_eq!(history[1]["path"], "/element/button%20%2F%3F/click");
        assert!(!history.to_string().contains("opaque-secret"));
        let complete = tokio::time::timeout(Duration::from_secs(3), async {
            let mut buffer = String::new();
            loop {
                let chunk = events.next().await.unwrap().unwrap();
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(end) = buffer.find("\n\n") {
                    let frame = buffer[..end].to_string();
                    buffer.drain(..end + 2);
                    let event: Value =
                        serde_json::from_str(frame.strip_prefix("data: ").unwrap()).unwrap();
                    if event["type"] == "interaction"
                        && event["data"]["id"] == 2
                        && event["data"]["captureStatus"] == "complete"
                    {
                        return event;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(complete["data"]["elementInfo"]["value"], "login");
        let screenshot = history[1]["screenshotUrl"].as_str().unwrap();
        let png = http
            .get(format!("{base}{screenshot}"))
            .send()
            .await
            .unwrap();
        assert_eq!(png.headers()["content-type"], "image/png");
        assert_eq!(png.bytes().await.unwrap(), "png-bytes");
        http.delete(format!("{base}/_recorder/api/history"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            http.get(format!("{base}{screenshot}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        proxy_task.abort();
        upstream_task.abort();
    }
    #[tokio::test]
    async fn real_proxy_preserves_errors_limits_and_websocket_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let fixture = Router::new().fallback(|mut request: Request| async move {
            if request.headers().contains_key("upgrade") {
                let upgrade = hyper::upgrade::on(&mut request);
                tokio::spawn(async move {
                    let mut io = hyper_util::rt::TokioIo::new(upgrade.await.unwrap());
                    let mut buf = [0; 4];
                    io.read_exact(&mut buf).await.unwrap();
                    io.write_all(&buf).await.unwrap();
                });
                (
                    StatusCode::SWITCHING_PROTOCOLS,
                    [("connection", "upgrade"), ("upgrade", "websocket")],
                    "",
                )
                    .into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({"value":{"error":"unknown error","message":"fixture"}})),
                )
                    .into_response()
            }
        });
        let (upstream, upstream_task) = http_fixture(fixture).await;
        let (base, proxy_task) = http_fixture(router(&upstream).unwrap()).await;
        let http = reqwest::Client::new();
        let failed = http
            .post(format!("{base}/session/secret/back"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            failed.json::<Value>().await.unwrap()["value"]["message"],
            "fixture"
        );
        let history: Value = http
            .get(format!("{base}/_recorder/api/history"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(history[0]["captureStatus"], "skipped");
        assert_eq!(
            http.post(format!("{base}/session/secret/back"))
                .body("bytes")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            http.post(format!("{base}/session/secret/back"))
                .header("content-type", "application/json")
                .body("{")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let socket = base.trim_start_matches("http://");
        let mut client = tokio::net::TcpStream::connect(socket).await.unwrap();
        client.write_all(format!("GET /session/secret/bidi HTTP/1.1\r\nHost: {socket}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://localhost:3000\r\n\r\n").as_bytes()).await.unwrap();
        let mut header = Vec::new();
        loop {
            let mut byte = [0; 1];
            tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut byte))
                .await
                .unwrap()
                .unwrap();
            header.push(byte[0]);
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&header).starts_with("HTTP/1.1 101"));
        client.write_all(b"ping").await.unwrap();
        let mut echo = [0; 4];
        tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut echo))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&echo, b"ping");
        proxy_task.abort();
        upstream_task.abort();
    }
    #[tokio::test]
    async fn inspector_queries_ranks_and_reports_stability() {
        let source = r#"<hierarchy><node resource-id="login" clickable="true"/></hierarchy>"#;
        let parsed = crate::core::parse_source(source).unwrap();
        let reference = parsed["elements"][1]["elementRef"].clone();
        let request=axum::http::Request::builder().method("POST").uri("/_recorder/api/inspect").header("host","localhost")
            .body(Body::from(json!({"source":source,"elementRef":reference,"query":{"strategy":"id","value":"login"},"snapshots":[source,"<hierarchy/>"]}).to_string())).unwrap();
        let response = router("http://127.0.0.1:4723")
            .unwrap()
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), MAX_REQUEST).await.unwrap())
                .unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert!(!result["selectors"].as_array().unwrap().is_empty());
        assert!(
            result["stability"]["results"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["stableSteps"] == 1 && r["firstFailureStep"] == 2)
        );
    }

    #[tokio::test]
    async fn cancelled_queued_commands_are_never_forwarded() {
        let release = Arc::new(Semaphore::new(0));
        let (started, mut started_rx) = mpsc::channel(2);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fixture = Router::new().fallback({
            let release = release.clone();
            let seen = seen.clone();
            move |request: Request| {
                let release = release.clone();
                let seen = seen.clone();
                let started = started.clone();
                async move {
                    let path = request.uri().path().to_string();
                    seen.lock().unwrap().push(path.clone());
                    if path.ends_with("/first/click") {
                        let _ = started.send(()).await;
                        let _ = release.acquire().await;
                    }
                    axum::Json(json!({"value":null}))
                }
            }
        });
        let (upstream, task) = http_fixture(fixture).await;
        let router = router(&upstream).unwrap();
        let action = |name: &str| {
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/session/s/element/{name}/click"))
                .header("host", "localhost")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap()
        };
        let first = tokio::spawn(router.clone().oneshot(action("first")));
        tokio::time::timeout(Duration::from_secs(3), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        let cancelled = tokio::spawn(router.clone().oneshot(action("cancelled")));
        tokio::task::yield_now().await;
        cancelled.abort();
        assert!(cancelled.await.is_err());
        release.add_permits(1);
        let response = first.await.unwrap().unwrap();
        let _ = to_bytes(response.into_body(), 1024).await.unwrap();
        let barrier = axum::http::Request::builder()
            .uri("/session/s/title")
            .header("host", "localhost")
            .body(Body::empty())
            .unwrap();
        let response = tokio::time::timeout(Duration::from_secs(3), router.oneshot(barrier))
            .await
            .unwrap()
            .unwrap();
        let _ = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(
            !seen
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.ends_with("/cancelled/click"))
        );
        task.abort();
    }
    #[tokio::test]
    async fn shutdown_releases_pending_headers_and_live_streams() {
        let (started, mut started_rx) = mpsc::channel(2);
        let upstream = Router::new().fallback(move || {
            let started = started.clone();
            async move {
                let _ = started.send(()).await;
                std::future::pending::<&'static str>().await
            }
        });
        let (upstream, task) = http_fixture(upstream).await;
        let (router, shutdown) = build_router(&upstream).unwrap();
        let stream = axum::http::Request::builder()
            .uri("/_recorder/api/stream")
            .header("host", "localhost")
            .body(Body::empty())
            .unwrap();
        let mut stream = router
            .clone()
            .oneshot(stream)
            .await
            .unwrap()
            .into_body()
            .into_data_stream();
        assert!(stream.next().await.is_some());
        let request = axum::http::Request::builder()
            .uri("/status")
            .header("host", "localhost")
            .body(Body::empty())
            .unwrap();
        let waiting = tokio::spawn(router.oneshot(request));
        tokio::time::timeout(Duration::from_secs(3), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        shutdown.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .is_none()
        );
        task.abort();
    }
}
