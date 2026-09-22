//! The sidecar's start-up configuration (one JSON line on stdin) and the commands and events of
//! the stdin/stdout contract with the Electron main process.

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    time::Duration,
};

use anyhow::{Context, bail};
use iroh::{
    Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey,
    endpoint::presets,
    tls::CaTlsConfig,
};
use serde::{Deserialize, Serialize};

use crate::protocol::ALPN;

/// A quality tier. The declaration order is best-first, so `max` of two tiers is the lower quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Lossless,
    High,
    Saver,
}

impl Tier {
    /// The tier byte of the audio header (§3.2).
    pub fn byte(self) -> u8 {
        match self {
            Tier::Lossless => 0,
            Tier::High => 1,
            Tier::Saver => 2,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tier::Lossless => "lossless",
            Tier::High => "high",
            Tier::Saver => "saver",
        }
    }

    /// The Opus bitrate of a transcoded tier.
    pub fn opus_bitrate(self) -> Option<&'static str> {
        match self {
            Tier::Lossless => None,
            Tier::High => Some("256k"),
            Tier::Saver => Some("128k"),
        }
    }

    /// Clamp a requested tier to a device's cap: the result is never better than the cap.
    pub fn clamp_to(self, cap: Tier) -> Tier {
        self.max(cap)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_tier")]
    pub tier_cap: Tier,
    #[serde(default)]
    pub paired_at: String,
}

fn default_tier() -> Tier {
    Tier::Lossless
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RelayModeConfig {
    #[default]
    Default,
    Disabled,
    Custom,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub secret_key_hex: String,
    pub library_db: PathBuf,
    pub cache_dir: PathBuf,
    #[serde(default = "default_server_name")]
    pub server_name: String,
    #[serde(default)]
    pub allowlist: Vec<AllowEntry>,
    #[serde(default)]
    pub relay_mode: RelayModeConfig,
    #[serde(default)]
    pub relay_urls: Vec<String>,
    #[serde(default)]
    pub relay_only: bool,
    #[serde(default)]
    pub bind_port: Option<u16>,
    #[serde(default)]
    pub insecure_relay_tls: bool,
}

fn default_server_name() -> String {
    "Now Playing".to_string()
}

impl Config {
    pub fn from_json_line(line: &str) -> anyhow::Result<Self> {
        serde_json::from_str(line.trim()).context("invalid config line")
    }

    /// Apply the environment overrides. `AWSP_RELAY_ONLY=1` forces relay-only (§0). The lookup is
    /// passed in so it can be tested without touching the process environment.
    pub fn apply_env(&mut self, get: impl Fn(&str) -> Option<String>) {
        if get("AWSP_RELAY_ONLY").is_some_and(|v| v.trim() == "1") {
            self.relay_only = true;
        }
    }

    pub fn secret_key(&self) -> anyhow::Result<SecretKey> {
        let bytes = hex::decode(self.secret_key_hex.trim()).context("secret_key_hex is not hex")?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("secret_key_hex must be 32 bytes (64 hex digits)"))?;
        Ok(SecretKey::from_bytes(&bytes))
    }

    pub fn relay_mode(&self) -> anyhow::Result<RelayMode> {
        Ok(match self.relay_mode {
            RelayModeConfig::Default => RelayMode::Default,
            RelayModeConfig::Disabled => RelayMode::Disabled,
            RelayModeConfig::Custom => {
                if self.relay_urls.is_empty() {
                    bail!("relay_mode \"custom\" needs at least one relay_urls entry");
                }
                let urls = self
                    .relay_urls
                    .iter()
                    .map(|u| u.parse::<RelayUrl>().with_context(|| format!("bad relay url {u}")))
                    .collect::<anyhow::Result<Vec<_>>>()?;
                RelayMode::Custom(RelayMap::from_iter(urls))
            }
        })
    }

    /// Bind the server's iroh endpoint as configured.
    ///
    /// The n0 preset (DNS address lookup publishing to n0's servers) is used only with n0's
    /// relays; a custom or disabled relay setup is a self-contained deployment and gets the
    /// minimal preset, so nothing is published outside it.
    pub async fn bind_endpoint(&self) -> anyhow::Result<Endpoint> {
        if self.relay_only && self.relay_mode == RelayModeConfig::Disabled {
            bail!("relay_only with relay_mode \"disabled\" leaves no transport");
        }
        let mut builder = match self.relay_mode {
            RelayModeConfig::Default => Endpoint::builder(presets::N0),
            _ => Endpoint::builder(presets::Minimal),
        }
        .secret_key(self.secret_key()?)
        .alpns(vec![ALPN.to_vec()])
        .relay_mode(self.relay_mode()?);
        if self.insecure_relay_tls {
            builder = builder.ca_tls_config(insecure_relay_tls());
        }
        if self.relay_only {
            builder = builder.clear_ip_transports();
        } else if let Some(port) = self.bind_port {
            builder = builder
                .bind_addr(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))
                .map_err(|e| anyhow::anyhow!("bad bind port {port}: {e}"))?;
        }
        builder
            .bind()
            .await
            .map_err(|e| anyhow::anyhow!("binding the endpoint failed: {e}"))
    }

    /// How long to wait for the home relay before announcing `ready` anyway.
    pub fn online_timeout(&self) -> Option<Duration> {
        match self.relay_mode {
            RelayModeConfig::Disabled => None,
            _ => Some(Duration::from_secs(15)),
        }
    }
}

