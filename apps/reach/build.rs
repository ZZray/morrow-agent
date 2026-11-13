// Copyright (c) Ray Zhang.
#[path = "packaging/windows/resources.rs"]
mod resources;
fn main() {
    resources::embed(std::path::Path::new(env!("CARGO_MANIFEST_DIR")), "Reach Node", "reach.exe");
}
