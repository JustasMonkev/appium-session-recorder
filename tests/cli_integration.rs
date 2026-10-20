use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const ANDROID: &str = r#"<hierarchy><node class="android.widget.Button" text="Continue" content-desc="continue" resource-id="com.example:id/continue" enabled="true" clickable="true" bounds="[0,0][100,50]"/><node class="android.widget.TextView" text="Disabled" enabled="false" bounds="[0,60][100,100]"/></hierarchy>"#;
const IOS: &str = r#"<AppiumAUT type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow"><XCUIElementTypeButton type="XCUIElementTypeButton" name="loginBtn" label="Log In" enabled="true" visible="true" accessible="true"/></XCUIElementTypeWindow></AppiumAUT>"#;

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    body: Value,
}

struct Response {
    status: u16,
    body: String,
}
impl Response {
    fn json(body: Value) -> Self {
        Self {
            status: 200,
            body: body.to_string(),
        }
    }
    fn error(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            body: json!({"value":{"error":code,"message":message}}).to_string(),
        }
    }
}

struct MockAppium {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl MockAppium {
    fn new(handler: impl Fn(&Request) -> Response + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_requests = requests.clone();
        let thread_stop = stop.clone();
        let worker = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = read_request(&mut stream);
                        let response = handler(&request);
                        thread_requests.lock().unwrap().push(request);
                        let header = format!(
                            "HTTP/1.1 {} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            response.status,
                            response.body.len()
                        );
                        // A sibling capture can be cancelled after another capture fails.
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(response.body.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("mock accept failed: {error}"),
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn recorded(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
    fn command(&self, group: &str, subcommand: &str, extra: &[&str]) -> Output {
        let mut args = vec![group, subcommand, "--appium-url", &self.url];
        args.extend_from_slice(extra);
        run(&args)
    }
}
impl Drop for MockAppium {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn read_request(stream: &mut TcpStream) -> Request {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut raw = Vec::new();
    let header_end = loop {
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        raw.push(byte[0]);
        if raw.ends_with(b"\r\n\r\n") {
            break raw.len();
        }
        assert!(raw.len() < 64 * 1024, "request headers too large");
    };
    let header = String::from_utf8(raw.clone()).unwrap();
    let mut request_line = header.lines().next().unwrap().split_whitespace();
    let method = request_line.next().unwrap().to_owned();
    let path = request_line.next().unwrap().to_owned();
    let length: usize = header
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap_or(0);
    raw.resize(header_end + length, 0);
    stream.read_exact(&mut raw[header_end..]).unwrap();
    Request {
        method,
        path,
        body: if length == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&raw[header_end..]).unwrap()
        },
    }
}

fn run(args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_appium-recorder"))
        .args(args)
        .env_remove("APPIUM_URL")
        .env_remove("PROXY_HOST")
        .env_remove("PROXY_PORT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "CLI timed out for {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(5));
    }
    child.wait_with_output().unwrap()
}

fn envelope(output: &Output, command: &str, success: bool) -> Value {
    assert_eq!(
        output.status.success(),
        success,
        "stderr: {} stdout: {}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["ok"], success);
    assert_eq!(value["command"], command);
    chrono::DateTime::parse_from_rfc3339(value["timestamp"].as_str().unwrap()).unwrap();
    assert_eq!(value.get("result").is_some(), success);
    assert_eq!(value.get("error").is_some(), !success);
    value
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("recorder-cli-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn help_version_and_route_errors_have_expected_exit_contract() {
    let help = run(&["--help"]);
    assert!(help.status.success());
    assert!(
        String::from_utf8(help.stdout)
            .unwrap()
            .contains("screen snapshot")
    );
    let version = run(&["--version"]);
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        format!("Appium Session Recorder v{}", env!("CARGO_PKG_VERSION"))
    );
    for args in [
        vec!["bogus"],
        vec!["screen"],
        vec!["drive", "fly"],
        vec!["--pretty"],
        vec!["--help", "--pretty"],
        vec!["drive", "back", "--output"],
    ] {
        let value = envelope(&run(&args), "cli.parse", false);
        assert_eq!(value["error"]["code"], "CLI_PARSE_ERROR");
    }
}

#[test]
fn invalid_command_inputs_do_not_contact_appium() {
    let mock = MockAppium::new(|_| Response::json(json!({"value":null})));
    let cases: &[(&str, &str, &[&str], &str)] = &[
        (
            "session",
            "create",
            &["--caps-json", "[]"],
            "INVALID_CAPABILITIES",
        ),
        (
            "session",
            "create",
            &["--caps-json", "{bad"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "session",
            "create",
            &["--caps-json", "{}", "--caps-file", "caps.json"],
            "COMMAND_EXECUTION_ERROR",
        ),
        ("session", "create", &[], "COMMAND_EXECUTION_ERROR"),
        (
            "drive",
            "back",
            &["--session-id", "s", "--typo"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "drive",
            "tap",
            &["--session-id", "s", "--using", "id"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "drive",
            "type",
            &[
                "--session-id",
                "s",
                "--using",
                "id",
                "--value",
                "x",
                "--text",
                "abc",
                "--clear-first=false",
            ],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "screen",
            "elements",
            &["--session-id", "s", "--limit", "0"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "screen",
            "elements",
            &["--session-id", "s", "--limit", "1.5"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "screen",
            "elements",
            &["--session-id", "s", "--only-actionable=false"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "drive",
            "swipe",
            &["--session-id", "s", "--from", "1e3,2", "--to", "1,2"],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "drive",
            "swipe",
            &[
                "--session-id",
                "s",
                "--from",
                "1,2",
                "--to",
                "3,4",
                "--duration-ms",
                "49",
            ],
            "COMMAND_EXECUTION_ERROR",
        ),
        (
            "drive",
            "scroll",
            &["--session-id", "s", "--direction", "diagonal"],
            "COMMAND_EXECUTION_ERROR",
        ),
    ];
    for (group, subcommand, args, code) in cases {
        let result = envelope(
            &mock.command(group, subcommand, args),
            &format!("{group}.{subcommand}"),
            false,
        );
        assert_eq!(result["error"]["code"], *code, "{args:?}");
    }
    assert!(mock.recorded().is_empty());
    for url in [
        "ftp://localhost",
        "http://user:password@localhost",
        "http://localhost?secret=1",
        "http://localhost/#fragment",
    ] {
        let result = envelope(
            &run(&[
                "session",
                "delete",
                "--appium-url",
                url,
                "--session-id",
                "s",
            ]),
            "session.delete",
            false,
        );
        assert_eq!(result["error"]["code"], "INVALID_APPIUM_URL");
    }
}

#[test]
fn creates_sessions_from_inline_and_file_capabilities_without_double_wrapping() {
    let mock = MockAppium::new(|_| {
        Response::json(
            json!({"value":{"sessionId":"created-session","capabilities":{"platformName":"iOS"}}}),
        )
    });
    let output = mock.command(
        "session",
        "create",
        &[
            "--caps-json",
            r#"{"platformName":"iOS","appium:automationName":"XCUITest"}"#,
        ],
    );
    let value = envelope(&output, "session.create", true);
    assert_eq!(value["result"]["sessionId"], "created-session");
    let first = &mock.recorded()[0];
    assert_eq!((&*first.method, &*first.path), ("POST", "/session"));
    assert_eq!(
        first.body,
        json!({"capabilities":{"alwaysMatch":{"platformName":"iOS","appium:automationName":"XCUITest"},"firstMatch":[{}]}})
    );
    let dir = TempDir::new();
    let file = dir.0.join("caps.json");
    let wrapped =
        json!({"capabilities":{"alwaysMatch":{"platformName":"Android"},"firstMatch":[{}]}});
    fs::write(&file, wrapped.to_string()).unwrap();
    envelope(
        &mock.command(
            "session",
            "create",
            &["--caps-file", file.to_str().unwrap()],
        ),
        "session.create",
        true,
    );
    assert_eq!(mock.recorded()[1].body, wrapped);
}

#[test]
fn legacy_session_response_and_encoded_delete_path_work_with_base_path() {
    let mock = MockAppium::new(|request| {
        if request.method == "POST" {
            Response::json(json!({"sessionId":"legacy","value":{"platformName":"Android"}}))
        } else {
            Response::json(json!({"value":null}))
        }
    });
    let url = format!("{}/wd/hub/", mock.url);
    envelope(
        &run(&[
            "session",
            "create",
            "--appium-url",
            &url,
            "--caps-json",
            "{}",
        ]),
        "session.create",
        true,
    );
    let result = envelope(
        &run(&[
            "session",
            "delete",
            "--appium-url",
            &url,
            "--session-id",
            "a/b ?#雪",
        ]),
        "session.delete",
        true,
    );
    assert_eq!(result["result"]["deleted"], true);
    let requests = mock.recorded();
    assert_eq!(requests[0].path, "/wd/hub/session");
    assert_eq!(requests[1].path, "/wd/hub/session/a%2Fb%20%3F%23%E9%9B%AA");
    assert_eq!(requests[1].method, "DELETE");
}

#[test]
fn output_file_is_pretty_and_private_and_write_failures_are_json_errors() {
    let mock = MockAppium::new(|_| Response::json(json!({"value":null})));
    let dir = TempDir::new();
    let file = dir.0.join("nested/response.json");
    let output = mock.command(
        "drive",
        "back",
        &[
            "--session-id",
            "s",
            "--pretty",
            "--output",
            file.to_str().unwrap(),
        ],
    );
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let text = fs::read_to_string(file).unwrap();
    assert!(text.contains("\n  \"command\": \"drive.back\""));
    assert!(text.ends_with('\n'));
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["result"]["performed"],
        true
    );
    let blocker = dir.0.join("blocker");
    fs::write(&blocker, "file").unwrap();
    let blocked = blocker.join("response.json");
    let result = envelope(
        &mock.command(
            "drive",
            "back",
            &["--session-id", "s", "--output", blocked.to_str().unwrap()],
        ),
        "drive.back",
        false,
    );
    assert_eq!(result["error"]["code"], "OUTPUT_WRITE_ERROR");
}

#[test]
fn tap_and_type_use_both_element_id_formats_and_preserve_unicode_text() {
    for key in ["element-6066-11e4-a52e-4f735466cecf", "ELEMENT"] {
        let mock = MockAppium::new(move |request| {
            if request.path.ends_with("/element") {
                Response::json(json!({"value":{key:"e/a ?#雪"}}))
            } else {
                Response::json(json!({"value":null}))
            }
        });
        envelope(
            &mock.command(
                "drive",
                "tap",
                &[
                    "--session-id",
                    "s/a",
                    "--using",
                    "accessibility id",
                    "--value",
                    "Log In",
                ],
            ),
            "drive.tap",
            true,
        );
        let typed = envelope(
            &mock.command(
                "drive",
                "type",
                &[
                    "--session-id",
                    "s/a",
                    "--using",
                    "id",
                    "--value",
                    "input",
                    "--text",
                    "a😀é",
                    "--clear-first",
                ],
            ),
            "drive.type",
            true,
        );
        assert_eq!(typed["result"]["textLength"], 4);
        assert_eq!(typed["result"]["clearFirst"], true);
        let requests = mock.recorded();
        assert_eq!(requests.len(), 5);
        assert_eq!(
            requests[0].body,
            json!({"using":"accessibility id","value":"Log In"})
        );
        assert_eq!(
            requests[1].path,
            "/session/s%2Fa/element/e%2Fa%20%3F%23%E9%9B%AA/click"
        );
        assert!(requests[3].path.ends_with("/clear"));
        assert!(requests[4].path.ends_with("/value"));
        assert_eq!(
            requests[4].body,
            json!({"text":"a😀é","value":["a","😀","é"]})
        );
    }
}

#[test]
fn swipe_releases_actions_on_success_and_failure_and_keeps_original_error() {
    for fail in [false, true] {
        let mock = MockAppium::new(move |request| {
            if fail && request.method == "POST" {
                Response::error(500, "unknown error", "gesture failed")
            } else if fail {
                Response::error(500, "cleanup error", "release failed")
            } else {
                Response::json(json!({"value":null}))
            }
        });
        let result = envelope(
            &mock.command(
                "drive",
                "swipe",
                &[
                    "--session-id",
                    "s",
                    "--from",
                    "-1,.5",
                    "--to",
                    "10,20",
                    "--duration-ms",
                    "50",
                ],
            ),
            "drive.swipe",
            !fail,
        );
        let requests = mock.recorded();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            (&*requests[0].method, &*requests[1].method),
            ("POST", "DELETE")
        );
        assert_eq!(requests[0].path, "/session/s/actions");
        assert_eq!(requests[1].path, requests[0].path);
        let actions = &requests[0].body["actions"][0];
        assert_eq!(actions["parameters"]["pointerType"], "touch");
        assert_eq!(actions["actions"][0]["x"], -1.0);
        assert_eq!(actions["actions"][0]["y"], 0.5);
        assert_eq!(actions["actions"][3]["duration"], 50);
        if fail {
            assert_eq!(result["error"]["code"], "unknown error");
            assert_eq!(result["error"]["message"], "gesture failed");
        }
    }
}

#[test]
fn scroll_falls_back_to_legacy_window_size_and_calculates_direction() {
    let mock = MockAppium::new(|request| {
        if request.path.ends_with("/rect") {
            Response::error(404, "unknown command", "unsupported")
        } else if request.path.ends_with("/size") {
            Response::json(json!({"value":{"width":1200,"height":1800}}))
        } else {
            Response::json(json!({"value":null}))
        }
    });
    envelope(
        &mock.command(
            "drive",
            "scroll",
            &["--session-id", "s", "--direction", "left"],
        ),
        "drive.scroll",
        true,
    );
    let requests = mock.recorded();
    assert_eq!(
        requests.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        vec![
            "/session/s/window/rect",
            "/session/s/window/size",
            "/session/s/actions",
            "/session/s/actions"
        ]
    );
    let actions = &requests[2].body["actions"][0]["actions"];
    assert_eq!(
        actions[0],
        json!({"type":"pointerMove","duration":0,"x":960.0,"y":900.0})
    );
    assert_eq!(
        actions[3],
        json!({"type":"pointerMove","duration":300,"x":240.0,"y":900.0})
    );
    assert_eq!(requests[3].method, "DELETE");
}

#[test]
fn snapshot_and_actionable_elements_preserve_android_source_and_metadata() {
    let mock = MockAppium::new(|request| {
        Response::json(
            json!({"value":if request.path.ends_with("/source") { ANDROID } else { "cG5n" }}),
        )
    });
    let result = envelope(
        &mock.command("screen", "snapshot", &["--session-id", "s"]),
        "screen.snapshot",
        true,
    );
    assert_eq!(result["result"]["source"], ANDROID);
    assert_eq!(result["result"]["screenshot"], "cG5n");
    assert_eq!(result["result"]["platform"], "android");
    assert_eq!(result["result"]["metadata"]["elementCount"], 3);
    let result = envelope(
        &mock.command(
            "screen",
            "elements",
            &["--session-id", "s", "--only-actionable", "--limit", "1"],
        ),
        "screen.elements",
        true,
    );
    assert_eq!(result["result"]["total"], 3);
    assert_eq!(result["result"]["returned"], 1);
    let element = &result["result"]["elements"][0];
    assert_eq!(element["text"], "Continue");
    assert_eq!(element["resourceId"], "com.example:id/continue");
    assert_eq!(element["width"], 100.0);
    assert_eq!(element["height"], 50.0);
    assert!(mock.recorded().iter().all(|r| r.method == "GET"));
}

#[test]
fn ios_and_android_selectors_resolve_refs_returned_by_screen_elements() {
    for (source, platform, name, strategy, selector) in [
        (IOS, "ios", "loginBtn", "accessibility id", "loginBtn"),
        (
            ANDROID,
            "android",
            "continue",
            "id",
            "com.example:id/continue",
        ),
    ] {
        let mock = MockAppium::new(move |_| Response::json(json!({"value":source})));
        let result = envelope(
            &mock.command("screen", "elements", &["--session-id", "s"]),
            "screen.elements",
            true,
        );
        assert_eq!(result["result"]["platform"], platform);
        let elements = result["result"]["elements"].as_array().unwrap();
        let target = elements
            .iter()
            .find(|e| e["type"].as_str().unwrap().ends_with("Button"))
            .unwrap();
        assert_eq!(target["name"], name);
        let reference = target["elementRef"].as_str().unwrap();
        let ranked = envelope(
            &mock.command(
                "selectors",
                "best",
                &["--session-id", "s", "--element-ref", reference],
            ),
            "selectors.best",
            true,
        );
        assert_eq!(ranked["result"]["target"], *target);
        let all = ranked["result"]["allSelectors"].as_array().unwrap();
        let expected = all
            .iter()
            .find(|s| s["strategy"] == strategy && s["value"] == selector)
            .unwrap();
        assert!(
            expected["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("UNIQUE_MATCH"))
        );
        assert_eq!(expected["matchCount"], 1);
        assert_eq!(
            ranked["result"]["topSelectors"],
            json!(all.iter().take(5).collect::<Vec<_>>())
        );
        let missing = envelope(
            &mock.command(
                "selectors",
                "best",
                &["--session-id", "s", "--element-ref", "missing"],
            ),
            "selectors.best",
            false,
        );
        assert!(
            missing["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Element not found")
        );
    }
}

#[test]
fn malformed_and_webdriver_error_responses_are_structured_failures() {
    for (response, command, args, code) in [
        (
            Response {
                status: 200,
                body: "not-json".into(),
            },
            "delete",
            vec!["--session-id", "s"],
            "APPIUM_INVALID_RESPONSE",
        ),
        (
            Response::error(200, "invalid session id", "session expired"),
            "delete",
            vec!["--session-id", "s"],
            "invalid session id",
        ),
        (
            Response::error(404, "invalid session id", "session expired"),
            "delete",
            vec!["--session-id", "s"],
            "invalid session id",
        ),
        (
            Response::json(json!({"value":{"capabilities":{}}})),
            "create",
            vec!["--caps-json", "{}"],
            "APPIUM_SESSION_ID_MISSING",
        ),
    ] {
        let mock = MockAppium::new(move |_| Response {
            status: response.status,
            body: response.body.clone(),
        });
        let result = envelope(
            &mock.command("session", command, &args),
            &format!("session.{command}"),
            false,
        );
        assert_eq!(result["error"]["code"], code);
        if code == "invalid session id" {
            assert_eq!(result["error"]["message"], "session expired");
        }
    }
    let mock = MockAppium::new(|_| Response::json(json!({"value":42})));
    let result = envelope(
        &mock.command("screen", "elements", &["--session-id", "s"]),
        "screen.elements",
        false,
    );
    assert_eq!(result["error"]["code"], "APPIUM_INVALID_RESPONSE");
}

#[test]
fn invalid_source_and_noncanonical_screenshot_cannot_produce_a_successful_snapshot() {
    for (source, screenshot) in [("<broken>", "cG5n"), (ANDROID, "!!!"), (ANDROID, "cG5n= ")] {
        let mock = MockAppium::new(move |request| {
            Response::json(
                json!({"value":if request.path.ends_with("/source") {source} else {screenshot}}),
            )
        });
        let result = envelope(
            &mock.command("screen", "snapshot", &["--session-id", "s"]),
            "screen.snapshot",
            false,
        );
        assert!(
            [
                "APPIUM_INVALID_SOURCE",
                "APPIUM_INVALID_RESPONSE",
                "APPIUM_PARTIAL_CAPTURE"
            ]
            .contains(&result["error"]["code"].as_str().unwrap())
        );
    }
}

#[test]
fn capabilities_size_limit_and_output_errors_do_not_leak_or_send_capabilities() {
    let mock = MockAppium::new(|_| Response::json(json!({"value":null})));
    let dir = TempDir::new();
    let file = dir.0.join("oversized.json");
    fs::File::create(&file)
        .unwrap()
        .set_len(10 * 1024 * 1024 + 1)
        .unwrap();
    let result = envelope(
        &mock.command(
            "session",
            "create",
            &["--caps-file", file.to_str().unwrap()],
        ),
        "session.create",
        false,
    );
    assert!(
        result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("10 MiB")
    );
    assert!(mock.recorded().is_empty());
}

#[test]
fn web_context_html_keeps_disabled_and_hidden_controls_out_of_actionable_results() {
    const HTML: &str = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body><button id=save>Save</button><input id=email disabled><div hidden><button id=hidden>Hidden</button></div></body></html>";
    let mock = MockAppium::new(|_| Response::json(json!({"value":HTML})));
    let all = envelope(
        &mock.command("screen", "elements", &["--session-id", "web"]),
        "screen.elements",
        true,
    );
    assert_eq!(all["result"]["platform"], "unknown");
    assert_eq!(all["result"]["total"], 8);
    let all_elements = all["result"]["elements"].as_array().unwrap();
    assert_eq!(
        all_elements
            .iter()
            .find(|e| e["resourceId"] == "email")
            .unwrap()["enabled"],
        false
    );
    let actionable = envelope(
        &mock.command(
            "screen",
            "elements",
            &["--session-id", "web", "--only-actionable"],
        ),
        "screen.elements",
        true,
    );
    assert_eq!(actionable["result"]["returned"], 1);
    assert_eq!(actionable["result"]["elements"][0]["resourceId"], "save");
    assert_eq!(
        actionable["result"]["elements"][0]["xpath"],
        "/html[1]/body[1]/button[1]"
    );
}

#[test]
fn successful_gesture_with_failed_release_is_reported_as_failure() {
    let mock = MockAppium::new(|request| {
        if request.method == "DELETE" {
            Response::error(500, "unknown error", "release failed")
        } else {
            Response::json(json!({"value":null}))
        }
    });
    let result = envelope(
        &mock.command(
            "drive",
            "swipe",
            &["--session-id", "s", "--from", "0,0", "--to", "1,1"],
        ),
        "drive.swipe",
        false,
    );
    assert_eq!(result["error"]["message"], "release failed");
    assert_eq!(mock.recorded().len(), 2);
}
