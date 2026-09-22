//! Prints the endpoint id (public key, hex) for a secret key given in hex. Used by
//! tests/netsim/run.sh to put a client on the server's allowlist before it connects.
use std::str::FromStr;

fn main() {
    let hex = std::env::args().nth(1).expect("usage: public_key <secret key hex>");
    let key = iroh::SecretKey::from_str(&hex).expect("a 64-character hex secret key");
    println!("{}", key.public());
}
