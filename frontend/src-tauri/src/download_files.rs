use std::path::Path;

#[cfg(not(test))]
#[tauri::command]
pub async fn delete_download_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_download_path(Path::new(&path)))
        .await
        .map_err(|error| format!("删除下载文件任务失败：{error}"))?
}

fn delete_download_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.as_os_str().is_empty() {
        return Err("下载文件路径必须为绝对路径".to_string());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("只能删除下载文件，不能删除目录或链接".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("无法读取下载文件：{error}")),
    }
    delete_file(path)
}

#[cfg(windows)]
fn delete_file(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FO_DELETE, SHFILEOPSTRUCTW,
    };
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        return Err("下载文件路径包含无效字符".to_string());
    }
    name.extend([0, 0]);
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(name.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut operation) };
    if operation.fAnyOperationsAborted.as_bool() {
        return Err("文件删除已取消".to_string());
    }
    if code != 0 {
        return Err(format!("系统无法删除文件，错误码 {code}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn delete_file(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|error| format!("删除下载文件失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletes_a_file_and_rejects_directories() {
        let directory = std::env::temp_dir().join(format!(
            "llmchat-download-delete-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("download.jsonl");
        std::fs::write(&file, b"download fixture").unwrap();
        assert!(delete_download_path(&directory).is_err());
        assert!(file.exists());
        let result = delete_download_path(&file);
        if result.is_err() {
            let _ = std::fs::remove_file(&file);
        }
        std::fs::remove_dir(&directory).unwrap();
        result.unwrap();
        assert!(!file.exists());
        assert!(delete_download_path(&file).is_ok());
        assert!(delete_download_path(Path::new("relative.jsonl")).is_err());
    }
}
