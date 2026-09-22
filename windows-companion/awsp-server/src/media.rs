//! Codec detection, the Opus tier cache and artwork extraction — the parts that touch ffmpeg.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use anyhow::{Context, bail};
use serde_json::Value;
use tokio::process::Command;

use crate::{config::Tier, protocol::codec};

/// The codec byte for a lossless (untouched) file, from its extension. An `.m4a` is ALAC or AAC:
/// the indexed `format.codec` decides, and failing that the file is sniffed for an `alac` atom.
pub fn codec_for(path: &Path, track: &Value) -> u8 {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "flac" => codec::FLAC,
        "mp3" => codec::MP3,
        "opus" | "ogg" | "oga" => codec::OPUS,
        "wav" | "wave" => codec::WAV,
        "aac" => codec::AAC,
        "alac" => codec::ALAC,
        "m4a" | "mp4" | "m4b" => {
            let indexed = track.pointer("/format/codec").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            if indexed.contains("alac") {
                codec::ALAC
            } else if indexed.contains("aac") || indexed.contains("mp4a") {
                codec::AAC
            } else if sniff_alac(path) {
                codec::ALAC
            } else {
                codec::AAC
            }
        }
        _ => codec::OTHER,
    }
}

fn sniff_alac(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const WINDOW: u64 = 1 << 20;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut scan = |from: u64| -> bool {
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(from)).is_err() || (&mut f).take(WINDOW).read_to_end(&mut buf).is_err() {
            return false;
        }
        buf.windows(4).any(|w| w == b"alac")
    };
    scan(0) || (len > WINDOW && scan(len - WINDOW))
}

fn short_hash(s: &str) -> String {
    blake3::hash(s.as_bytes()).to_hex()[..32].to_string()
}

pub struct Media {
    cache_dir: PathBuf,
    ffmpeg: String,
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl Media {
    pub fn new(cache_dir: impl Into<PathBuf>, ffmpeg: Option<String>) -> Self {
        Media {
            cache_dir: cache_dir.into(),
            ffmpeg: ffmpeg.unwrap_or_else(|| std::env::var("AWSP_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())),
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn lock_for(&self, key: &Path) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().expect("media lock").entry(key.to_path_buf()).or_default().clone()
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.stdin(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }

    /// The cached Opus file for `(track_id, tier, source mtime)`, encoding it first if the cache
    /// does not hold it. Concurrent requests for the same key wait for the one encode.
    pub async fn transcoded(&self, track_id: &str, tier: Tier, source: &Path, mtime_ms: i64) -> anyhow::Result<PathBuf> {
        let Some(bitrate) = tier.opus_bitrate() else { bail!("lossless is not transcoded") };
        let dir = self.cache_dir.join("tiers");
        let stem = format!("{}-{}", short_hash(track_id), tier.name());
        let out = dir.join(format!("{stem}-{mtime_ms}.opus"));
        let lock = self.lock_for(&out);
        let _held = lock.lock().await;
        if tokio::fs::metadata(&out).await.map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(out);
        }
        tokio::fs::create_dir_all(&dir).await.context("creating the tier cache")?;
        let partial = dir.join(format!("{stem}-{mtime_ms}.opus.partial"));
        let output = self
            .command()
            .args(["-v", "error", "-y", "-i"])
            .arg(source)
            .args(["-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", bitrate, "-f", "ogg"])
            .arg(&partial)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .with_context(|| format!("running {}", self.ffmpeg))?;
        if !output.status.success() {
            let _ = tokio::fs::remove_file(&partial).await;
            bail!("ffmpeg failed: {}", String::from_utf8_lossy(&output.stderr).trim());
        }
        tokio::fs::rename(&partial, &out).await.context("publishing the encode")?;
        // Encodes of an older version of the same file are dead weight now.
        if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&format!("{stem}-")) && entry.path() != out && !name.ends_with(".partial") {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
        Ok(out)
    }

    /// The embedded cover of a track as JPEG, scaled to fit `size`², cached on disk. `None` when
    /// the file has no picture.
    pub async fn artwork(&self, track_id: &str, source: &Path, mtime_ms: i64, size: u32) -> anyhow::Result<Option<Vec<u8>>> {
        let size = size.clamp(32, 1024);
        let dir = self.cache_dir.join("art");
        let out = dir.join(format!("{}-{size}-{mtime_ms}.jpg", short_hash(track_id)));
        let none_marker = out.with_extension("none");
        let lock = self.lock_for(&out);
        let _held = lock.lock().await;
        if let Ok(bytes) = tokio::fs::read(&out).await {
            return Ok(Some(bytes));
        }
        if tokio::fs::metadata(&none_marker).await.is_ok() {
            return Ok(None);
        }
        tokio::fs::create_dir_all(&dir).await?;
        let output = self
            .command()
            .args(["-v", "error", "-i"])
            .arg(source)
            .args(["-an", "-map", "0:v:0?", "-frames:v", "1", "-vf"])
            .arg(format!("scale=w={size}:h={size}:force_original_aspect_ratio=decrease"))
            .args(["-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .with_context(|| format!("running {}", self.ffmpeg))?;
        if !output.status.success() || output.stdout.is_empty() {
            let _ = tokio::fs::write(&none_marker, b"").await;
            return Ok(None);
        }
        let _ = tokio::fs::write(&out, &output.stdout).await;
        Ok(Some(output.stdout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codec_from_extension_and_index() {
        assert_eq!(codec_for(Path::new("a.FLAC"), &Value::Null), codec::FLAC);
        assert_eq!(codec_for(Path::new("a.mp3"), &Value::Null), codec::MP3);
        assert_eq!(codec_for(Path::new("a.wav"), &Value::Null), codec::WAV);
        assert_eq!(codec_for(Path::new("a.m4a"), &json!({"format": {"codec": "ALAC"}})), codec::ALAC);
        assert_eq!(codec_for(Path::new("a.m4a"), &json!({"format": {"codec": "MPEG-4 AAC"}})), codec::AAC);
        assert_eq!(codec_for(Path::new("a.xyz"), &Value::Null), codec::OTHER);
    }
}