/// Trust any relay certificate. `CaTlsConfig::insecure_skip_verify` exists only behind iroh's
/// `test-utils` feature, so the same verifier is built here through the public
/// `custom_server_cert_verifier` hook. Opt-in (`insecure_relay_tls`), for a local development relay
/// with a self-signed certificate; the AWSP traffic itself stays end-to-end encrypted QUIC.
fn insecure_relay_tls() -> CaTlsConfig {
    CaTlsConfig::custom_server_cert_verifier(std::sync::Arc::new(|crypto_provider| {
        Ok(std::sync::Arc::new(NoCertVerifier { crypto_provider }) as std::sync::Arc<dyn rustls::client::danger::ServerCertVerifier>)
    }))
}

#[derive(Debug)]
struct NoCertVerifier {
    crypto_provider: std::sync::Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.crypto_provider.signature_verification_algorithms.supported_schemes()
    }
}

/// A command from the main process, one JSON object per stdin line.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    NewPairingCode,
    Revoke { id: String },
    SetTierCap { id: String, tier: Tier },
    Shutdown,
}

/// An event for the main process, one JSON object per stdout line.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Ready {
        endpoint_id: String,
        ticket: String,
        relay_url: Option<String>,
    },
    PairingCode {
        code: String,
        expires_at: String,
    },
    Paired {
        id: String,
        name: String,
        client_kind: String,
    },
    Connection {
        peer: String,
        #[serde(rename = "type")]
        kind: String,
        rtt_ms: u64,
    },
    Disconnected {
        peer: String,
    },
    Error {
        message: String,
    },
}

pub fn now_iso() -> String {
    iso(time::OffsetDateTime::now_utc())
}

pub fn iso(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_clamp_never_exceeds_cap() {
        assert_eq!(Tier::Lossless.clamp_to(Tier::High), Tier::High);
        assert_eq!(Tier::Saver.clamp_to(Tier::High), Tier::Saver);
        assert_eq!(Tier::High.clamp_to(Tier::Lossless), Tier::High);
    }

    #[test]
    fn config_parses_and_env_forces_relay_only() {
        let line = r#"{"secret_key_hex":"0000000000000000000000000000000000000000000000000000000000000001","library_db":"x.sqlite","cache_dir":"c","server_name":"S","allowlist":[{"id":"a","name":"n","tier_cap":"high","paired_at":"2026-01-01T00:00:00Z"}],"relay_mode":"custom","relay_urls":["https://relay.example"],"relay_only":false,"bind_port":null,"insecure_relay_tls":false}"#;
        let mut cfg = Config::from_json_line(line).unwrap();
        assert_eq!(cfg.allowlist[0].tier_cap, Tier::High);
        assert!(!cfg.relay_only);
        cfg.apply_env(|k| (k == "AWSP_RELAY_ONLY").then(|| "1".to_string()));
        assert!(cfg.relay_only);
        cfg.secret_key().unwrap();
        cfg.relay_mode().unwrap();
    }

    #[test]
    fn commands_and_events_match_the_contract() {
        let c: Command = serde_json::from_str(r#"{"cmd":"set_tier_cap","id":"x","tier":"saver"}"#).unwrap();
        assert!(matches!(c, Command::SetTierCap { tier: Tier::Saver, .. }));
        let c: Command = serde_json::from_str(r#"{"cmd":"new_pairing_code"}"#).unwrap();
        assert!(matches!(c, Command::NewPairingCode));
        let e = serde_json::to_string(&Event::Connection { peer: "p".into(), kind: "relay".into(), rtt_ms: 3 }).unwrap();
        assert_eq!(e, r#"{"event":"connection","peer":"p","type":"relay","rtt_ms":3}"#);
    }
}
