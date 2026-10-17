//! Restricted proxy from authenticated AWSP peers to Companion-owned helper operations.
//! The helper token stays in this process and is never returned to a Player.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::{Client, Method, redirect::Policy};
use serde_json::Value;
use tokio::sync::Mutex;

const MAX_HELPER_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_DOWNLOAD_JOBS_PER_PEER: usize = 64;
const MAX_TRACKED_DOWNLOAD_JOBS: usize = 1024;
const DOWNLOAD_JOB_ACCESS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_FILE_CHUNK_BYTES: u64 = 180 * 1024;
const MAX_DOWNLOAD_REQUEST_BYTES: usize = 16 * 1024;

#[derive(Clone)]
struct JobGrant {
    peer: String,
    created_at: Instant,
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, byte)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn valid_download_request(args: &Value) -> bool {
    let Some(encoded) = serde_json::to_vec(args).ok() else {
        return false;
    };
    if encoded.len() > MAX_DOWNLOAD_REQUEST_BYTES {
        return false;
    }
    let Some(object) = args.as_object() else {
        return false;
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "url" | "tool" | "format" | "authorization"))
    {
        return false;
    }
    let url = args.get("url").and_then(Value::as_str);
    let tool = args.get("tool").and_then(Value::as_str).unwrap_or("auto");
    let format = args
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("original");
    let authorization = args.get("authorization");
    url.is_some_and(|v| {
        !v.trim().is_empty()
            && v.len() <= 2048
            && (v.starts_with("https://") || v.starts_with("http://"))
    }) && matches!(tool, "auto" | "yt-dlp" | "spotdl")
        && matches!(format, "original" | "mp3" | "aac" | "opus" | "flac")
        && authorization.is_some_and(|a| {
            let Some(auth) = a.as_object() else {
                return false;
            };
            auth.len() == 2
                && auth.contains_key("basis")
                && auth.contains_key("acknowledged")
                && a.get("acknowledged").and_then(Value::as_bool) == Some(true)
                && matches!(
                    a.get("basis").and_then(Value::as_str),
                    Some(
                        "user-owned"
                            | "creator-download"
                            | "purchased-export"
                            | "public-domain"
                            | "licensed"
                            | "hub-hosted"
                    )
                )
        })
}

fn safe_file_id<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| is_uuid(value))
}

fn safe_job_id(args: &Value) -> Option<&str> {
    safe_file_id(args, "jobId")
}

