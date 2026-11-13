// Copyright (c) Ray Zhang.
#[path = "../resources.rs"]
mod resources;
fn main() {
    resources::embed(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."),
        "Reach Setup",
        "Reach-Setup.exe",
    );
    let path = std::path::PathBuf::from(
        std::env::var_os("REACH_SETUP_NODE").expect("set REACH_SETUP_NODE to the reviewed ordinary node binary"),
    );
    let path = path.canonicalize().expect("node payload missing");
    let hash = std::env::var("REACH_SETUP_SHA").expect("set REACH_SETUP_SHA to the reviewed binary SHA256");
    assert!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()));
    println!("cargo:rustc-env=REACH_SETUP_NODE={}", path.display());
    println!("cargo:rustc-env=REACH_SETUP_SHA={}", hash.to_lowercase());
    println!("cargo:rerun-if-env-changed=REACH_SETUP_NODE");
    println!("cargo:rerun-if-env-changed=REACH_SETUP_SHA");
    println!("cargo:rerun-if-changed={}", path.display());
    let kind = std::env::var("REACH_SETUP_KIND").unwrap_or_else(|_| "node".into());
    assert!(kind == "node" || kind == "complete", "unsupported payload kind");
    println!("cargo:rustc-env=REACH_SETUP_KIND={kind}");
    println!("cargo:rerun-if-env-changed=REACH_SETUP_KIND");
    for name in ["REACH_SETUP_MANIFEST_SHA", "REACH_SETUP_COMPONENT_NODE_SHA", "REACH_SETUP_AGENT_SHA"] {
        let value = if kind == "complete" {
            let value = std::env::var(name).expect("complete package identity missing");
            assert!(value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()));
            value.to_lowercase()
        } else if name == "REACH_SETUP_COMPONENT_NODE_SHA" {
            hash.to_lowercase()
        } else {
            String::new()
        };
        println!("cargo:rustc-env={name}={value}");
        println!("cargo:rerun-if-env-changed={name}");
    }
    println!("cargo:rerun-if-changed=../install.ps1");
    println!("cargo:rerun-if-changed=../payload.ps1");
    println!("cargo:rerun-if-changed=../ownership.ps1");
    println!("cargo:rerun-if-changed=../maintenance-writes.ps1");
    for module in ["maintenance-entry", "uninstall-files", "uninstall-transaction", "uninstall-host"] {
        println!("cargo:rerun-if-changed=../{module}.ps1");
    }
    let notices = std::path::PathBuf::from(
        std::env::var_os("REACH_SETUP_NOTICES").expect("set REACH_SETUP_NOTICES to the generated third-party notices"),
    );
    let notices = notices.canonicalize().expect("third-party notices missing");
    println!("cargo:rustc-env=REACH_SETUP_NOTICES={}", notices.display());
    println!("cargo:rerun-if-env-changed=REACH_SETUP_NOTICES");
    println!("cargo:rerun-if-changed={}", notices.display());
}
