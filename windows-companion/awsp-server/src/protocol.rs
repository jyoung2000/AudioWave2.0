//! Wire format of AWSP v1 (docs/AWSP.md §3): length-prefixed JSON frames, the audio request and
//! the 16-byte audio header, and the error codes.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};

use crate::config::Tier;

pub const ALPN: &[u8] = b"awsp/1";
pub const PROTOCOL_VERSION: u64 = 1;

/// Largest control or request frame (§3.1).
pub const MAX_FRAME: usize = 256 * 1024;
/// Read and write unit of an audio stream (§3.2).
pub const CHUNK: usize = 64 * 1024;

/// Application error codes. Connection close codes, then stream reset codes.
pub mod codes {
    /// Connection closed normally (shutdown, client went away).
    pub const NORMAL: u32 = 0x0;
    /// Connection: the peer is not on the allowlist (or was revoked, or failed pairing).
    pub const UNKNOWN_DEVICE: u32 = 0x1;
    /// Connection: protocol violation (wrong `protocol_version`).
    pub const PROTOCOL: u32 = 0x2;
    /// Audio stream reset: no such track.
    pub const NOT_FOUND: u32 = 0x10;
    /// Audio stream reset: the range is outside the file.
    pub const RANGE: u32 = 0x11;
    /// Audio stream reset: unknown tier or the tier could not be produced.
    pub const TIER: u32 = 0x12;
    /// Audio stream reset: the request frame is missing or malformed.
    pub const BAD_REQUEST: u32 = 0x13;
    /// Control stream reset/stop: a frame over 256 KiB.
    pub const FRAME_TOO_LARGE: u32 = 0x20;
}

/// A control-stream frame: `{id, type, seq, payload}` (+ `re`, the id of the client frame a reply
/// answers, on replies only).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frame {
    #[serde(default)]
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub re: Option<u64>,
}

impl Frame {
    pub fn new(kind: &str, payload: Value) -> Self {
        Frame { id: 0, kind: kind.to_string(), seq: 0, payload, re: None }
    }

    pub fn reply(kind: &str, payload: Value, re: u64) -> Self {
        Frame { re: Some(re), ..Frame::new(kind, payload) }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame too large ({0} bytes)")]
    TooLarge(usize),
    #[error("stream ended inside a frame")]
    Truncated,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("frame is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

/// Read one frame's JSON bytes. `Ok(None)` is a clean end of stream at a frame boundary.
pub async fn read_frame_bytes<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = r.read(&mut len[got..]).await?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(FrameError::Truncated) };
        }
        got += n;
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof { FrameError::Truncated } else { FrameError::Io(e) }
    })?;
    Ok(Some(buf))
}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Frame>, FrameError> {
    match read_frame_bytes(r).await? {
        Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        None => Ok(None),
    }
}

pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, value: &T) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    w.write_all(&out).await?;
    Ok(())
}

/// The request frame of an audio stream (§3.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioRequest {
    pub track_id: String,
    #[serde(default)]
    pub byte_start: u64,
    #[serde(default)]
    pub byte_end: Option<u64>,
    /// Absent means `lossless`. An unknown string is a `tier` error, so it is kept raw here.
    #[serde(default)]
    pub tier: Option<String>,
}

impl AudioRequest {
    pub fn tier(&self) -> Option<Tier> {
        match self.tier.as_deref() {
            None | Some("lossless") => Some(Tier::Lossless),
            Some("high") => Some(Tier::High),
            Some("saver") => Some(Tier::Saver),
            Some(_) => None,
        }
    }
}

/// Codec bytes of the audio header.
pub mod codec {
    pub const OTHER: u8 = 0;
    pub const FLAC: u8 = 1;
    pub const ALAC: u8 = 2;
    pub const MP3: u8 = 3;
    pub const OPUS: u8 = 4;
    pub const WAV: u8 = 5;
    pub const AAC: u8 = 6;
}