fn safe_offset_length(args: &Value) -> Option<(u64, u64)> {
    let offset = args.get("offset").and_then(Value::as_u64)?;
    let length = args.get("length").and_then(Value::as_u64)?;
    (length > 0 && length <= MAX_FILE_CHUNK_BYTES).then_some((offset, length))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperError {
    Forbidden,
    Unavailable,
    InvalidResponse,
    TooLarge,
}

#[derive(Clone)]
pub struct HelperBridge {
    client: Client,
    port: u16,
    token: String,
    job_owners: Arc<Mutex<HashMap<String, JobGrant>>>,
}

impl HelperBridge {
    /// The bridge can only target the loopback helper. There is no caller-controlled host or path.
    pub fn new(port: u16, token: String) -> Option<Self> {
        if port == 0 || token.trim().is_empty() {
            return None;
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .build()
            .ok()?;
        Some(Self {
            client,
            port,
            token,
            job_owners: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Dispatch one explicitly allowlisted operation to a fixed helper route.
    pub async fn call(
        &self,
        peer: &str,
        operation: &str,
        args: &Value,
    ) -> Result<Value, HelperError> {
        let mut method = Method::GET;
        let path: String;
        let mut query: Vec<(String, String)> = Vec::new();
        let mut request_body: Option<Value> = None;
        match operation {
            "tv.channels" => path = "/helper/v1/tv/channels".into(),
            "tv.guide" => path = "/helper/v1/tv/guide".into(),
            "radio.nowPlaying" => {
                path = "/helper/v1/radio/now-playing".into();
                let Some(station) = args
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty() && v.len() <= 2048)
                else {
                    return Err(HelperError::Forbidden);
                };
                query.push(("url".into(), station.into()));
            }
            "catalog.search" => {
                path = "/helper/v1/catalog/search".into();
                let Some(search) = args
                    .get("q")
                    .and_then(Value::as_str)
                    .filter(|v| !v.trim().is_empty() && v.len() <= 400)
                else {
                    return Err(HelperError::Forbidden);
                };
                // MusicSearch is forced to metadata search only; callers cannot select download APIs.
                query.extend([
                    ("q".into(), search.into()),
                    ("providers".into(), "musicsearch".into()),
                    ("sections".into(), "tracks".into()),
                    ("limit".into(), "25".into()),
                    ("stream".into(), "0".into()),
                ]);
            }
            "tools.status" => path = "/helper/v1/health".into(),
            "downloads.start" => {
                if !valid_download_request(args) || !self.can_create_job(peer).await {
                    return Err(HelperError::Forbidden);
                }
                method = Method::POST;
                path = "/helper/v1/fetch".into();
                request_body = Some(args.clone());
            }
            "downloads.status" | "downloads.forget" => {
                let Some(job_id) = safe_job_id(args) else {
                    return Err(HelperError::Forbidden);
                };
                if !self.owns_job(peer, job_id).await {
                    return Err(HelperError::Forbidden);
                }
                method = if operation == "downloads.forget" {
                    Method::DELETE
                } else {
                    Method::GET
                };
                path = format!("/helper/v1/jobs/{job_id}");
            }
            "downloads.fileChunk" => {
                let (Some(job_id), Some(file_id), Some((offset, length))) = (
                    safe_job_id(args),
                    safe_file_id(args, "fileId"),
                    safe_offset_length(args),
                ) else {
                    return Err(HelperError::Forbidden);
                };
                if !self.owns_job(peer, job_id).await {
                    return Err(HelperError::Forbidden);
                }
                path = format!("/helper/v1/jobs/{job_id}/files/{file_id}/chunk");
                query.extend([
                    ("offset".into(), offset.to_string()),
                    ("length".into(), length.to_string()),
                ]);
            }
            _ => return Err(HelperError::Forbidden),
        }

        let url = format!("http://127.0.0.1:{}{path}", self.port);
        let mut request = self
            .client
            .request(method, url)
            .header("x-helper-token", &self.token);
        if !query.is_empty() {
            request = request.query(&query);
        }
        if let Some(body) = request_body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| HelperError::Unavailable)?;
        if !response.status().is_success() {
            return Err(HelperError::Unavailable);
        }
        let is_json = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            });
        if !is_json {
            return Err(HelperError::InvalidResponse);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HELPER_RESPONSE_BYTES as u64)
        {
            return Err(HelperError::TooLarge);
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| HelperError::Unavailable)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_HELPER_RESPONSE_BYTES {
                return Err(HelperError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let result: Value =
            serde_json::from_slice(&body).map_err(|_| HelperError::InvalidResponse)?;
        if operation == "downloads.start" {
            let Some(job_id) = result
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_uuid(id))
            else {
                return Err(HelperError::InvalidResponse);
            };
            self.job_owners.lock().await.insert(
                job_id.to_string(),
                JobGrant {
                    peer: peer.to_string(),
                    created_at: Instant::now(),
                },
            );
        } else if operation == "downloads.forget" {
            if let Some(job_id) = safe_job_id(args) {
                self.job_owners.lock().await.remove(job_id);
            }
        }
        Ok(result)
    }

    async fn can_create_job(&self, peer: &str) -> bool {
        let now = Instant::now();
        let mut owners = self.job_owners.lock().await;
        owners.retain(|_, grant| now.duration_since(grant.created_at) < DOWNLOAD_JOB_ACCESS_TTL);
        owners.len() < MAX_TRACKED_DOWNLOAD_JOBS
            && owners.values().filter(|grant| grant.peer == peer).count()
                < MAX_DOWNLOAD_JOBS_PER_PEER
    }

    async fn owns_job(&self, peer: &str, job_id: &str) -> bool {
        let now = Instant::now();
        let mut owners = self.job_owners.lock().await;
        owners.retain(|_, grant| now.duration_since(grant.created_at) < DOWNLOAD_JOB_ACCESS_TTL);
        owners.get(job_id).is_some_and(|grant| grant.peer == peer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn downloader_requests_require_supported_tools_and_explicit_rights() {
        let valid = json!({
            "url": "https://www.youtube.com/watch?v=example",
            "tool": "auto",
            "format": "original",
            "authorization": { "basis": "user-owned", "acknowledged": true }
        });
        assert!(valid_download_request(&valid));
        assert!(!valid_download_request(&json!({
            "url": "https://www.youtube.com/watch?v=example",
            "tool": "shell",
            "format": "original",
            "authorization": { "basis": "user-owned", "acknowledged": true }
        })));
        assert!(!valid_download_request(&json!({
            "url": "https://www.youtube.com/watch?v=example",
            "tool": "auto",
            "format": "original",
            "authorization": { "basis": "user-owned", "acknowledged": false }
        })));
        assert!(!valid_download_request(&json!({
            "url": "http://127.0.0.1/private",
            "tool": "auto",
            "format": "original",
            "authorization": { "basis": "user-owned", "acknowledged": true },
            "command": "not-accepted"
        })));
    }

    #[test]
    fn job_ids_and_file_chunks_are_strictly_bounded() {
        let job_id = "4d270178-e6a9-4a52-84f5-5c73ee08f9db";
        let file_id = "29895cb0-28ea-4d72-86dc-9065146e2911";
        assert!(is_uuid(job_id));
        assert!(!is_uuid("../../etc/passwd"));
        assert_eq!(safe_job_id(&json!({ "jobId": job_id })), Some(job_id));
        assert_eq!(
            safe_file_id(&json!({ "fileId": file_id }), "fileId"),
            Some(file_id)
        );
        assert_eq!(
            safe_offset_length(&json!({ "offset": 100, "length": 180 * 1024 })),
            Some((100, MAX_FILE_CHUNK_BYTES))
        );
        assert_eq!(
            safe_offset_length(&json!({ "offset": 0, "length": 180 * 1024 + 1 })),
            None
        );
        assert_eq!(
            safe_offset_length(&json!({ "offset": 0, "length": 0 })),
            None
        );
    }
}
