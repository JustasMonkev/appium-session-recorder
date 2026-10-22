//! Opt-in device test, plus device-free checks of the same harness.
use super::{MockAppium, Response, TempDir, envelope, run_with_timeout};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{fs, panic::AssertUnwindSafe, time::Duration};

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(180);

fn required_env(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| panic!("Set {name}; see README: Optional live-Appium smoke test"))
}

// Device setup may take longer than the mock tests' ten-second command budget.
// File output also keeps large screenshots from filling the child's stdout pipe.
fn command(url: &str, group: &str, subcommand: &str, extra: &[&str]) -> Value {
    let dir = TempDir::new();
    let output_file = dir.0.join("response.json");
    let mut args = vec![
        group,
        subcommand,
        "--appium-url",
        url,
        "--output",
        output_file.to_str().unwrap(),
    ];
    args.extend_from_slice(extra);
    let mut output = run_with_timeout(&args, COMMAND_TIMEOUT);
    assert!(output.stdout.is_empty(), "--output must leave stdout empty");
    output.stdout = fs::read(output_file).expect("CLI did not write its JSON response");
    envelope(&output, &format!("{group}.{subcommand}"), true)["result"].clone()
}

struct Proxy(tokio::task::JoinHandle<()>);
impl Drop for Proxy {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Session<'a> {
    upstream: &'a str,
    id: String,
    deleted: bool,
}
impl Drop for Session<'_> {
    fn drop(&mut self) {
        if self.deleted {
            return;
        }
        // On assertion/command failure, bypass a possibly broken proxy. Do not
        // panic during unwinding; report cleanup failures for manual recovery.
        let cleanup = std::panic::catch_unwind(|| {
            run_with_timeout(
                &[
                    "session",
                    "delete",
                    "--appium-url",
                    self.upstream,
                    "--session-id",
                    &self.id,
                ],
                COMMAND_TIMEOUT,
            )
        });
        match cleanup {
            Ok(output) => eprintln!(
                "Fallback cleanup for session {} ({}): {} {}",
                self.id,
                output.status,
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(_) => eprintln!(
                "Fallback cleanup failed; manually delete session {}",
                self.id
            ),
        }
    }
}

struct Events {
    response: reqwest::Response,
    pending: Vec<u8>,
}
impl Events {
    async fn next(&mut self) -> Value {
        loop {
            if let Some(end) = self.pending.windows(2).position(|w| w == b"\n\n") {
                let frame: Vec<_> = self.pending.drain(..end + 2).collect();
                let data = frame.strip_prefix(b"data: ").expect("SSE data frame");
                return serde_json::from_slice(data).expect("SSE JSON payload");
            }
            let chunk = self
                .response
                .chunk()
                .await
                .expect("SSE read failed")
                .expect("SSE closed before delivery");
            self.pending.extend_from_slice(&chunk);
            assert!(self.pending.len() <= 4 * 1024 * 1024, "SSE buffer limit");
        }
    }
}