/// First 8 bytes of BLAKE3(track_id).
pub fn track_id_hash(track_id: &str) -> [u8; 8] {
    let h = blake3::hash(track_id.as_bytes());
    h.as_bytes()[..8].try_into().expect("8 bytes")
}

/// The 16-byte audio header.
pub fn audio_header(track_id: &str, total_len: u64, codec: u8, tier: Tier) -> [u8; 16] {
    let mut h = [0u8; 16];
    h[..8].copy_from_slice(&track_id_hash(track_id));
    h[8..14].copy_from_slice(&total_len.to_be_bytes()[2..8]);
    h[14] = codec;
    h[15] = tier.byte();
    h
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioHeader {
    pub track_id_hash: [u8; 8],
    pub total_len: u64,
    pub codec: u8,
    pub tier: u8,
}

pub fn parse_audio_header(h: &[u8; 16]) -> AudioHeader {
    let mut len = [0u8; 8];
    len[2..8].copy_from_slice(&h[8..14]);
    AudioHeader {
        track_id_hash: h[..8].try_into().expect("8 bytes"),
        total_len: u64::from_be_bytes(len),
        codec: h[14],
        tier: h[15],
    }
}

/// Resolve an HTTP-Range style request against a file length: `byte_end` inclusive, `None` to the
/// end, an end past the file clamped to it. Returns the inclusive `(start, end)`.
pub fn resolve_range(total_len: u64, start: u64, end: Option<u64>) -> Option<(u64, u64)> {
    if total_len == 0 || start >= total_len {
        return None;
    }
    let end = end.unwrap_or(total_len - 1).min(total_len - 1);
    if end < start {
        return None;
    }
    Some((start, end))
}

/// Write the inclusive byte range `[start, end]` of `file` to `w` in 64 KiB chunks, awaiting each
/// write (so QUIC flow control paces the read — never the whole file in memory). Returns the
/// number of bytes written.
pub async fn copy_range<W: AsyncWrite + Unpin>(w: &mut W, file: &Path, start: u64, end: u64) -> std::io::Result<u64> {
    let mut f = tokio::fs::File::open(file).await?;
    f.seek(std::io::SeekFrom::Start(start)).await?;
    let mut remaining = end - start + 1;
    let mut buf = vec![0u8; CHUNK];
    let mut written = 0;
    while remaining > 0 {
        let want = remaining.min(CHUNK as u64) as usize;
        let n = f.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "file shrank while streaming"));
        }
        w.write_all(&buf[..n]).await?;
        remaining -= n as u64;
        written += n as u64;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let h = audio_header("t1", 0x0102_0304_0506, codec::FLAC, Tier::High);
        let p = parse_audio_header(&h);
        assert_eq!(p.total_len, 0x0102_0304_0506);
        assert_eq!(p.codec, 1);
        assert_eq!(p.tier, 1);
        assert_eq!(p.track_id_hash, track_id_hash("t1"));
    }

    #[test]
    fn ranges() {
        assert_eq!(resolve_range(10, 0, None), Some((0, 9)));
        assert_eq!(resolve_range(10, 9, Some(9)), Some((9, 9)));
        assert_eq!(resolve_range(10, 3, Some(100)), Some((3, 9)));
        assert_eq!(resolve_range(10, 10, None), None);
        assert_eq!(resolve_range(10, 5, Some(4)), None);
        assert_eq!(resolve_range(0, 0, None), None);
    }

    #[tokio::test]
    async fn frames_round_trip_and_reject_oversize() {
        let (mut a, mut b) = tokio::io::duplex(1 << 20);
        write_json(&mut a, &Frame::new("ping", serde_json::json!({}))).await.unwrap();
        a.write_all(&((MAX_FRAME as u32) + 1).to_be_bytes()).await.unwrap();
        drop(a);
        assert_eq!(read_frame(&mut b).await.unwrap().unwrap().kind, "ping");
        assert!(matches!(read_frame(&mut b).await, Err(FrameError::TooLarge(_))));
    }
}
