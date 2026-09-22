//! Read-only access to the companion's library index (`windows-companion/src/main/store.ts`).
//!
//! The database is opened with `SQLITE_OPEN_READ_ONLY`; the sidecar never writes to it. The
//! absolute folder path (`folders.path`) is used only to open files and never leaves this process;
//! only `relative_path` and the track JSON are sent to clients.

use std::{
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use anyhow::Context;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

pub const PAGE_SIZE: u32 = 100;
const DELTA_LIMIT: u32 = 500;

#[derive(Debug, Clone)]
pub struct TrackFile {
    pub id: String,
    pub path: PathBuf,
    pub mtime_ms: i64,
    pub track: Value,
}

impl TrackFile {
    pub fn duration_ms(&self) -> Option<u64> {
        self.track.get("durationMs").and_then(Value::as_u64)
    }
}

pub struct Library {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl Library {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Library { path: path.into(), conn: Mutex::new(None) }
    }

    /// Run `f` against the (lazily opened, read-only) connection. A failed query drops the
    /// connection so the next call reopens it — the companion may have replaced the file.
    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> anyhow::Result<T> {
        let mut guard = self.conn.lock().expect("library lock");
        if guard.is_none() {
            let conn = Connection::open_with_flags(
                &self.path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
            )
            .with_context(|| format!("opening library {}", self.path.display()))?;
            conn.busy_timeout(Duration::from_secs(5))?;
            *guard = Some(conn);
        }
        let result = f(guard.as_ref().expect("opened"));
        if result.is_err() {
            *guard = None;
        }
        Ok(result?)
    }

    /// `tracks.id` → `folders.path` + `relative_path`, skipping tombstoned tracks.
    pub fn lookup(&self, track_id: &str) -> anyhow::Result<Option<TrackFile>> {
        let row = self.with(|c| {
            c.query_row(
                "SELECT f.path, t.relative_path, t.mtime_ms, t.track FROM tracks t JOIN folders f ON f.id = t.folder_id \
                 WHERE t.id = ?1 AND t.deleted_at IS NULL",
                params![track_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)),
            )
            .optional()
        })?;
        let Some((folder, relative, mtime_ms, track)) = row else { return Ok(None) };
        let Some(path) = join_inside(Path::new(&folder), &relative) else { return Ok(None) };
        Ok(Some(TrackFile {
            id: track_id.to_string(),
            path,
            mtime_ms,
            track: serde_json::from_str(&track).unwrap_or(Value::Null),
        }))
    }

    /// One page of the library: an FTS query (as `CompanionStore.searchTracks`), optionally
    /// restricted to a relative-path prefix.
    pub fn browse(&self, path: Option<&str>, query: Option<&str>, page: u32) -> anyhow::Result<Value> {
        let offset = i64::from(page) * i64::from(PAGE_SIZE);
        let prefix = path.map(|p| format!("{}%", escape_like(p.trim_start_matches('/'))));
        let terms = query.map(str::trim).filter(|q| !q.is_empty()).map(fts_terms);
        let (items, total) = self.with(|c| {
            let (sql_from, mut args): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match &terms {
                Some(t) => (
                    "FROM tracks_fts f JOIN tracks t ON t.rowid = f.rowid WHERE tracks_fts MATCH ? AND t.deleted_at IS NULL",
                    vec![Box::new(t.clone())],
                ),
                None => ("FROM tracks t WHERE t.deleted_at IS NULL", vec![]),
            };
            let mut filter = String::new();
            if let Some(p) = &prefix {
                filter.push_str(" AND t.relative_path LIKE ? ESCAPE '\\'");
                args.push(Box::new(p.clone()));
            }
            let order = if terms.is_some() {
                "ORDER BY rank"
            } else {
                "ORDER BY json_extract(t.track, '$.artistName'), json_extract(t.track, '$.albumName'), json_extract(t.track, '$.trackNumber')"
            };
            let total: i64 = c.query_row(
                &format!("SELECT COUNT(*) {sql_from}{filter}"),
                rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())),
                |r| r.get(0),
            )?;
            let mut stmt = c.prepare(&format!("SELECT t.track {sql_from}{filter} {order} LIMIT {PAGE_SIZE} OFFSET {offset}"))?;
            let items = stmt
                .query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), |r| r.get::<_, String>(0))?
                .filter_map(Result::ok)
                .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
                .collect::<Vec<_>>();
            Ok((items, total))
        })?;
        Ok(json!({ "page": page, "page_size": PAGE_SIZE, "total": total, "items": items }))
    }

    /// The newest `updated_at`, a cheap change marker.
    pub fn max_updated_at(&self) -> anyhow::Result<Option<String>> {
        self.with(|c| c.query_row("SELECT MAX(updated_at) FROM tracks", [], |r| r.get::<_, Option<String>>(0)))
    }

    /// Tracks changed after `since`: live ones as items, tombstoned ones as removed ids.
    pub fn delta_since(&self, since: &str) -> anyhow::Result<Value> {
        let rows = self.with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT id, track, deleted_at, updated_at FROM tracks WHERE updated_at > ?1 ORDER BY updated_at LIMIT {DELTA_LIMIT}"
            ))?;
            let rows = stmt
                .query_map(params![since], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?))
                })?
                .filter_map(Result::ok)
                .collect::<Vec<_>>();
            Ok(rows)
        })?;
        let until = rows.last().map(|r| r.3.clone()).unwrap_or_else(|| since.to_string());
        let mut items = Vec::new();
        let mut removed = Vec::new();
        for (id, track, deleted, _) in rows {
            if deleted.is_some() {
                removed.push(Value::String(id));
            } else if let Ok(v) = serde_json::from_str::<Value>(&track) {
                items.push(v);
            }
        }
        Ok(json!({ "since": since, "until": until, "items": items, "removed": removed }))
    }
}

/// Join a stored relative path (forward slashes) onto its folder, refusing anything that would
/// escape the folder.
fn join_inside(folder: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative);
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    Some(folder.join(rel))
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Quoted prefix terms, as the companion builds them: a bare quote or hyphen is not a syntax error.
fn fts_terms(q: &str) -> String {
    q.split_whitespace().map(|t| format!("\"{}\"*", t.replace('"', "\"\""))).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_cannot_escape() {
        assert!(join_inside(Path::new("C:/m"), "a/b.flac").is_some());
        assert!(join_inside(Path::new("C:/m"), "../x.flac").is_none());
        assert!(join_inside(Path::new("C:/m"), "C:/x.flac").is_none());
    }
}