async fn smoke(upstream: &str, caps_file: &str, using: &str, selector: &str) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = appium_session_recorder::server::router(upstream).unwrap();
    let _proxy = Proxy(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let created = command(&base, "session", "create", &["--caps-file", caps_file]);
    let mut session = Session {
        upstream,
        id: created["sessionId"].as_str().unwrap().to_owned(),
        deleted: false,
    };
    assert!(!session.id.is_empty());
    eprintln!("PASS: session creation through recorder proxy");
    let sid = ["--session-id", session.id.as_str()];
    let snapshot = command(&base, "screen", "snapshot", &sid);
    let source = snapshot["source"].as_str().unwrap();
    assert!(!source.trim().is_empty());
    let png = STANDARD
        .decode(snapshot["screenshot"].as_str().unwrap())
        .unwrap();
    assert!(
        png.starts_with(b"\x89PNG\r\n\x1a\n"),
        "screenshot must be PNG"
    );
    eprintln!("PASS: screenshot and page-source capture");
    let elements = command(&base, "screen", "elements", &sid);
    assert!(!elements["elements"].as_array().unwrap().is_empty());
    let reference = elements["elements"][0]["elementRef"].as_str().unwrap();
    let ranked = command(
        &base,
        "selectors",
        "best",
        &["--session-id", &session.id, "--element-ref", reference],
    );
    assert_eq!(ranked["target"]["elementRef"], reference);
    assert!(!ranked["allSelectors"].as_array().unwrap().is_empty());
    eprintln!("PASS: element inspection and selector ranking");

    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let response = http
        .get(format!("{base}/_recorder/api/stream"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut events = Events {
        response,
        pending: Vec::new(),
    };
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), events.next())
            .await
            .expect("SSE initialization timed out")["type"],
        "init"
    );
    // Only the explicitly configured target is tapped; never choose an element
    // automatically from the hierarchy or fall back to back/swipe/type.
    let tapped = command(
        &base,
        "drive",
        "tap",
        &[
            "--session-id",
            &session.id,
            "--using",
            using,
            "--value",
            selector,
        ],
    );
    assert_eq!(tapped["performed"], true);
    eprintln!("PASS: configured safe tap");
    let interaction = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = events.next().await;
            let action = &event["data"];
            if event["type"] == "interaction" && action["actionKind"] == "tap" {
                if action["captureStatus"] == "pending" {
                    continue;
                }
                assert_eq!(action["captureStatus"], "complete", "tap capture failed");
                assert_eq!(
                    action["elementInfo"],
                    json!({"using":using,"value":selector})
                );
                break action.clone();
            }
        }
    })
    .await
    .expect("No completed tap event delivered over SSE within 30 seconds");
    let id = interaction["id"].as_u64().unwrap();
    let detail: Value = http
        .get(format!("{base}/_recorder/api/interaction/{id}"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!detail["source"].as_str().unwrap().trim().is_empty());
    let image = http
        .get(format!(
            "{base}{}",
            detail["screenshotUrl"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(image.starts_with(b"\x89PNG\r\n\x1a\n"));
    drop(events);
    eprintln!("PASS: SSE tap event, selector attribution and recorded captures");
    let deleted = command(&base, "session", "delete", &sid);
    assert_eq!(deleted["deleted"], true);
    session.deleted = true;
    eprintln!("PASS: session cleanup through recorder proxy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit live Appium URL, capabilities and safe tap target; see README"]
async fn live_appium_smoke() {
    let upstream = required_env("APPIUM_LIVE_URL");
    let caps_file = required_env("APPIUM_LIVE_CAPS_FILE");
    let using = required_env("APPIUM_LIVE_TAP_USING");
    let selector = required_env("APPIUM_LIVE_TAP_VALUE");
    smoke(&upstream, &caps_file, &using, &selector).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn smoke_harness_checks_success_and_cleans_up_after_failure() {
    for failure in ["none", "source", "tap", "tap-capture"] {
        let tapped = std::sync::atomic::AtomicBool::new(false);
        let mock = MockAppium::new(move |request| {
            let value = match (request.method.as_str(), request.path.as_str()) {
                ("POST", "/wd/hub/session") => json!({"sessionId":"smoke","capabilities":{}}),
                ("GET", "/wd/hub/session/smoke/source")
                    if failure == "source"
                        || (failure == "tap-capture"
                            && tapped.load(std::sync::atomic::Ordering::Relaxed)) =>
                {
                    return Response::error(500, "unknown error", "capture failed");
                }
                ("GET", "/wd/hub/session/smoke/source") => json!(super::ANDROID),
                ("GET", "/wd/hub/session/smoke/screenshot") => json!(PNG),
                ("POST", "/wd/hub/session/smoke/element") => {
                    assert_eq!(
                        request.body,
                        json!({"using":"accessibility id","value":"continue"})
                    );
                    json!({"element-6066-11e4-a52e-4f735466cecf":"button"})
                }
                ("POST", "/wd/hub/session/smoke/element/button/click") if failure == "tap" => {
                    return Response::error(500, "unknown error", "tap failed");
                }
                ("POST", "/wd/hub/session/smoke/element/button/click") => {
                    tapped.store(true, std::sync::atomic::Ordering::Relaxed);
                    Value::Null
                }
                ("DELETE", "/wd/hub/session/smoke") => Value::Null,
                _ => return Response::error(404, "unknown command", "unexpected request"),
            };
            Response::json(json!({"value":value}))
        });
        let dir = TempDir::new();
        let caps_file = dir.0.join("caps.json");
        fs::write(&caps_file, r#"{"platformName":"Android"}"#).unwrap();
        let result = AssertUnwindSafe(smoke(
            &format!("{}/wd/hub", mock.url),
            caps_file.to_str().unwrap(),
            "accessibility id",
            "continue",
        ))
        .catch_unwind()
        .await;
        assert_eq!(
            result.is_err(),
            failure != "none",
            "failure case: {failure}"
        );
        assert_eq!(
            mock.recorded()
                .iter()
                .filter(|r| r.method == "DELETE" && r.path == "/wd/hub/session/smoke")
                .count(),
            1,
            "session must be deleted on success and after failed capture, tap or event"
        );
        assert_eq!(
            mock.recorded().iter().any(|r| r.path.ends_with("/click")),
            failure != "source",
            "exercise the intended failure phase"
        );
    }
}
