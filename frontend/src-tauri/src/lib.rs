use std::io::Cursor;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BackendChild(Mutex<Option<CommandChild>>);

fn start_backend(app: &AppHandle) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("llmchat-backend")
        .map_err(|e| e.to_string())?;

    let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;

    {
        let state = app.state::<BackendChild>();
        *state.0.lock().unwrap() = Some(child);
    }

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[backend error] {err}");
                }
                CommandEvent::Terminated(payload) => {
                    println!("[backend] terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn stop_backend(app: &AppHandle) {
    let state = app.state::<BackendChild>();
    let child = {
        let mut guard = state.0.lock().unwrap();
        guard.take()
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn is_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".tif")
        || lower.ends_with(".tiff")
}

fn encode_rgba_png(width: usize, height: usize, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let w = u32::try_from(width).map_err(|_| "image width too large".to_string())?;
    let h = u32::try_from(height).map_err(|_| "image height too large".to_string())?;
    let expected = (width * height * 4) as usize;
    if bytes.len() < expected {
        return Err("clipboard image data incomplete".to_string());
    }
    let img = image::RgbaImage::from_raw(w, h, bytes[..expected].to_vec())
        .ok_or_else(|| "failed to build image buffer".to_string())?;
    let mut png = Vec::new();
    let mut cursor = Cursor::new(&mut png);
    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(png)
}

fn read_clipboard_bitmap_png() -> Result<Vec<u8>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    let img = clipboard
        .get_image()
        .map_err(|e| format!("剪贴板中没有位图: {e}"))?;
    encode_rgba_png(img.width, img.height, img.bytes.as_ref())
}

#[cfg(windows)]
fn read_clipboard_file_image() -> Result<Vec<u8>, String> {
    use clipboard_win::{formats, get_clipboard};

    let files: Vec<String> =
        get_clipboard(formats::FileList).map_err(|e| format!("剪贴板中没有文件: {e}"))?;
    let path = files
        .into_iter()
        .find(|p| is_image_path(p))
        .ok_or_else(|| "剪贴板文件不是图片".to_string())?;
    std::fs::read(&path).map_err(|e| format!("读取图片文件失败: {e}"))
}

#[cfg(not(windows))]
fn read_clipboard_file_image() -> Result<Vec<u8>, String> {
    Err("file clipboard image is only supported on Windows".to_string())
}

/// Read clipboard image as PNG bytes (bitmap first, then copied image file).
#[tauri::command]
fn clipboard_read_image_png() -> Result<Vec<u8>, String> {
    match read_clipboard_bitmap_png() {
        Ok(png) => Ok(png),
        Err(bitmap_err) => match read_clipboard_file_image() {
            Ok(bytes) => Ok(bytes),
            Err(file_err) => Err(format!("{bitmap_err}；{file_err}")),
        },
    }
}

/// Write raw bytes to an absolute path chosen via the save dialog.
#[tauri::command]
fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&path, contents).map_err(|e| format!("写入文件失败: {e}"))
}

/// Read raw bytes from an absolute path chosen via the open dialog.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))
}

/// File metadata for path-based document sessions (size + mtime ms).
#[tauri::command]
fn file_stat(path: String) -> Result<(u64, u64), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((size, mtime_ms))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(BackendChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            clipboard_read_image_png,
            write_file_bytes,
            read_file_bytes,
            file_stat
        ])
        .setup(|app| {
            if let Err(err) = start_backend(app.handle()) {
                eprintln!("Failed to start backend sidecar: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                stop_backend(app_handle);
            }
        });
}
