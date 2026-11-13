// Copyright (c) Ray Zhang. Shared executable branding; no execution-level change.
pub fn embed(project: &std::path::Path, description: &str, filename: &str) {
    println!("cargo:rerun-if-changed={}", project.join("assets/brand/reach.ico").display());
    println!("cargo:rerun-if-changed={}", project.join("packaging/windows/resources.rs").display());
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icon =
        project.join("assets/brand/reach.ico").canonicalize().expect("Reach icon is missing; run bun run build:icons");
    winresource::WindowsResource::new()
        .set_icon(icon.to_str().expect("icon path is not Unicode"))
        .set("ProductName", "Reach")
        .set("FileDescription", description)
        .set("OriginalFilename", filename)
        .set("CompanyName", "Ray Zhang")
        .set("LegalCopyright", "Copyright (c) Ray Zhang")
        .compile()
        .expect("cannot embed Reach Windows resources");
}
