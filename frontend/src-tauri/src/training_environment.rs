use std::{fs, io::{BufRead, BufReader, Read}, path::{Path, PathBuf}, process::{Command, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use serde::Serialize;
use tauri::{ipc::Channel, Manager};
use crate::train_dataset::{managed, win};
use crate::training_python::{self, TrainingPython};
use crate::training_diagnostics::{record, TrainingFailure};

pub struct Environment {
    pub status: &'static str,
    pub python: Option<TrainingPython>,
    pub base: Option<TrainingPython>,
    pub system: bool,
    pub detail: String,
    pub diagnostic: Option<crate::training_diagnostics::TrainingFailure>,
    pub storage: Option<crate::training_storage::Storage>,
}

pub fn resolve(local: &Path, configured: Option<&str>, environment_dir: Option<&str>) -> Environment {
    let explicit = configured.filter(|path| !path.trim().is_empty());
    let base = if explicit.is_some() {
        match training_python::discover(explicit) {
            Ok(value) => Some(value),
            Err(failure) => return Environment { status: "blocked", python: None, base: None, system: false,
                detail: failure.message.clone(), diagnostic: Some(failure), storage: None },
        }
    } else { None };
    let storage = crate::training_storage::software_directory()
        .and_then(|software| crate::training_storage::select(&software, environment_dir, local));
    if let Some(value) = base.as_ref().filter(|value|training_python::matches(value)) {
        return Environment { status: "ready", python: Some(value.clone()), base, system: true,
            diagnostic: None, storage: storage.ok(), detail: "正在使用系统环境，未隔离".into() };
    }
    let storage = match storage {
        Ok(value) => value,
        Err(message) => return Environment { status: "blocked", python: None, base, system: false,
            detail: message, diagnostic: None, storage: None },
    };
    if storage.directory.join("ready.json").is_file() {
        if let Ok(python) = training_python::inspect(&storage.directory.join("Scripts/python.exe")) {
            if training_python::matches(&python) {
                return Environment { status: "ready", python: Some(python), base, system: false,
                    diagnostic: None, storage: Some(storage), detail: "正在使用独立训练环境".into() };
            }
        }
    }
    let base = match base.map(Ok).unwrap_or_else(||training_python::discover(None)) {
        Ok(value) => value,
        Err(failure) => return Environment { status: "blocked", python: None, base: None, system: false,
            detail: failure.message.clone(), diagnostic: Some(failure), storage: Some(storage) },
    };
    let space = crate::training_storage::check_space(&storage);
    Environment { status: if space.is_ok() { "needs_install" } else { "blocked" }, python: None, base: Some(base), system: false,
        diagnostic: None, storage: Some(storage),
        detail: space.err().unwrap_or_else(||"需要联网下载 CPU 训练依赖；旧环境可在新目录重建，原目录保留".into()) }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct InstallEvent { state: String, message: String, diagnostic: Option<TrainingFailure> }
struct Installation { job: Arc<win::Handle>, cancelled: Arc<AtomicBool> }
static INSTALLING: Mutex<Option<Installation>> = Mutex::new(None);

#[derive(Clone, Copy)]
enum Stage { Venv, Download, Pip }
impl Stage {
    fn failure(self) -> &'static str {
        match self {
            Self::Venv => "无法创建独立训练环境，请确认 Python 支持 venv 并检查用户数据目录权限后重试",
            Self::Download => "国内镜像下载失败，请检查网络连接或镜像可达性后重试",
            Self::Pip => "训练依赖安装失败，请检查网络和国内镜像后重新准备",
        }
    }
}

fn execute(command: &mut Command, events: &Channel<InstallEvent>, cancelled: &AtomicBool, stage: Stage, temporary: &Path) -> Result<(), TrainingFailure> {
    fs::create_dir_all(temporary).map_err(|cause|record(stage.failure(),cause.to_string()))?;
    let job = Arc::new(win::job().map_err(|cause|record(stage.failure(),cause))?);
    win::suspended(command);
    command.env("TEMP",temporary).env("TMP",temporary).env("PIP_CACHE_DIR",temporary.join("pip-cache"));
    let mut child = command.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|cause|record(stage.failure(),cause.to_string()))?;
    if let Err(error) = win::assign(&job, &child) { let _=child.kill();let _=child.wait();return Err(record(stage.failure(),error)); }
    {
        let mut active = INSTALLING.lock().map_err(|e|e.to_string())?;
        if cancelled.load(Ordering::SeqCst) {
            let _=win::terminate(&job);let _=child.wait();return Err("准备已中断".into());
        }
        if let Some(active) = active.as_mut() { active.job=job.clone(); }
    }
    if let Err(error) = win::resume(&child) {let _=win::terminate(&job);let _=child.wait();return Err(record(stage.failure(),error));}
    let mut stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let mut stdout = String::new();
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        stdout.push_str(&line);
        stdout.push('\n');
        let progress = ["Downloading ", "Collecting ", "Processing ", "Looking in ", "Installing collected", "Successfully installed", "复用镜像缓存 ", "torch 下载 ", "torchvision 下载 "]
            .iter().any(|prefix|line.starts_with(prefix));
        if progress {
            let _ = events.send(InstallEvent { state: "installing".into(), message: line, diagnostic: None });
        }
    }
    let status = child.wait().map_err(|cause|record(stage.failure(), cause.to_string()))?;
    let stderr = errors.join().unwrap_or_default();
    let raw = if stderr.is_empty() { stdout } else { format!("{stderr}\\n--- stdout ---\\n{stdout}") };
    if cancelled.load(Ordering::SeqCst) {
        return Err(record("准备已中断，可删除半成品并重新准备", raw));
    }
    if !status.success() { return Err(record(stage.failure(), raw)); }
    let diagnostic = record("准备阶段已完成", raw);
    let _ = events.send(InstallEvent { state: "installing".into(), message: "准备阶段已完成".into(), diagnostic: Some(diagnostic) });
    Ok(())
}

