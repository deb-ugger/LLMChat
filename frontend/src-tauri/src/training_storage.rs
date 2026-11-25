use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use tauri::Manager;

pub const REQUIRED_BYTES: u64 = 1_900_000_000;
static WRITE_CHECK: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Drive { pub root: String, pub free_bytes: u64 }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Storage {
    pub directory: PathBuf, pub cache_directory: PathBuf, pub pip_cache_directory: PathBuf, pub temp_directory: PathBuf,
    pub drives: Vec<Drive>, pub free_bytes: u64, pub required_bytes: u64,
    pub reason: String, pub issue: Option<String>, pub software_directory: PathBuf, pub legacy_directory: Option<PathBuf>, pub legacy_bytes: u64,
}

pub fn drives() -> Vec<Drive> {
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(path: *const u16) -> u32;
        fn GetDiskFreeSpaceExW(path: *const u16, available: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let mask=unsafe {GetLogicalDrives()};
    let mut disks=vec![];
    for index in 0..26 {
        if mask & (1 << index)==0 {continue;}
        let root=format!("{}:/",(b'A'+index) as char);
        let wide=root.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let mut available=0;
        if unsafe {GetDriveTypeW(wide.as_ptr())}==3 && unsafe {GetDiskFreeSpaceExW(wide.as_ptr(),&mut available,std::ptr::null_mut(),std::ptr::null_mut())}!=0 {
            disks.push(Drive{root,free_bytes:available});
        }
    }
    disks
}

fn drive_of(path: &Path) -> Option<String> {
    let text=path.to_string_lossy().replace('\\',"/");
    let text=text.strip_prefix("//?/").unwrap_or(&text);
    if text.as_bytes().get(1)==Some(&b':') {Some(format!("{}:/",text.chars().next()?.to_ascii_uppercase()))} else {None}
}

pub fn software_directory() -> Result<PathBuf,String> {
    std::env::current_exe().map_err(|error|error.to_string())?.parent().map(Path::to_owned).ok_or("无法确定软件目录".into())
}

pub fn legacy(local:&Path)->Option<PathBuf>{
    let mut candidates=vec![local.join("training-venv")];
    if let Some(appdata)=std::env::var_os("LOCALAPPDATA"){
        candidates.push(PathBuf::from(appdata).join("LLMChat-training-check/training-venv"));
    }
    candidates.into_iter().find(|path|path.join("ready.json").is_file()&&path.join("Scripts/python.exe").is_file())
}

pub fn select(software: &Path, requested: Option<&str>, local: &Path) -> Result<Storage,String> {
    let disks=drives();
    let explicit=requested.map(str::trim).filter(|path|!path.is_empty());
    let directory=explicit.map(PathBuf::from).unwrap_or_else(||software.join("training-venv"));
    if !directory.is_absolute() || directory.parent().is_none() {
        return Err("请选择固定磁盘上的绝对目录，不能直接选择盘符根目录".into());
    }
    let volume=drive_of(&directory).ok_or("请选择本机固定磁盘上的训练环境目录")?;
    let disk=disks.iter().find(|drive|drive.root==volume).ok_or("目标目录不在本机固定磁盘上")?;
    let free_bytes=disk.free_bytes;
    let parent=directory.parent().ok_or("训练目录不能是盘符根目录")?;
    let mut ancestor=parent;
    while !ancestor.exists(){ancestor=ancestor.parent().ok_or("目标目录的父路径不存在")?;}
    let test=ancestor.join(format!(".llmchat-write-check-{}-{}",std::process::id(),WRITE_CHECK.fetch_add(1,Ordering::Relaxed)));
    let writable=fs::write(&test,b"check").and_then(|_|fs::remove_file(&test));
    let issue=if free_bytes<REQUIRED_BYTES {
        Some(format!("目标盘剩余 {:.2} GB，需要约 1.9 GB，请选择其他训练环境目录",free_bytes as f64/1e9))
    }else if writable.is_err(){
        Some("软件目录不可写，请选择其他训练环境目录；不会自动更换到 C 盘".into())
    }else{None};
    let name=directory.file_name().ok_or("训练目录不能是盘符根目录")?.to_string_lossy();
    let cache_directory=directory.with_file_name(format!("{name}-cache"));
    let pip_cache_directory=directory.join(".pip-cache");
    let temp_directory=directory.join(".tmp");
    let legacy_directory=legacy(local).filter(|path|path!=&directory);
    let legacy_bytes=legacy_directory.as_ref().map(|path|tree_bytes(path)).unwrap_or(0);
    Ok(Storage{directory,cache_directory,pip_cache_directory,temp_directory,drives:disks,free_bytes,required_bytes:REQUIRED_BYTES,
        reason:if explicit.is_some(){"使用用户指定的训练环境目录".into()}else{"默认使用 llmchat.exe 所在的软件目录".into()},
        issue,software_directory:software.to_owned(),legacy_directory,legacy_bytes})
}

#[tauri::command]
pub fn clear_training_pip_cache(app:tauri::AppHandle,environment_dir:Option<String>)->Result<(),String>{
    let _exclusive=crate::train_dataset::win::exclusive()?;
    let storage=select(&software_directory()?,environment_dir.as_deref(),&app.path().app_local_data_dir().map_err(|error|error.to_string())?)?;
    if !storage.directory.join(".llmchat-training-environment").is_file(){return Err("该目录不属于软件创建的训练环境，无法自动清理".into());}
    if storage.pip_cache_directory.exists(){
        crate::train_dataset::managed(&storage.directory,&storage.pip_cache_directory)?;
        fs::remove_dir_all(&storage.pip_cache_directory).map_err(|_|"无法清理 pip 缓存，请关闭使用该环境的程序后重试".to_string())?;
    }
    Ok(())
}

pub fn check_space(storage:&Storage)->Result<(),String>{
    storage.issue.clone().map_or(Ok(()),Err)
}

fn tree_bytes(path:&Path)->u64{
    let Ok(entries)=fs::read_dir(path) else{return 0;};
    entries.flatten().map(|entry|{
        let Ok(meta)=entry.metadata() else{return 0;};
        if meta.is_file(){meta.len()}else if meta.is_dir()&&!entry.path().is_symlink(){tree_bytes(&entry.path())}else{0}
    }).sum()
}

#[tauri::command]
pub async fn training_storage_info(app:tauri::AppHandle,python_path:Option<String>,environment_dir:Option<String>)->Result<Storage,String>{
    tauri::async_runtime::spawn_blocking(move||{
        let _=python_path;
        select(&software_directory()?,environment_dir.as_deref(),&app.path().app_local_data_dir().map_err(|error|error.to_string())?)
    }).await.map_err(|error|error.to_string())?
}

#[tauri::command]
pub fn remove_legacy_training_environment(app:tauri::AppHandle)->Result<(),String>{
    let _exclusive=crate::train_dataset::win::exclusive()?;
    let local=app.path().app_local_data_dir().map_err(|error|error.to_string())?;
    let old=legacy(&local).ok_or("没有检测到可删除的旧训练环境")?;
    if old==software_directory()?.join("training-venv"){return Err("当前软件目录中的训练环境不能作为旧环境删除".into());}
    fs::remove_dir_all(old).map_err(|_|"旧环境正在使用或没有删除权限，请关闭相关程序后重试".into())
}
