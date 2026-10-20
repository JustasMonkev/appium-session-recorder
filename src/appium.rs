use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{fmt, time::Duration};
use url::Url;

const MAX_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
pub const MIN_GESTURE_DURATION_MS: u64 = 50;

#[derive(Debug, Clone)]
pub struct AppiumError {
    pub message: String,
    pub code: String,
    pub status: u16,
    pub details: Option<Value>,
}

impl AppiumError {
    fn new(message: impl Into<String>, code: &str, status: u16) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            status,
            details: None,
        }
    }
    fn network(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::new("Appium request timed out", "APPIUM_REQUEST_TIMEOUT", 504)
        } else {
            Self::new("Unable to reach Appium", "APPIUM_REQUEST_FAILED", 502)
        }
    }
}

impl fmt::Display for AppiumError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for AppiumError {}

pub fn is_safe_appium_url(value: &str) -> bool {
    if value != value.trim() || value.contains(['?', '#']) {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

pub fn encode_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

#[derive(Clone)]
pub struct AppiumClient {
    base_url: String,
    client: Client,
}

impl AppiumClient {
    pub fn new(base_url: &str) -> Result<Self, AppiumError> {
        if !is_safe_appium_url(base_url) {
            return Err(AppiumError::new(
                "Appium URL must be HTTP(S) without credentials, query, or fragment",
                "INVALID_APPIUM_URL",
                400,
            ));
        }
        let normalized = Url::parse(base_url).expect("validated URL").to_string();
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(AppiumError::network)?;
        Ok(Self {
            base_url: normalized.trim_end_matches('/').into(),
            client,
        })
    }

    fn session_path(session_id: &str, suffix: &str) -> String {
        format!("/session/{}{suffix}", encode_segment(session_id))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppiumError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url))
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let mut response = request.send().await.map_err(AppiumError::network)?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err(AppiumError::new(
                "Appium response exceeded 20 MiB",
                "APPIUM_RESPONSE_TOO_LARGE",
                502,
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(AppiumError::network)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(AppiumError::new(
                    "Appium response exceeded 20 MiB",
                    "APPIUM_RESPONSE_TOO_LARGE",
                    502,
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let data = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                AppiumError::new(
                    "Appium returned invalid JSON",
                    "APPIUM_INVALID_RESPONSE",
                    502,
                )
            })?
        };
        let webdriver_error = nonempty_string(data.get("value").and_then(|v| v.get("error")));
        if !status.is_success() || webdriver_error.is_some() {
            let message = nonempty_string(data.get("value").and_then(|v| v.get("message")))
                .or_else(|| nonempty_string(data.get("message")))
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Appium request failed ({})", status.as_u16()));
            let mut error = AppiumError::new(
                message,
                webdriver_error.unwrap_or("APPIUM_REQUEST_FAILED"),
                if status.is_success() {
                    502
                } else {
                    status.as_u16()
                },
            );
            error.details = Some(data);
            return Err(error);
        }
        Ok(data)
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppiumError> {
        let data = self.send(method, path, body).await?;
        Ok(data.get("value").cloned().unwrap_or(data))
    }

    pub async fn create_session(&self, capabilities: Value) -> Result<Value, AppiumError> {
        if !capabilities.is_object() {
            return Err(AppiumError::new(
                "Capabilities must be a JSON object",
                "INVALID_CAPABILITIES",
                400,
            ));
        }
        let payload = if capabilities.get("capabilities").is_some() {
            capabilities
        } else {
            json!({"capabilities":{"alwaysMatch":capabilities,"firstMatch":[{}]}})
        };
        let data = self.send(Method::POST, "/session", Some(&payload)).await?;
        let session_id = nonempty_string(data.get("sessionId"))
            .or_else(|| nonempty_string(data.get("value").and_then(|v| v.get("sessionId"))));
        match session_id {
            Some(session_id) => Ok(json!({"sessionId":session_id,"value":data.get("value")})),
            None => {
                let mut error = AppiumError::new(
                    "Appium did not return a sessionId",
                    "APPIUM_SESSION_ID_MISSING",
                    502,
                );
                error.details = Some(data);
                Err(error)
            }
        }
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), AppiumError> {
        self.request(Method::DELETE, &Self::session_path(session_id, ""), None)
            .await?;
        Ok(())
    }

    pub async fn get_source(&self, session_id: &str) -> Result<String, AppiumError> {
        let data = self
            .request(
                Method::GET,
                &Self::session_path(session_id, "/source"),
                None,
            )
            .await?;
        let source = data.as_str().ok_or_else(|| {
            AppiumError::new(
                "Appium source was not a string",
                "APPIUM_INVALID_RESPONSE",
                502,
            )
        })?;
        if !crate::core::is_source_within_limits(source) {
            return Err(AppiumError::new(
                "Appium source was not valid bounded HTML/XML",
                "APPIUM_INVALID_SOURCE",
                502,
            ));
        }
        Ok(source.into())
    }

    pub async fn get_screenshot(&self, session_id: &str) -> Result<String, AppiumError> {
        let data = self
            .request(
                Method::GET,
                &Self::session_path(session_id, "/screenshot"),
                None,
            )
            .await?;
        let screenshot = data.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
            AppiumError::new(
                "Appium screenshot was not valid base64",
                "APPIUM_INVALID_RESPONSE",
                502,
            )
        })?;
        let decoded = STANDARD.decode(screenshot).map_err(|_| {
            AppiumError::new(
                "Appium screenshot was not valid base64",
                "APPIUM_INVALID_RESPONSE",
                502,
            )
        })?;
        if decoded.is_empty() || STANDARD.encode(&decoded) != screenshot {
            return Err(AppiumError::new(
                "Appium screenshot was not valid base64",
                "APPIUM_INVALID_RESPONSE",
                502,
            ));
        }
        Ok(screenshot.into())
    }

    pub async fn source(&self, session_id: &str) -> Result<String, AppiumError> {
        self.get_source(session_id).await
    }
    pub async fn screenshot(&self, session_id: &str) -> Result<String, AppiumError> {
        self.get_screenshot(session_id).await
    }

    pub async fn capture_state(&self, session_id: &str) -> Result<Value, AppiumError> {
        let source = self.get_source(session_id);
        let screenshot = self.get_screenshot(session_id);
        tokio::pin!(source, screenshot);
        // A completed sibling is retained; dropping an unfinished future cancels its HTTP request.
        tokio::select! {
            result = &mut source => match result {
                Ok(source) => match screenshot.await {
                    Ok(screenshot) => Ok(json!({"source":source,"screenshot":screenshot})),
                    Err(_) => Ok(json!({"source":source})),
                },
                Err(error) => match tokio::time::timeout(Duration::ZERO, &mut screenshot).await {
                    Ok(Ok(screenshot)) => Ok(json!({"screenshot":screenshot})),
                    _ => Err(error),
                },
            },
            result = &mut screenshot => match result {
                Ok(screenshot) => match source.await {
                    Ok(source) => Ok(json!({"source":source,"screenshot":screenshot})),
                    Err(_) => Ok(json!({"screenshot":screenshot})),
                },
                Err(error) => match tokio::time::timeout(Duration::ZERO, &mut source).await {
                    Ok(Ok(source)) => Ok(json!({"source":source})),
                    _ => Err(error),
                },
            },
        }
    }

    pub async fn find_element(
        &self,
        session_id: &str,
        using: &str,
        value: &str,
    ) -> Result<String, AppiumError> {
        let result = self
            .request(
                Method::POST,
                &Self::session_path(session_id, "/element"),
                Some(&json!({"using":using,"value":value})),
            )
            .await?;
        nonempty_string(result.get("element-6066-11e4-a52e-4f735466cecf"))
            .or_else(|| nonempty_string(result.get("ELEMENT")))
            .map(str::to_owned)
            .ok_or_else(|| AppiumError::new("Element not found", "ELEMENT_NOT_FOUND", 404))
    }

    async fn element_command(
        &self,
        session_id: &str,
        element_id: &str,
        command: &str,
        body: Value,
    ) -> Result<(), AppiumError> {
        self.request(
            Method::POST,
            &Self::session_path(
                session_id,
                &format!("/element/{}/{command}", encode_segment(element_id)),
            ),
            Some(&body),
        )
        .await?;
        Ok(())
    }
    pub async fn tap_element(&self, session_id: &str, element_id: &str) -> Result<(), AppiumError> {
        self.element_command(session_id, element_id, "click", json!({}))
            .await
    }
    pub async fn click(&self, session_id: &str, element_id: &str) -> Result<(), AppiumError> {
        self.tap_element(session_id, element_id).await
    }
    pub async fn tap(&self, session_id: &str, using: &str, value: &str) -> Result<(), AppiumError> {
        self.tap_element(
            session_id,
            &self.find_element(session_id, using, value).await?,
        )
        .await
    }
    pub async fn clear_element(
        &self,
        session_id: &str,
        element_id: &str,
    ) -> Result<(), AppiumError> {
        self.element_command(session_id, element_id, "clear", json!({}))
            .await
    }
    pub async fn clear(
        &self,
        session_id: &str,
        using: &str,
        value: &str,
    ) -> Result<(), AppiumError> {
        self.clear_element(
            session_id,
            &self.find_element(session_id, using, value).await?,
        )
        .await
    }
    pub async fn type_element(
        &self,
        session_id: &str,
        element_id: &str,
        text: &str,
    ) -> Result<(), AppiumError> {
        let characters: Vec<String> = text.chars().map(|c| c.to_string()).collect();
        self.element_command(
            session_id,
            element_id,
            "value",
            json!({"text":text,"value":characters}),
        )
        .await
    }
    pub async fn type_text(
        &self,
        session_id: &str,
        using: &str,
        value: &str,
        text: &str,
        clear_first: bool,
    ) -> Result<(), AppiumError> {
        let element_id = self.find_element(session_id, using, value).await?;
        if clear_first {
            self.clear_element(session_id, &element_id).await?;
        }
        self.type_element(session_id, &element_id, text).await
    }
    pub async fn back(&self, session_id: &str) -> Result<(), AppiumError> {
        self.request(
            Method::POST,
            &Self::session_path(session_id, "/back"),
            Some(&json!({})),
        )
        .await?;
        Ok(())
    }

    pub async fn swipe(
        &self,
        session_id: &str,
        from: &Value,
        to: &Value,
        duration_ms: u64,
    ) -> Result<(), AppiumError> {
        if duration_ms < MIN_GESTURE_DURATION_MS {
            return Err(AppiumError::new(
                "Gesture duration must be an integer of at least 50 ms",
                "INVALID_GESTURE_DURATION",
                400,
            ));
        }
        for point in [from, to] {
            if !point.get("x").is_some_and(Value::is_number)
                || !point.get("y").is_some_and(Value::is_number)
            {
                return Err(AppiumError::new(
                    "Gesture points require finite x and y coordinates",
                    "INVALID_GESTURE_COORDINATES",
                    400,
                ));
            }
        }
        let path = Self::session_path(session_id, "/actions");
        let result = self
            .request(
                Method::POST,
                &path,
                Some(&json!({"actions":[{
                    "type":"pointer","id":"finger1","parameters":{"pointerType":"touch"},"actions":[
                        {"type":"pointerMove","duration":0,"x":from["x"],"y":from["y"]},
                        {"type":"pointerDown","button":0},{"type":"pause","duration":50},
                        {"type":"pointerMove","duration":duration_ms,"x":to["x"],"y":to["y"]},
                        {"type":"pointerUp","button":0}
                    ]
                }]})),
            )
            .await;
        let cleanup = self.request(Method::DELETE, &path, None).await;
        result?;
        cleanup?;
        Ok(())
    }

    async fn window_size(&self, session_id: &str) -> Result<(f64, f64), AppiumError> {
        for endpoint in ["/window/rect", "/window/size"] {
            match self
                .request(Method::GET, &Self::session_path(session_id, endpoint), None)
                .await
            {
                Ok(value) => {
                    let number = |key: &str| {
                        value[key]
                            .as_f64()
                            .or_else(|| value[key].as_str()?.parse().ok())
                    };
                    if let (Some(width), Some(height)) = (number("width"), number("height")) {
                        if width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0 {
                            return Ok((width, height));
                        }
                    }
                }
                Err(error) if error.code.eq_ignore_ascii_case("unknown command") => {}
                Err(error) => return Err(error),
            }
        }
        Err(AppiumError::new(
            "Unable to determine window size for scroll gesture",
            "WINDOW_SIZE_UNAVAILABLE",
            500,
        ))
    }

    pub async fn scroll(
        &self,
        session_id: &str,
        direction: &str,
        duration_ms: u64,
    ) -> Result<(), AppiumError> {
        if !matches!(direction, "up" | "down" | "left" | "right") {
            return Err(AppiumError::new(
                "Scroll direction must be up, down, left, or right",
                "INVALID_SCROLL_DIRECTION",
                400,
            ));
        }
        let (width, height) = self.window_size(session_id).await?;
        let cx = (width * 0.5).round();
        let cy = (height * 0.5).round();
        let sx = (width * 0.8).round();
        let ex = (width * 0.2).round();
        let sy = (height * 0.8).round();
        let ey = (height * 0.2).round();
        let (from, to) = match direction {
            "down" => (json!({"x":cx,"y":sy}), json!({"x":cx,"y":ey})),
            "up" => (json!({"x":cx,"y":ey}), json!({"x":cx,"y":sy})),
            "left" => (json!({"x":sx,"y":cy}), json!({"x":ex,"y":cy})),
            _ => (json!({"x":ex,"y":cy}), json!({"x":sx,"y":cy})),
        };
        self.swipe(session_id, &from, &to, duration_ms).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn decodes_compressed_appium_responses_before_parsing_json() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client =
            AppiumClient::new(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let body = STANDARD
                .decode("H4sIAAAAAAACA6tWKkvMKU1VslKyychMLUosSs6o1LdTqgUAM6g3gRgAAAA=")
                .unwrap();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
        });
        assert_eq!(client.get_source("s").await.unwrap(), "<hierarchy/>");
        server.await.unwrap();
    }
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn mock(
        responses: Vec<(u16, Value)>,
    ) -> (AppiumClient, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, value) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                let body = value.to_string();
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (
            AppiumClient::new(&format!("http://{address}/wd/hub")).unwrap(),
            task,
        )
    }

    #[test]
    fn rejects_unsafe_urls_and_encodes_path_segments() {
        for value in [
            "not a URL",
            "file:///tmp/appium.sock",
            "http://user:password@localhost:4723",
            "http://localhost:4723?",
            "http://localhost:4723#",
            " http://localhost:4723",
        ] {
            assert!(!is_safe_appium_url(value), "{value}");
        }
        assert!(is_safe_appium_url("http://[::1]:4723/wd/hub"));
        assert_eq!(encode_segment("session /?"), "session%20%2F%3F");
    }

    #[tokio::test]
    async fn wraps_capabilities_and_preserves_server_envelope() {
        let (client, requests) = mock(vec![(
            200,
            json!({"value":{"sessionId":"created","capabilities":{}}}),
        )])
        .await;
        let result = client
            .create_session(json!({"platformName":"iOS"}))
            .await
            .unwrap();
        assert_eq!(result["sessionId"], "created");
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("POST /wd/hub/session HTTP/1.1"));
        let body: Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body,
            json!({"capabilities":{"alwaysMatch":{"platformName":"iOS"},"firstMatch":[{}]}})
        );
        assert_eq!(
            client.create_session(json!([])).await.unwrap_err().code,
            "INVALID_CAPABILITIES"
        );
    }

    #[tokio::test]
    async fn encoded_session_and_element_ids_stay_in_their_path_segments() {
        let (client, requests) = mock(vec![
            (200, json!({"value":"<screen />"})),
            (200, json!({"value":null})),
        ])
        .await;
        assert_eq!(client.get_source("session /?").await.unwrap(), "<screen />");
        client
            .tap_element("session /?", "element /?#")
            .await
            .unwrap();
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("GET /wd/hub/session/session%20%2F%3F/source HTTP/1.1"));
        assert!(requests[1].starts_with(
            "POST /wd/hub/session/session%20%2F%3F/element/element%20%2F%3F%23/click HTTP/1.1"
        ));
    }

    #[tokio::test]
    async fn validates_sources_and_canonical_screenshot_encoding() {
        let (client, requests) = mock(vec![
            (200, json!({"value":"<a></b>"})),
            (200, json!({"value":"AB=="})),
            (200, json!({"value":"cG5n"})),
        ])
        .await;
        assert_eq!(
            client.get_source("s").await.unwrap_err().code,
            "APPIUM_INVALID_SOURCE"
        );
        assert_eq!(
            client.get_screenshot("s").await.unwrap_err().code,
            "APPIUM_INVALID_RESPONSE"
        );
        assert_eq!(client.get_screenshot("s").await.unwrap(), "cG5n");
        requests.await.unwrap();
    }

    #[tokio::test]
    async fn preserves_webdriver_errors_even_with_successful_http_status() {
        let details = json!({"value":{"error":"invalid selector","message":"Bad XPath"}});
        let (client, requests) = mock(vec![(200, details.clone())]).await;
        let error = client.find_element("s", "xpath", "//[").await.unwrap_err();
        assert_eq!(error.code, "invalid selector");
        assert_eq!(error.message, "Bad XPath");
        assert_eq!(error.details, Some(details));
        requests.await.unwrap();
    }

    #[tokio::test]
    async fn failed_swipes_release_actions_and_preserve_the_primary_error() {
        let (client, requests) = mock(vec![
            (
                500,
                json!({"value":{"error":"action failed","message":"primary"}}),
            ),
            (
                500,
                json!({"value":{"error":"cleanup failed","message":"secondary"}}),
            ),
        ])
        .await;
        let error = client
            .swipe("s", &json!({"x":1,"y":2}), &json!({"x":3,"y":4}), 100)
            .await
            .unwrap_err();
        assert_eq!(error.code, "action failed");
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("POST /wd/hub/session/s/actions "));
        assert!(requests[1].starts_with("DELETE /wd/hub/session/s/actions "));
        let body: Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(
            body["actions"][0]["actions"][2],
            json!({"type":"pause","duration":50})
        );
    }

    #[tokio::test]
    async fn scroll_falls_back_only_for_unsupported_window_endpoints() {
        let (client, requests) = mock(vec![
            (404, json!({"value":{"error":"unknown command"}})),
            (200, json!({"value":{"width":100,"height":200}})),
            (200, json!({"value":null})),
            (200, json!({"value":null})),
        ])
        .await;
        client.scroll("s", "down", 300).await.unwrap();
        let requests = requests.await.unwrap();
        assert_eq!(requests.len(), 4);
        let body: Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["actions"][0]["actions"][0]["y"], 160.0);
        assert_eq!(body["actions"][0]["actions"][3]["y"], 40.0);

        let (client, requests) = mock(vec![(
            404,
            json!({"value":{"error":"invalid session id","message":"expired"}}),
        )])
        .await;
        assert_eq!(
            client.scroll("s", "down", 300).await.unwrap_err().code,
            "invalid session id"
        );
        assert_eq!(requests.await.unwrap().len(), 1);
    }
}
