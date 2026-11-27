// Copyright (c) Ray Zhang.
#[path = "packaging/windows/resources.rs"]
mod resources;
fn main() {
    resources::embed(std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "Reach Node", "reach.exe");
    let version = std::env::var("REACH_RELEASE_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").into());
    let parts: Vec<_> = version.split('.').collect();
    assert!(
        parts.len() == 3 && parts.iter().all(|part| part.parse::<u16>().is_ok_and(|n| n.to_string() == *part)),
        "REACH_RELEASE_VERSION must be a canonical major.minor.patch version"
    );
    println!("cargo:rerun-if-env-changed=REACH_RELEASE_VERSION");
    println!("cargo:rustc-env=REACH_COMPILED_VERSION={version}");
    println!("cargo:rerun-if-env-changed=REACH_UPDATE_PUBLIC_KEY_HEX");
    if let Ok(key) = std::env::var("REACH_UPDATE_PUBLIC_KEY_HEX") {
        assert!(key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()), "invalid Reach Ed25519 public key");
    }
}
