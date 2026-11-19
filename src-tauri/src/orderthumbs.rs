//! Per-order-line pictures from the 3D order builder (New Order / Re-pose / website orders).
//!
//! LOCAL ONLY: these files live in the user's data folder and are never synced to the
//! shop or Supabase (no `fp-sync`, no shop data field, snapshot schema unchanged).
//! Each order line keeps its own picture; nothing is shared or cached per product.
//!
//! Layout (under `datadir::user_data_dir()`):
//!   order_thumbs/<order_id>/<order_line_id>.png   colored picture (transparent PNG)
//!   order_thumbs/<order_id>/<order_line_id>.json  meta: camera, partColors, size, layers…
//!
//! Pure std so it can be unit-tested without Tauri.
use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = "order_thumbs";

/// Order / line ids are ledger ids (`UUID`, `line-<uuid>-<n>`); anything else is refused so
/// an id can never escape the folder.
pub fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 160
        || id.starts_with('.')
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("\"{id}\" cannot be used as an order picture name"));
    }
    Ok(id)
}

pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

pub fn order_dir(data_dir: &Path, order_id: &str) -> Result<PathBuf, String> {
    Ok(root(data_dir).join(safe_id(order_id)?))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Writes (or overwrites) one line's picture + meta JSON text.
pub fn save(
    data_dir: &Path,
    order_id: &str,
    line_id: &str,
    png: &[u8],
    meta_json: &str,
) -> Result<PathBuf, String> {
    let line_id = safe_id(line_id)?;
    let dir = order_dir(data_dir, order_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let png_path = dir.join(format!("{line_id}.png"));
    write_atomic(&png_path, png)?;
    write_atomic(&dir.join(format!("{line_id}.json")), meta_json.as_bytes())?;
    Ok(png_path)
}

pub struct SavedLine {
    pub line_id: String,
    pub png: Vec<u8>,
    /// Raw meta JSON text (None when missing).
    pub meta_json: Option<String>,
}

/// Every saved line picture for one order (missing folder = empty list).
pub fn load(data_dir: &Path, order_id: &str) -> Result<Vec<SavedLine>, String> {
    let dir = order_dir(data_dir, order_id)?;
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Some(stem) = name.strip_suffix(".png") else {
            continue;
        };
        if safe_id(stem).is_err() {
            continue;
        }
        let Ok(png) = std::fs::read(entry.path()) else {
            continue;
        };
        let meta_json = std::fs::read_to_string(dir.join(format!("{stem}.json"))).ok();
        out.push(SavedLine {
            line_id: stem.to_string(),
            png,
            meta_json,
        });
    }
    out.sort_by(|a, b| a.line_id.cmp(&b.line_id));
    Ok(out)
}

/// Removes one line's files, or the whole order folder when `line_id` is None.
pub fn delete(data_dir: &Path, order_id: &str, line_id: Option<&str>) -> Result<(), String> {
    let dir = order_dir(data_dir, order_id)?;
    match line_id {
        Some(l) => {
            let l = safe_id(l)?;
            let _ = std::fs::remove_file(dir.join(format!("{l}.png")));
            let _ = std::fs::remove_file(dir.join(format!("{l}.json")));
            // Drop the folder once it's empty.
            if std::fs::read_dir(&dir)
                .map(|mut it| it.next().is_none())
                .unwrap_or(false)
            {
                let _ = std::fs::remove_dir(&dir);
            }
        }
        None => {
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Removes a line's files when only the line id is known (`delete_order_line`).
pub fn delete_line_anywhere(data_dir: &Path, line_id: &str) {
    let Ok(line_id) = safe_id(line_id) else {
        return;
    };
    let Ok(rd) = std::fs::read_dir(root(data_dir)) else {
        return;
    };
    for entry in rd.flatten() {
        let order_id = entry.file_name().to_string_lossy().to_string();
        if entry.path().join(format!("{line_id}.png")).exists()
            || entry.path().join(format!("{line_id}.json")).exists()
        {
            let _ = delete(data_dir, &order_id, Some(line_id));
        }
    }
}

pub fn encode_b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("fp-orderthumbs-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(safe_id("../x").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
        assert!(safe_id(".hidden").is_err());
        assert!(safe_id("line-0F2A-1").is_ok());
    }

    #[test]
    fn save_load_overwrite_delete() {
        let d = tmp();
        save(&d, "ORDER-1", "line-a", b"png1", "{\"v\":1}").unwrap();
        save(&d, "ORDER-1", "line-b", b"png2", "{}").unwrap();
        save(&d, "ORDER-2", "line-a2", b"png3", "{}").unwrap();
        save(&d, "ORDER-1", "line-a", b"png1b", "{\"v\":2}").unwrap();
        let got = load(&d, "ORDER-1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].png, b"png1b");
        assert_eq!(got[0].meta_json.as_deref(), Some("{\"v\":2}"));
        delete_line_anywhere(&d, "line-b");
        assert_eq!(load(&d, "ORDER-1").unwrap().len(), 1);
        delete(&d, "ORDER-1", None).unwrap();
        assert!(load(&d, "ORDER-1").unwrap().is_empty());
        assert_eq!(load(&d, "ORDER-2").unwrap().len(), 1);
        delete(&d, "ORDER-2", Some("line-a2")).unwrap();
        assert!(!order_dir(&d, "ORDER-2").unwrap().exists());
        assert!(load(&d, "NOPE").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn b64() {
        assert_eq!(encode_b64(b""), "");
        assert_eq!(encode_b64(b"f"), "Zg==");
        assert_eq!(encode_b64(b"fo"), "Zm8=");
        assert_eq!(encode_b64(b"foo"), "Zm9v");
        assert_eq!(encode_b64(b"foobar"), "Zm9vYmFy");
    }
}
