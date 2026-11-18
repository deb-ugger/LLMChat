use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

pub const CHUNK_LIMIT: usize = 1024 * 1024;
static PENDING: OnceLock<Mutex<HashMap<String, PendingZip>>> = OnceLock::new();

struct PendingZip {
    destination: PathBuf,
    temporary: Option<PathBuf>,
    file: Option<File>,
}

impl Drop for PendingZip {
    fn drop(&mut self) {
        drop(self.file.take());
        if let Some(path) = &self.temporary {
            let _ = fs::remove_file(path);
        }
    }
}

fn pending() -> Result<MutexGuard<'static, HashMap<String, PendingZip>>, String> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().map_err(|error| error.to_string())
}

pub fn begin(id: String, path: String) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err("图片下载编号无效".into());
    }
    let destination = PathBuf::from(path);
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err("请选择 ZIP 的完整保存路径".into());
    }
    let temporary = destination.with_file_name(format!(".llmchat-images-{id}.part"));
    let mut archives = pending()?;
    if archives.contains_key(&id) {
        return Err("图片下载已经开始写入".into());
    }
    let file = OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|error| format!("无法创建下载文件 {}：{error}", temporary.display()))?;
    archives.insert(id, PendingZip { destination, temporary: Some(temporary), file: Some(file) });
    Ok(())
}

pub fn append(id: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > CHUNK_LIMIT {
        return Err("图片 ZIP 写入分块大小无效".into());
    }
    let mut archives = pending()?;
    let file = archives.get_mut(id).and_then(|archive| archive.file.as_mut()).ok_or("图片 ZIP 写入任务不存在")?;
    file.write_all(bytes).map_err(|error| format!("写入图片 ZIP 失败：{error}"))
}

pub fn finish(id: &str, expected_bytes: u64) -> Result<(), String> {
    // Closing the app also takes this lock so it cannot interrupt the final rename.
    let mut archives = pending()?;
    let mut archive = archives.remove(id).ok_or("图片 ZIP 写入任务不存在")?;
    let file = archive.file.take().expect("open file for pending download");
    file.sync_all().map_err(|error| format!("保存图片 ZIP 失败：{error}"))?;
    let size = file.metadata().map_err(|error| format!("无法读取下载文件大小：{error}"))?.len();
    drop(file);
    if size != expected_bytes || size == 0 {
        return Err(format!("图片 ZIP 大小不匹配，预期 {expected_bytes} 字节，实际 {size} 字节"));
    }
    let temporary = archive.temporary.as_ref().expect("temporary path for pending download");
    fs::rename(temporary, &archive.destination)
        .map_err(|error| format!("无法保存到 {}：{error}", archive.destination.display()))?;
    archive.temporary = None;
    let result = fs::metadata(&archive.destination)
        .map_err(|error| format!("无法确认下载文件 {}：{error}", archive.destination.display()))?;
    if !result.is_file() || result.len() != expected_bytes {
        return Err(format!("目标文件 {} 大小不正确", archive.destination.display()));
    }
    Ok(())
}

pub fn cancel(id: &str) -> Result<(), String> {
    let Some(mut archive) = pending()?.remove(id) else { return Ok(()); };
    drop(archive.file.take());
    if let Some(path) = archive.temporary.as_ref() {
        fs::remove_file(path).map_err(|error| format!("无法清理下载临时文件 {}：{error}", path.display()))?;
        archive.temporary = None;
    }
    Ok(())
}

pub fn cancel_all() -> Result<(), String> {
    pending()?.clear();
    Ok(())
}
