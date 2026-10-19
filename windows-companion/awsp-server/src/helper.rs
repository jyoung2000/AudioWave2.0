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

/// The sections the catalog defines. A paired device may ask for any of them -- the same ones the
/// companion's own window can ask for -- and nothing else: an unknown word is dropped rather than
/// forwarded, so AWSP can never widen what the helper is asked for beyond the catalog's own list.
const CATALOG_SECTIONS: [&str; 4] = ["tracks", "artists", "albums", "playlists"];

/// `CatalogPlatform`: the only prefixes a catalog id may name (`packages/contracts/src/api/catalog.ts`).
const CATALOG_PLATFORMS: [&str; 11] = [
    "apple-music",
    "deezer",
    "musicbrainz",
    "youtube",
    "youtube-music",
    "soundcloud",
    "spotify",
    "bandcamp",
    "tidal",
    "qobuz",
    "amazon-music",
];

/// The music pages a paired device may have `resolve` read, by exact host.
///
/// A subset of the catalog's own `CATALOG_LINK_HOSTS` plus the hosts yt-dlp reads: only links a
/// keyless reader can actually answer within the paired transport's request deadline. Spotify is
/// deliberately absent -- spotDL takes 20-50 s to match one link, longer than a paired request
/// waits, so a Spotify link is left to the hub or this PC's own helper rather than timing out on
/// the device.
const CATALOG_LINK_HOSTS: [&str; 14] = [
    "music.apple.com",
    "itunes.apple.com",
    "deezer.com",
    "www.deezer.com",
    "link.deezer.com",
    "deezer.page.link",
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "soundcloud.com",
    "www.soundcloud.com",
    "m.soundcloud.com",
];

/// Hosts whose subdomains are a person's own page: `cedar.bandcamp.com`, never `bandcamp.com.evil`.
const CATALOG_LINK_SUFFIXES: [&str; 1] = ["bandcamp.com"];

/// The catalog's own ceilings (`CATALOG_MAX_LIMIT`, `CatalogSearchRequest.offset`,
/// `CatalogArtistRequest.albumsOffset`, `CATALOG_COLLECTION_CAP`). A page past one of these is
/// refused rather than clamped: a paired device learns it asked for something out of range instead
/// of silently getting a different page than the one it drew.
const CATALOG_MAX_LIMIT: u64 = 50;
const CATALOG_MAX_SEARCH_OFFSET: u64 = 1_000;
const CATALOG_MAX_ALBUMS_OFFSET: u64 = 500;
const CATALOG_COLLECTION_CAP: u64 = 10_000;
/// The window's own discography page, mirrored by the player's client so both agree on a page.
const CATALOG_ARTIST_ALBUMS_LIMIT: u64 = 25;
const CATALOG_ARTIST_TOP_LIMIT: u64 = 10;

/// `platform:id` for a platform the catalog defines. Never a path, a route, a host or a scheme.
fn safe_catalog_id(args: &Value) -> Option<&str> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| v.len() >= 3 && v.len() <= 260)?;
    let (platform, rest) = id.split_once(':')?;
    if !CATALOG_PLATFORMS.contains(&platform) {
        return None;
    }
    let ok = !rest.is_empty()
        && rest.len() <= 200
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'));
    ok.then_some(id)
}

/// A bounded whole number, or nothing when the caller named one out of the catalog's range.
fn bounded(args: &Value, key: &str, max: u64, default: u64) -> Option<u64> {
    match args.get(key) {
        None | Some(Value::Null) => Some(default),
        Some(value) => value.as_u64().filter(|n| *n <= max),
    }
}

fn bounded_limit(args: &Value, max: u64, default: u64) -> Option<u64> {
    match args.get("limit") {
        None | Some(Value::Null) => Some(default),
        Some(value) => value.as_u64().filter(|n| *n >= 1 && *n <= max),
    }
}

