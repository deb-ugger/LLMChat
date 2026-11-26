use std::{borrow::Cow, fs, path::{Path, PathBuf}};
use tauri::ipc::{Channel, InvokeBody, Request};

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[tauri::command]
pub fn write_training_dataset_file(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let id = request.headers().get("llmchat-dataset-id")
        .and_then(|value| value.to_str().ok()).ok_or("缺少数据集工作副本编号")?;
    let name = request.headers().get("llmchat-dataset-file")
        .and_then(|value| value.to_str().ok()).ok_or("缺少数据集文件名")?;
    let image = name.strip_prefix("images/").and_then(|value| value.strip_suffix(".png"));
    if !["manifest.json", "annotations.work.json", "review.csv"].contains(&name) &&
        !image.is_some_and(valid_hash) {
        return Err("无效的数据集文件名".into());
    }
    let directory = crate::train_dataset::training_dataset_directory(app, id.to_owned())?;
    if image.is_some() && directory.join("images").exists() {
        crate::train_dataset::managed(&directory, &directory.join("images"))?;
    }
    let bytes: Cow<'_, [u8]> = match request.body() {
        InvokeBody::Raw(bytes) => Cow::Borrowed(bytes),
        InvokeBody::Json(value) => Cow::Owned(serde_json::from_value::<Vec<u8>>(value.clone())
            .map_err(|_| "无效的数据集文件数据")?),
    };
    crate::write_atomic_export(&directory.join(name), |file| {
        std::io::Write::write_all(file, &bytes)
    }).map_err(|error| format!("保存数据集文件失败：{error}"))
}

fn link_images(source: &Path, directory: &Path, hashes: &[String], progress: impl Fn(usize)) -> Result<(), String> {
    if hashes.iter().any(|hash| !valid_hash(hash)) {
        return Err("数据集图片编号无效".into());
    }
    let source = source.join("images").canonicalize().map_err(|error| error.to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let images = directory.join("images");
    fs::create_dir(&images).map_err(|error| error.to_string())?;
    let mut created: Vec<PathBuf> = Vec::new();
    let result = (|| {
        for (index, hash) in hashes.iter().enumerate() {
            let name = format!("{hash}.png");
            let original = crate::train_dataset::managed(&source, &source.join(&name))?;
            let target = images.join(name);
            fs::hard_link(original, &target).map_err(|error|
                format!("无法共用图片，请确认两个数据集位于同一磁盘分区且支持硬链接，或选择「复制全部图片」：{error}"))?;
            created.push(target);
            progress(index + 1);
        }
        Ok(())
    })();
    if result.is_err() {
        for target in created { let _ = fs::remove_file(target); }
        let _ = fs::remove_dir(images);
    }
    result
}

#[tauri::command]
pub async fn link_training_dataset_images(app: tauri::AppHandle, dataset_work_id: String,
    source_directory: String, hashes: Vec<String>, progress: Channel<usize>) -> Result<(), String> {
    let directory = crate::train_dataset::training_dataset_directory(app, dataset_work_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        link_images(Path::new(&source_directory), &directory, &hashes, |count| { let _ = progress.send(count); })
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn remove_training_dataset_image(app: tauri::AppHandle, dataset_work_id: String, hash: String) -> Result<(), String> {
    if !valid_hash(&hash) { return Err("数据集图片编号无效".into()); }
    let directory = crate::train_dataset::training_dataset_directory(app, dataset_work_id)?;
    let images = directory.join("images");
    let path = images.join(format!("{hash}.png"));
    if !path.exists() { return Ok(()); }
    crate::train_dataset::managed(&directory, &images)?;
    crate::train_dataset::managed(&images, &path)?;
    fs::remove_file(path).map_err(|error| format!("删除工作副本图片失败：{error}"))
}

fn checked_dataset_directory(directory: &Path, id: &str) -> Result<Option<PathBuf>, String> {
    if !directory.is_absolute() || directory.file_name().and_then(|name| name.to_str()) != Some(id) {
        return Err("数据集删除路径无效".into());
    }
    if !directory.exists() { return Ok(None); }
    let parent = directory.parent().ok_or("数据集目录无效")?.canonicalize().map_err(|error| error.to_string())?;
    let resolved = directory.canonicalize().map_err(|error| error.to_string())?;
    if resolved != parent.join(id) || !resolved.is_dir() {
        return Err("数据集删除路径超出工作副本目录".into());
    }
    Ok(Some(resolved))
}

#[tauri::command]
pub async fn remove_training_dataset(app: tauri::AppHandle, dataset_work_id: String) -> Result<(), String> {
    let directory = crate::train_dataset::training_dataset_directory(app, dataset_work_id.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _exclusive = crate::train_dataset::win::exclusive()?;
        if checked_dataset_directory(&directory, &dataset_work_id)?.is_none() { return Ok(()); }
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::UI::Shell::{
            SHFileOperationW, SHFILEOPSTRUCTW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        }};
        let paths: Vec<u16> = directory.as_os_str().encode_wide().chain([0, 0]).collect();
        let mut operation = SHFILEOPSTRUCTW {
            wFunc: FO_DELETE, pFrom: PCWSTR(paths.as_ptr()),
            fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
            ..Default::default()
        };
        let result = unsafe { SHFileOperationW(&mut operation) };
        if result != 0 || operation.fAnyOperationsAborted.as_bool() {
            return Err(format!("删除数据集失败，系统返回码 {result}"));
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}
