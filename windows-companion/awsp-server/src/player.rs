//! The server-authoritative playback state (§3.1): clients send intents, the server owns the
//! queue and the position and pushes `state`.

use std::time::Instant;

use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub playing: bool,
    pub track_id: Option<String>,
    pub index: Option<usize>,
    pub queue: Vec<String>,
    pub volume: f64,
    /// Bumped on every change; the `seq` of server frames.
    pub seq: u64,
    pub duration_ms: Option<u64>,
    anchor_pos_ms: u64,
    anchor: Instant,
}

impl Default for PlayerState {
    fn default() -> Self {
        PlayerState {
            playing: false,
            track_id: None,
            index: None,
            queue: Vec::new(),
            volume: 1.0,
            seq: 0,
            duration_ms: None,
            anchor_pos_ms: 0,
            anchor: Instant::now(),
        }
    }
}

impl PlayerState {
    pub fn position_ms(&self) -> u64 {
        let pos = if self.playing {
            self.anchor_pos_ms + self.anchor.elapsed().as_millis() as u64
        } else {
            self.anchor_pos_ms
        };
        self.duration_ms.map_or(pos, |d| pos.min(d))
    }

    pub fn payload(&self) -> Value {
        json!({
            "playing": self.playing,
            "track_id": self.track_id,
            "position_ms": self.position_ms(),
            "queue": self.queue,
            "volume": self.volume,
        })
    }

    fn set_position(&mut self, ms: u64) {
        self.anchor_pos_ms = self.duration_ms.map_or(ms, |d| ms.min(d));
        self.anchor = Instant::now();
    }

    /// Start `track_id` at `offset_ms`, adding it to the queue if it is not there.
    pub fn play(&mut self, track_id: &str, offset_ms: u64, duration_ms: Option<u64>) {
        let index = match self.queue.iter().position(|t| t == track_id) {
            Some(i) => i,
            None => {
                self.queue.push(track_id.to_string());
                self.queue.len() - 1
            }
        };
        self.load(index, duration_ms);
        self.set_position(offset_ms);
        self.playing = true;
    }

    /// Make queue entry `index` current, at its start, keeping the play/pause state.
    pub fn load(&mut self, index: usize, duration_ms: Option<u64>) {
        self.index = Some(index);
        self.track_id = self.queue.get(index).cloned();
        self.duration_ms = duration_ms;
        self.set_position(0);
    }

    pub fn resume(&mut self) {
        if self.track_id.is_some() && !self.playing {
            let pos = self.position_ms();
            self.playing = true;
            self.set_position(pos);
        }
    }

    pub fn pause(&mut self) {
        let pos = self.position_ms();
        self.playing = false;
        self.set_position(pos);
    }

    pub fn seek(&mut self, ms: u64) {
        self.set_position(ms);
    }

    /// Stop at the end of the queue.
    pub fn stop(&mut self) {
        self.playing = false;
        self.set_position(0);
    }

    pub fn set_queue(&mut self, ids: Vec<String>) {
        self.queue = ids;
        self.index = self.track_id.as_ref().and_then(|t| self.queue.iter().position(|q| q == t));
    }

    /// The queue index `next`/`prev` would load, if any. `prev` more than 3 s into a track
    /// restarts it (returns the current index).
    pub fn neighbour(&self, forward: bool) -> Option<usize> {
        let i = self.index?;
        if forward {
            (i + 1 < self.queue.len()).then_some(i + 1)
        } else if self.position_ms() > 3000 || i == 0 {
            Some(i)
        } else {
            Some(i - 1)
        }
    }

    /// Whether the current track has played to its end.
    pub fn at_end(&self) -> bool {
        self.playing && self.duration_ms.is_some_and(|d| self.position_ms() >= d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_navigation() {
        let mut p = PlayerState::default();
        p.set_queue(vec!["a".into(), "b".into()]);
        p.play("b", 0, Some(1000));
        assert_eq!(p.index, Some(1));
        assert_eq!(p.neighbour(true), None);
        assert_eq!(p.neighbour(false), Some(0));
        p.play("c", 500, None);
        assert_eq!(p.queue, vec!["a", "b", "c"]);
        p.pause();
        let pos = p.position_ms();
        assert!((500..600).contains(&pos));
        p.seek(10);
        assert_eq!(p.position_ms(), 10);
    }
}