/// A trimmed field the catalog accepts at that length, or nothing when it is empty or too long.
fn text(args: &Value, key: &str, max: usize) -> Option<String> {
    let value = args.get(key)?.as_str()?.trim();
    (!value.is_empty() && value.len() <= max).then(|| value.to_string())
}

/// Only the arguments this operation names may be present: an extra key is a refusal, not ignored,
/// so a caller cannot smuggle `albumsLimit`, a host, a route or a token past the plan.
fn only_keys(args: &Value, allowed: &[&str]) -> bool {
    match args {
        Value::Null => true,
        Value::Object(object) => object.keys().all(|key| allowed.contains(&key.as_str())),
        _ => false,
    }
}

/// An https music page on the catalog's own host list, with no credentials and no custom port.
fn safe_catalog_link(args: &Value) -> Option<String> {
    let raw = args
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 2048)?;
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https" || url.port().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let allowed = CATALOG_LINK_HOSTS.contains(&host.as_str())
        || CATALOG_LINK_SUFFIXES
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")));
    allowed.then(|| raw.to_string())
}

/// The sections a paired device asked for, limited to the ones the catalog defines.
fn catalog_sections(args: &Value) -> String {
    let named = args.get("sections").and_then(Value::as_str).unwrap_or("");
    let mut sections: Vec<&str> = named
        .split(',')
        .map(str::trim)
        .filter(|s| CATALOG_SECTIONS.contains(s))
        .collect();
    sections.dedup();
    if sections.is_empty() {
        sections.push("tracks");
    }
    sections.join(",")
}

/// One planned helper request: its method, its fixed route and its whole query. A value, not a
/// call, so every bound and the route mapping can be asserted without a helper.
type HelperPlan = (Method, String, Vec<(String, String)>);

