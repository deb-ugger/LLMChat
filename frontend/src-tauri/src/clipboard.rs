use image::ImageEncoder;

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

pub(super) fn encode_rgba_png(width: usize, height: usize, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let w = u32::try_from(width).map_err(|_| "image width too large".to_string())?;
    let h = u32::try_from(height).map_err(|_| "image height too large".to_string())?;
    let expected = width.checked_mul(height).and_then(|pixels| pixels.checked_mul(4)).ok_or("image dimensions too large")?;
    let rgba = bytes.get(..expected).ok_or("clipboard image data incomplete")?;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
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
pub(super) async fn clipboard_read_image_png() -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(|| {
        read_clipboard_bitmap_png().or_else(|bitmap_err| {
            read_clipboard_file_image().map_err(|file_err| format!("{bitmap_err}；{file_err}"))
        }).map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}
