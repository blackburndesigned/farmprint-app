//! Branding logo: the only local file the webview can ask the backend to read for display.
//!
//! The picker offers image files only, and the reader enforces the same rule on its own,
//! because the stored `logo_path` comes from settings the webview can change. A path is
//! accepted only when it is a regular file with an allowed image extension, is at most
//! [`MAX_LOGO_BYTES`], and its first bytes really are a PNG, JPEG, WebP or GIF. SVG is not
//! accepted (it can carry scripts and external references).

use std::io::Read;
use std::path::Path;

/// Extensions offered by the logo picker and accepted by the reader (lower case).
pub const LOGO_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// Largest logo file the reader accepts.
pub const MAX_LOGO_BYTES: u64 = 10 * 1024 * 1024;

const KINDS: &str = "PNG, JPEG, WebP or GIF";

/// MIME type from the file's leading bytes, or `None` when they are not a supported image.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn has_logo_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| LOGO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Reads and checks a logo file. Returns its bytes and MIME type, or a message that can be
/// shown to the user as is.
pub fn read_logo(path: &Path) -> Result<(Vec<u8>, &'static str), String> {
    if !has_logo_extension(path) {
        return Err(format!("The logo must be a {KINDS} image."));
    }
    let meta =
        std::fs::metadata(path).map_err(|_| "The logo file could not be found.".to_string())?;
    if !meta.is_file() {
        return Err(format!("The logo must be a {KINDS} image file."));
    }
    if meta.len() > MAX_LOGO_BYTES {
        return Err("The logo image is larger than 10 MB. Choose a smaller file.".into());
    }
    let file =
        std::fs::File::open(path).map_err(|e| format!("The logo file could not be opened: {e}"))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // Bounded read, in case the file grows between the size check and the read.
    file.take(MAX_LOGO_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("The logo file could not be read: {e}"))?;
    if bytes.len() as u64 > MAX_LOGO_BYTES {
        return Err("The logo image is larger than 10 MB. Choose a smaller file.".into());
    }
    let mime = sniff_image_mime(&bytes)
        .ok_or_else(|| format!("This file is not a valid {KINDS} image."))?;
    Ok((bytes, mime))
}

/// The logo as a `data:` URL for the webview.
pub fn read_logo_data_url(path: &Path, encode_b64: fn(&[u8]) -> String) -> Result<String, String> {
    let (bytes, mime) = read_logo(path)?;
    Ok(format!("data:{mime};base64,{}", encode_b64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

    fn tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fp-logo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn b64(b: &[u8]) -> String {
        format!("{}bytes", b.len())
    }

    #[test]
    fn sniffs_supported_formats() {
        assert_eq!(sniff_image_mime(PNG), Some("image/png"));
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\x10\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"RIFF\x10\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image_mime(b"<svg xmlns="), None);
        assert_eq!(sniff_image_mime(b""), None);
    }

    #[test]
    fn accepts_a_real_png_with_any_case_extension() {
        let p = tmp("Logo.PNG", PNG);
        let url = read_logo_data_url(&p, b64).unwrap();
        assert_eq!(url, "data:image/png;base64,12bytes");
    }

    #[test]
    fn rejects_wrong_extension_even_with_image_bytes() {
        for name in [
            "logo.svg",
            "logo.txt",
            "id_rsa",
            "logo.heic",
            "logo.png.key",
        ] {
            let p = tmp(name, PNG);
            assert!(
                read_logo(&p).unwrap_err().contains("must be a PNG"),
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_non_image_bytes_behind_an_image_extension() {
        let p = tmp("secret.png", b"plain text, not a picture\n");
        assert!(read_logo(&p).unwrap_err().contains("not a valid"));
    }

    #[test]
    fn rejects_folders_missing_files_and_large_files() {
        let dir =
            std::env::temp_dir().join(format!("fp-logo-test-{}/folder.png", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_logo(&dir).unwrap_err().contains("image file"));
        assert!(read_logo(Path::new("/nonexistent/fp/logo.png"))
            .unwrap_err()
            .contains("could not be found"));
        let mut big = PNG.to_vec();
        big.resize(MAX_LOGO_BYTES as usize + 1, 0);
        let p = tmp("big.png", &big);
        assert!(read_logo(&p).unwrap_err().contains("larger than 10 MB"));
    }
}