/// Plan one allowlisted catalog operation: its method, its fixed helper route and its whole query.
///
/// `catalog.search` was the only catalog operation a paired device could reach, pinned to the first
/// 25 rows, so a result card's rows opened nothing on the device: an album had no track list, an
/// artist no discography, a pasted link no reading. Pages, album, artist and resolve are planned
/// here as a pure value so every bound and the fixed route mapping can be asserted without a
/// helper, and so no caller-supplied route, host, port, credential or window limit can reach it.
fn catalog_request(operation: &str, args: &Value) -> Option<HelperPlan> {
    match operation {
        "catalog.search" => {
            if !only_keys(
                args,
                &["q", "track", "artist", "album", "sections", "offset", "limit"],
            ) {
                return None;
            }
            let mut fields: Vec<(&str, String)> = Vec::new();
            for key in ["q", "track", "artist", "album"] {
                let max = if key == "q" { 400 } else { 200 };
                match args.get(key) {
                    None | Some(Value::Null) => {}
                    // A field that was named but is empty or over-long is a refusal, not an
                    // omission: the device asked for something the catalog cannot take.
                    Some(_) => fields.push((key, text(args, key, max)?)),
                }
            }
            if fields.is_empty() {
                return None;
            }
            let offset = bounded(args, "offset", CATALOG_MAX_SEARCH_OFFSET, 0)?;
            let limit = bounded_limit(args, CATALOG_MAX_LIMIT, 25)?;
            let mut query: Vec<(String, String)> = fields
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect();
            query.extend([
                ("sections".to_string(), catalog_sections(args)),
                ("offset".to_string(), offset.to_string()),
                ("limit".to_string(), limit.to_string()),
                // The provider list is left to the helper's own default: naming one here once
                // pinned it to "musicsearch", which is not a CatalogProviderId at all, so the
                // helper rejected every paired search with a 400 and the PWA saw only
                // "companion-unavailable".
                ("stream".to_string(), "0".to_string()),
            ]);
            Some((Method::GET, "/helper/v1/catalog/search".into(), query))
        }
        "catalog.album" => {
            if !only_keys(args, &["id", "offset", "limit"]) {
                return None;
            }
            let id = safe_catalog_id(args)?;
            let offset = bounded(args, "offset", CATALOG_COLLECTION_CAP, 0)?;
            let limit = bounded_limit(args, CATALOG_MAX_LIMIT, CATALOG_MAX_LIMIT)?;
            Some((
                Method::GET,
                "/helper/v1/catalog/album".into(),
                vec![
                    ("id".to_string(), id.to_string()),
                    ("offset".to_string(), offset.to_string()),
                    ("limit".to_string(), limit.to_string()),
                ],
            ))
        }
        "catalog.artist" => {
            if !only_keys(args, &["id", "albumsOffset"]) {
                return None;
            }
            let id = safe_catalog_id(args)?;
            let albums_offset = bounded(args, "albumsOffset", CATALOG_MAX_ALBUMS_OFFSET, 0)?;
            Some((
                Method::GET,
                "/helper/v1/catalog/artist".into(),
                vec![
                    ("id".to_string(), id.to_string()),
                    ("albumsOffset".to_string(), albums_offset.to_string()),
                    (
                        "albumsLimit".to_string(),
                        CATALOG_ARTIST_ALBUMS_LIMIT.to_string(),
                    ),
                    ("topLimit".to_string(), CATALOG_ARTIST_TOP_LIMIT.to_string()),
                ],
            ))
        }
        "catalog.resolve" => {
            if !only_keys(args, &["url", "offset", "limit"]) {
                return None;
            }
            let url = safe_catalog_link(args)?;
            let offset = bounded(args, "offset", CATALOG_COLLECTION_CAP, 0)?;
            let limit = bounded_limit(args, CATALOG_MAX_LIMIT, CATALOG_MAX_LIMIT)?;
            Some((
                Method::GET,
                "/helper/v1/catalog/resolve".into(),
                vec![
                    ("url".to_string(), url),
                    ("offset".to_string(), offset.to_string()),
                    ("limit".to_string(), limit.to_string()),
                ],
            ))
        }
        _ => None,
    }
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
            "catalog.search" | "catalog.album" | "catalog.artist" | "catalog.resolve" => {
                let Some((planned_method, planned_path, planned_query)) =
                    catalog_request(operation, args)
                else {
                    return Err(HelperError::Forbidden);
                };
                method = planned_method;
                path = planned_path;
                query.extend(planned_query);
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

    /// A paired device asked for a song and could only ever get songs.
    ///
    /// The companion's own window asks the helper for artists and albums too, and the hub answers
    /// every section. Over AWSP the sections were hardcoded to `tracks`, so a paired player could
    /// never open an artist or an album through the companion -- the same search that works in the
    /// companion's window came back songs-only on the device, which is one of the ways the three
    /// apps disagreed about an artist's discography.
    ///
    /// The sections a caller names are passed through, limited to the ones the catalog defines so a
    /// paired device still cannot ask the helper for anything the companion's window would not.
    #[test]
    fn catalog_search_passes_through_the_sections_a_caller_asked_for() {
        let (_, _, asked) =
            catalog_request("catalog.search", &json!({ "q": "drake", "sections": "artists,albums" }))
                .expect("a valid search");
        let sections = asked
            .iter()
            .find(|(k, _)| k == "sections")
            .map(|(_, v)| v.as_str())
            .expect("sections are always sent");
        assert_eq!(sections, "artists,albums");
    }

    /// Naming nothing still means songs, which is what every existing caller relies on.
    #[test]
    fn catalog_search_defaults_to_tracks() {
        let (_, _, asked) =
            catalog_request("catalog.search", &json!({ "q": "drake" })).expect("a valid search");
        assert!(asked.contains(&("sections".to_string(), "tracks".to_string())));
    }

    /// A section the catalog does not define is dropped rather than forwarded.
    #[test]
    fn catalog_search_refuses_sections_the_catalog_does_not_define() {
        let (_, _, asked) =
            catalog_request("catalog.search", &json!({ "q": "drake", "sections": "artists,passwords" }))
                .expect("a valid search");
        let sections = asked
            .iter()
            .find(|(k, _)| k == "sections")
            .map(|(_, v)| v.as_str())
            .expect("sections are always sent");
        assert_eq!(sections, "artists");
    }

    /// A paired device could search, and then had nowhere to go.
    ///
    /// `catalog.search` was the only catalog operation on the allowlist, pinned to 25 rows with no
    /// offset, and there was no `catalog.album`, `catalog.artist` or `catalog.resolve` at all. So a
    /// paired player drew a result card whose rows opened nothing: an album had no track list, an
    /// artist no discography, a pasted link no reading. The four catalog operations are planned
    /// here, as pure (method, route, query) triples, so the fixed route mapping and every bound can
    /// be asserted without a helper.
    #[test]
    fn catalog_search_pages_within_the_contract_bounds() {
        let (method, path, query) =
            catalog_request("catalog.search", &json!({ "q": "drake", "offset": 25, "limit": 50 }))
                .expect("a valid search");
        assert_eq!(method, Method::GET);
        assert_eq!(path, "/helper/v1/catalog/search");
        assert!(query.contains(&("offset".to_string(), "25".to_string())));
        assert!(query.contains(&("limit".to_string(), "50".to_string())));
        // Naming nothing still means the first page of 25, which is what older callers rely on.
        let (_, _, defaults) =
            catalog_request("catalog.search", &json!({ "q": "drake" })).expect("a valid search");
        assert!(defaults.contains(&("offset".to_string(), "0".to_string())));
        assert!(defaults.contains(&("limit".to_string(), "25".to_string())));
        assert!(defaults.contains(&("stream".to_string(), "0".to_string())));
        assert!(!defaults.iter().any(|(k, _)| k == "providers"));
    }

    /// A limit or an offset past the catalog's own ceiling is refused, never clamped silently and
    /// never forwarded: the paired path cannot ask the helper for more than its window can.
    #[test]
    fn catalog_search_refuses_unbounded_pages() {
        assert!(catalog_request("catalog.search", &json!({ "q": "drake", "limit": 500 })).is_none());
        assert!(
            catalog_request("catalog.search", &json!({ "q": "drake", "offset": 100_000 })).is_none()
        );
        assert!(catalog_request("catalog.search", &json!({ "q": "" })).is_none());
    }

    /// The advanced fields the companion's own window can search by, bounded to the contract's 200.
    #[test]
    fn catalog_search_carries_the_advanced_fields() {
        let (_, _, query) = catalog_request(
            "catalog.search",
            &json!({ "track": "Hold On", "artist": "Drake", "album": "Take Care" }),
        )
        .expect("advanced search without q");
        assert!(query.contains(&("track".to_string(), "Hold On".to_string())));
        assert!(query.contains(&("artist".to_string(), "Drake".to_string())));
        assert!(query.contains(&("album".to_string(), "Take Care".to_string())));
        assert!(
            catalog_request("catalog.search", &json!({ "artist": "x".repeat(201) })).is_none(),
            "a field past the contract's 200 is refused"
        );
    }

    #[test]
    fn catalog_album_pages_a_track_list_by_its_catalog_id() {
        let (method, path, query) = catalog_request(
            "catalog.album",
            &json!({ "id": "deezer:6575789", "offset": 50, "limit": 50 }),
        )
        .expect("a valid album");
        assert_eq!(method, Method::GET);
        assert_eq!(path, "/helper/v1/catalog/album");
        assert!(query.contains(&("id".to_string(), "deezer:6575789".to_string())));
        assert!(query.contains(&("offset".to_string(), "50".to_string())));
        assert!(query.contains(&("limit".to_string(), "50".to_string())));
    }

    /// An id is `platform:id` for a platform the catalog defines -- not a path, a route or a host.
    #[test]
    fn catalog_ids_cannot_carry_a_route_or_a_host() {
        for bad in [
            json!({ "id": "../../helper/v1/settings" }),
            json!({ "id": "deezer:../../secrets" }),
            json!({ "id": "http://127.0.0.1:9/x" }),
            json!({ "id": "shell:6575789" }),
            json!({ "id": "deezer:" }),
            json!({ "id": format!("deezer:{}", "9".repeat(300)) }),
        ] {
            assert!(
                catalog_request("catalog.album", &bad).is_none(),
                "refused: {bad}"
            );
        }
        assert!(
            catalog_request("catalog.album", &json!({ "id": "apple-music:617154241" })).is_some()
        );
    }

    /// The discography pages; the top-track and albums-per-page counts stay the window's own.
    #[test]
    fn catalog_artist_pages_the_discography_with_fixed_window_limits() {
        let (_, path, query) = catalog_request(
            "catalog.artist",
            &json!({ "id": "deezer:246791", "albumsOffset": 25 }),
        )
        .expect("a valid artist");
        assert_eq!(path, "/helper/v1/catalog/artist");
        assert!(query.contains(&("albumsOffset".to_string(), "25".to_string())));
        assert!(query.contains(&("albumsLimit".to_string(), "25".to_string())));
        assert!(query.contains(&("topLimit".to_string(), "10".to_string())));
        assert!(
            catalog_request(
                "catalog.artist",
                &json!({ "id": "deezer:246791", "albumsOffset": 5000 })
            )
            .is_none(),
            "past the contract's 500th album it is refused"
        );
        assert!(
            catalog_request(
                "catalog.artist",
                &json!({ "id": "deezer:246791", "albumsLimit": 50 })
            )
            .is_none(),
            "a caller cannot widen the window's own limits"
        );
    }

    /// A pasted link is read only when it is on a music host the catalog already names.
    #[test]
    fn catalog_resolve_only_reads_allowlisted_music_links() {
        let (_, path, query) = catalog_request(
            "catalog.resolve",
            &json!({ "url": "https://www.deezer.com/album/6575789", "offset": 0, "limit": 50 }),
        )
        .expect("a valid link");
        assert_eq!(path, "/helper/v1/catalog/resolve");
        assert!(query.contains(&(
            "url".to_string(),
            "https://www.deezer.com/album/6575789".to_string()
        )));
        assert!(query.contains(&("limit".to_string(), "50".to_string())));
        for allowed in [
            "https://music.apple.com/us/album/take-care/1440841363",
            "https://www.youtube.com/watch?v=abcdefghijk",
            "https://youtu.be/abcdefghijk",
            "https://soundcloud.com/cedar/far-signal",
            "https://cedar.bandcamp.com/album/far-signal",
        ] {
            assert!(
                catalog_request("catalog.resolve", &json!({ "url": allowed })).is_some(),
                "allowed: {allowed}"
            );
        }
        for refused in [
            "http://www.deezer.com/album/1",
            "https://127.0.0.1/helper/v1/settings",
            "https://localhost:8080/x",
            "https://deezer.com.attacker.example/album/1",
            "https://user:pw@www.deezer.com/album/1",
            "https://www.deezer.com:9/album/1",
            "javascript:alert(1)",
            "https://bandcamp.com.evil.example/x",
            // spotDL takes 20-50 s to read a Spotify link: past the paired transport's own
            // request deadline, so it is refused here rather than timing out on the device.
            "https://open.spotify.com/album/1",
        ] {
            assert!(
                catalog_request("catalog.resolve", &json!({ "url": refused })).is_none(),
                "refused: {refused}"
            );
        }
    }

    /// Nothing outside the four catalog operations is planned here, whatever it is named.
    #[test]
    fn catalog_planning_is_closed_to_anything_else() {
        for operation in [
            "catalog.lyrics",
            "catalog.settings",
            "catalog.download",
            "helper.proxy",
            "tools.status",
        ] {
            assert!(
                catalog_request(operation, &json!({ "q": "drake", "id": "deezer:1" })).is_none(),
                "not planned: {operation}"
            );
        }
    }

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