pub fn rebuild(root: &Path) -> Result<PathBuf, String> {
    let parent = root.parent().filter(|parent|!parent.as_os_str().is_empty()).ok_or("训练目录不能是盘符根目录")?;
    if !root.is_absolute() { return Err("训练目录必须为绝对路径".into()); }
    fs::create_dir_all(parent).map_err(|error|error.to_string())?;
    if root.exists() {
        managed(parent,root)?;
        let owned = root.join(".llmchat-training-environment").is_file();
        let empty = fs::read_dir(root).map_err(|error|error.to_string())?.next().is_none();
        if root.is_symlink() || (!owned && !empty) {
            return Err("目标目录包含其他文件，请选择空目录；原有训练环境可保留后在新目录重建".into());
        }
        fs::remove_dir_all(root).map_err(|error|format!("无法清理训练环境，请关闭使用该环境的程序：{error}"))?;
    }
    fs::create_dir_all(root).map_err(|error|error.to_string())?;
    fs::write(root.join(".llmchat-training-environment"),b"1").map_err(|error|error.to_string())?;
    Ok(root.to_owned())
}

// The mirror exposes a flat wheel directory. Download CPU wheels with explicit
// byte progress, then let pip resolve the remaining packages from requirements.
pub const DOWNLOAD_WHEELS: &str = r#"
import os, sys, urllib.request, zipfile
from pathlib import Path
root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
tag = 'cp' + str(sys.version_info.major) + str(sys.version_info.minor)
for package, version in [('torch','2.6.0+cpu'),('torchvision','0.21.0+cpu')]:
    name = package + '-' + version + '-' + tag + '-' + tag + '-win_amd64.whl'
    target = root / name
    url = 'https://mirrors.aliyun.com/pytorch-wheels/cpu/' + name
    if target.exists():
        try:
            with zipfile.ZipFile(target) as archive:
                if archive.testzip() is not None:
                    raise ValueError('wheel checksum failed')
            print('复用镜像缓存 ' + url, flush=True)
            continue
        except Exception:
            target.unlink()
    pending = target.with_suffix('.part')
    print('Downloading ' + url, flush=True)
    try:
        with urllib.request.urlopen(url, timeout=30) as response, pending.open('wb') as file:
            total = int(response.headers.get('Content-Length', 0))
            current = 0
            while True:
                data = response.read(1024 * 1024)
                if not data:
                    break
                file.write(data)
                current += len(data)
                if current % (8 * 1024 * 1024) == 0:
                    print(package + ' 下载 ' + str(current) + '/' + str(total) + ' 字节', flush=True)
        with zipfile.ZipFile(pending) as archive:
            if archive.testzip() is not None:
                raise ValueError('wheel checksum failed')
        os.replace(pending, target)
    except Exception as error:
        pending.unlink(missing_ok=True)
        raise RuntimeError('国内镜像下载失败，请检查网络连接或镜像可达性：' + str(error))
