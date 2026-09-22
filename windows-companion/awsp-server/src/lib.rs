//! AWSP server sidecar for the Now Playing Windows companion (docs/AWSP.md).
//!
//! The binary (`src/main.rs`) speaks a line-oriented JSON contract with the Electron main
//! process; this library holds everything testable behind it.

pub mod config;
pub mod library;
pub mod media;
pub mod pairing;
pub mod player;
pub mod protocol;
pub mod server;

pub use config::{AllowEntry, Command, Config, Event, Tier};
pub use server::{Server, ServerOptions};
