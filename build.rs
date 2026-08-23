//! Build script: keep `dist/admin/` and `dist/overlay/` in sync with the
//! `admin/` and `overlay/` source directories.
//!
//! The binary embeds `dist/` (see `src/embedded.rs`) via `include_dir!`,
//! which historically was a *committed copy* of the front-end sources.
//! Editing `admin/*.js` without re-copying silently shipped a stale UI.
//! Syncing here makes the embedded assets always match the sources.

use std::fs;
use std::path::Path;

fn sync_dir(src: &str, dst: &str) {
    let src = Path::new(src);
    let dst = Path::new(dst);
    println!("cargo:rerun-if-changed={}", src.display());

    let Ok(entries) = fs::read_dir(src) else { return };
    fs::create_dir_all(dst).ok();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let name = path.file_name().unwrap();
        let target = dst.join(name);

        // Skip the copy when the destination is already up to date, so we
        // don't rewrite unchanged files on every build.
        let same = match (fs::metadata(&path), fs::metadata(&target)) {
            (Ok(s), Ok(d)) => s.len() == d.len() && {
                let a = fs::read(&path).unwrap_or_default();
                let b = fs::read(&target).unwrap_or_default();
                a == b
            },
            _ => false,
        };
        if !same {
            fs::copy(&path, &target).ok();
        }
    }
}

fn main() {
    // `include_dir!` runs during compilation of this crate, i.e. after
    // this script, so syncing here is safe.
    sync_dir("admin", "dist/admin");
    sync_dir("overlay", "dist/overlay");
}