"#;

#[tauri::command]
pub async fn ensure_training_venv(app: tauri::AppHandle, python_path: Option<String>, environment_dir: Option<String>, events: Channel<InstallEvent>) -> Result<(), String> {
    let exclusive=win::exclusive()?;
    let local=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    let base=training_python::discover(python_path.as_deref())?;
    let storage=crate::training_storage::select(&crate::training_storage::software_directory()?,environment_dir.as_deref(),&local)?;
    crate::training_storage::check_space(&storage)?;
    let resources=app.path().resource_dir().map_err(|e|e.to_string())?.join("resources/training");
    let requirements=resources.join("requirements.txt");
    if !requirements.is_file(){return Err("训练依赖清单缺失，请安装完整程序".into());}
    let cancelled=Arc::new(AtomicBool::new(false));
    let job=Arc::new(win::job()?);
    *INSTALLING.lock().map_err(|e|e.to_string())?=Some(Installation{job,cancelled:cancelled.clone()});
    std::thread::spawn(move||{
        let result=(||{
            let root=rebuild(&storage.directory).map_err(|raw|record("无法准备训练目录，请确认目录权限与剩余空间后重试",raw))?;
            let _=events.send(InstallEvent{state:"installing".into(),message:format!("使用 {} 创建独立训练环境",base.path),diagnostic:None});
            execute(Command::new(&base.path).args(["-m","venv"]).arg(&root),&events,&cancelled,Stage::Venv,&storage.temp_directory)?;
            let python=root.join("Scripts/python.exe");
            let cache=storage.cache_directory.clone();
            fs::create_dir_all(&cache).map_err(|error|error.to_string())?;
            if let Some(old)=&storage.legacy_directory {
                if let Some(parent)=old.parent() {
                    let previous=parent.join("training-wheel-cache");
                    if let Ok(files)=fs::read_dir(previous) {
                        for file in files.flatten() {
                            let name=file.file_name();
                            if name.to_string_lossy().ends_with(".whl")&&!cache.join(&name).exists() {
                                fs::copy(file.path(),cache.join(&name)).map_err(|error|error.to_string())?;
                            }
                        }
                    }
                }
            }
            execute(Command::new(&python).args(["-X","utf8","-c",DOWNLOAD_WHEELS]).arg(&cache),&events,&cancelled,Stage::Download,&storage.temp_directory)?;
            let tag=format!("cp{}",base.version.split('.').take(2).collect::<String>());
            execute(Command::new(&python).args(["-m","pip","install","--disable-pip-version-check","--progress-bar","off","-r"])
                .arg(requirements)
                .arg(cache.join(format!("torch-2.6.0+cpu-{tag}-{tag}-win_amd64.whl")))
                .arg(cache.join(format!("torchvision-0.21.0+cpu-{tag}-{tag}-win_amd64.whl")))
                .env("PIP_CONFIG_FILE", "NUL").env_remove("PIP_INDEX_URL").env_remove("PIP_EXTRA_INDEX_URL")
                .env_remove("PIP_FIND_LINKS").env_remove("PIP_NO_INDEX"),&events,&cancelled,Stage::Pip,&storage.temp_directory)?;
            let checked=training_python::inspect(&python)?;
            if !training_python::matches(&checked){return Err("安装后的依赖版本或导入检查未通过，请重新准备".into());}
            crate::training_results::write_metadata(&root.join("ready.json"),&serde_json::to_value(checked).map_err(|e|e.to_string())?)?;
            Ok::<(),TrainingFailure>(())
        })();
        *INSTALLING.lock().unwrap()=None;
        drop(exclusive);
        let state=if cancelled.load(Ordering::SeqCst){"cancelled"}else if result.is_ok(){"ready"}else{"failed"};
        let diagnostic = result.err();
        let message = diagnostic.as_ref().map(|failure|failure.message.clone()).unwrap_or_else(||"训练环境已就绪".into());
        let _=events.send(InstallEvent{state:state.into(),message,diagnostic});
    });
    Ok(())
}

#[tauri::command]
pub fn cancel_training_environment() -> Result<(),String>{
    let active=INSTALLING.lock().map_err(|e|e.to_string())?;
    let active=active.as_ref().ok_or("没有正在准备的训练环境")?;
    active.cancelled.store(true,Ordering::SeqCst);
    win::terminate(&active.job)
}
