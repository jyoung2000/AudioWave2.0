//! The six-digit pairing code (§2): valid ten minutes, once; five wrong codes void it.

use std::time::{Duration, Instant};

use rand::Rng;

pub const CODE_TTL: Duration = Duration::from_secs(600);
pub const MAX_FAILURES: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairOutcome {
    /// The code matched; it is now consumed.
    Accepted,
    /// A wrong code; the live code survives until `MAX_FAILURES`.
    Rejected,
    /// There is no live code (never issued, used, expired or voided).
    NoCode,
}

#[derive(Debug, Default)]
pub struct Pairing {
    code: Option<(String, Instant)>,
    failures: u32,
}

impl Pairing {
    /// Issue a fresh code, replacing any previous one. Returns the code and when it expires.
    pub fn issue(&mut self) -> (String, Duration) {
        let code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
        self.code = Some((code.clone(), Instant::now() + CODE_TTL));
        self.failures = 0;
        (code, CODE_TTL)
    }

    pub fn check(&mut self, attempt: &str) -> PairOutcome {
        let Some((code, expires)) = &self.code else { return PairOutcome::NoCode };
        if Instant::now() >= *expires {
            self.code = None;
            return PairOutcome::NoCode;
        }
        if constant_time_eq(code.as_bytes(), attempt.trim().as_bytes()) {
            self.code = None;
            self.failures = 0;
            return PairOutcome::Accepted;
        }
        self.failures += 1;
        if self.failures >= MAX_FAILURES {
            self.code = None;
        }
        PairOutcome::Rejected
    }
}

/// Compare without an early exit, so timing does not reveal how many leading digits matched.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8 | u8::from(a.len() != b.len());
    for (i, x) in a.iter().enumerate() {
        diff |= x ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_single_use() {
        let mut p = Pairing::default();
        let (code, _) = p.issue();
        assert_eq!(code.len(), 6);
        assert_eq!(p.check(&code), PairOutcome::Accepted);
        assert_eq!(p.check(&code), PairOutcome::NoCode);
    }

    #[test]
    fn five_wrong_codes_void_it() {
        let mut p = Pairing::default();
        let (code, _) = p.issue();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        for _ in 0..4 {
            assert_eq!(p.check(wrong), PairOutcome::Rejected);
        }
        assert_eq!(p.check(&code), PairOutcome::Accepted, "four failures leave the code live");
        let (code, _) = p.issue();
        for _ in 0..5 {
            assert_eq!(p.check(wrong), PairOutcome::Rejected);
        }
        assert_eq!(p.check(&code), PairOutcome::NoCode);
    }

    #[test]
    fn eq_is_exact() {
        assert!(constant_time_eq(b"123456", b"123456"));
        assert!(!constant_time_eq(b"123456", b"12345"));
        assert!(!constant_time_eq(b"123456", b"1234567"));
        assert!(!constant_time_eq(b"123456", b"123457"));
    }
}
