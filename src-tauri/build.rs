fn main() {
    // Rebuild when the React bundle changes so the window picks up Thumbnail Creator.
    println!("cargo:rerun-if-changed=../ui/dist/index.html");
    tauri_build::build()
}
