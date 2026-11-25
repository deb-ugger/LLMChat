use std::{fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, process::{Command, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
use serde::Serialize;
use tauri::{ipc::Channel, Manager};
use crate::train_dataset::{managed, win};
use crate::training_python::{self, TrainingPython};

pub struct Environment {
    pub status: &'static str,
    pub python: Option<TrainingPython>,
    pub base: Option<TrainingPython>,
    pub system: bool,
    pub detail: String,
}

pub fn directory(local: &Path) -> PathBuf { local.join("training-venv") }

pub fn resolve(local: &Path, configured: Option<&str>) -> Environment {
    let explicit = configured.filter(|path| !path.trim().is_empty());
    let base = if explicit.is_some() {
        match training_python::discover(explicit) {
            Ok(value) => Some(value),
            Err(detail) => return Environment { status: "blocked", python: None, base: None, system: false, detail },
        }
    } else { None };
    if let Some(value) = base.as_ref().filter(|value| training_python::matches(value)) {
        return Environment { status: "ready", python: Some(value.clone()), base, system: true, detail: "正在使用系统环境，未隔离".into() };
    }
    let root = directory(local);
    if root.join("ready.json").is_file() {
        if let Ok(python) = training_python::inspect(&root.join("Scripts/python.exe")) {
            if training_python::matches(&python) {
                return Environment { status: "ready", python: Some(python), base, system: false, detail: "正在使用独立训练环境".into() };
            }
        }
    }
    let base = match base.map(Ok).unwrap_or_else(|| training_python::discover(None)) {
        Ok(value) => value,
        Err(detail) => return Environment { status: "blocked", python: None, base: None, system: false, detail },
    };
    Environment { status: "needs_install", python: None, base: Some(base), system: false,
        detail: "需要联网下载 CPU 训练依赖。安装失败或中断后可重新准备。".into() }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct InstallEvent { state: String, message: String }
struct Installation { job: Arc<win::Handle>, cancelled: Arc<AtomicBool> }
static INSTALLING: Mutex<Option<Installation>> = Mutex::new(None);

fn execute(command: &mut Command, events: &Channel<InstallEvent>, cancelled: &AtomicBool) -> Result<(), String> {
    let job = Arc::new(win::job()?);
    win::suspended(command);
    let mut child = command.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    if let Err(error) = win::assign(&job, &child) { let _=child.kill();let _=child.wait();return Err(error); }
    {
        let mut active = INSTALLING.lock().map_err(|e|e.to_string())?;
        if cancelled.load(Ordering::SeqCst) {
            let _=win::terminate(&job);let _=child.wait();return Err("准备已中断".into());
        }
        if let Some(active) = active.as_mut() { active.job=job.clone(); }
    }
    if let Err(error) = win::resume(&child) {let _=win::terminate(&job);let _=child.wait();return Err(error);}
    let pipe_events=events.clone();
    let stderr=child.stderr.take().unwrap();
    let errors=std::thread::spawn(move||{
        let mut last=String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            last=line.clone();let _=pipe_events.send(InstallEvent{state:"installing".into(),message:line});
        }
        last
    });
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let _=events.send(InstallEvent{state:"installing".into(),message:line});
    }
    let status=child.wait().map_err(|e|e.to_string())?;
    let error=errors.join().unwrap_or_default();
    if cancelled.load(Ordering::SeqCst) { return Err("准备已中断，可删除半成品并重新准备".into()); }
    if !status.success() { return Err(format!("训练依赖准备失败，请检查网络连接与 CPU 下载源后重新准备。{error}")); }
    Ok(())
}

pub fn rebuild(local: &Path) -> Result<PathBuf, String> {
    let root=directory(local);
    fs::create_dir_all(local).map_err(|e|e.to_string())?;
    if root.exists() {
        managed(local,&root)?;
        if root.is_symlink() {return Err("训练环境目录不能是符号链接".into());}
        fs::remove_dir_all(&root).map_err(|e|format!("无法清理训练环境，请关闭使用该环境的程序：{e}"))?;
    }
    Ok(root)
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
pub async fn ensure_training_venv(app: tauri::AppHandle, python_path: Option<String>, events: Channel<InstallEvent>) -> Result<(), String> {
    let exclusive=win::exclusive()?;
    let local=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    let base=training_python::discover(python_path.as_deref())?;
    let resources=app.path().resource_dir().map_err(|e|e.to_string())?.join("resources/training");
    let requirements=resources.join("requirements.txt");
    if !requirements.is_file(){return Err("训练依赖清单缺失，请安装完整程序".into());}
    let cancelled=Arc::new(AtomicBool::new(false));
    let job=Arc::new(win::job()?);
    *INSTALLING.lock().map_err(|e|e.to_string())?=Some(Installation{job,cancelled:cancelled.clone()});
    std::thread::spawn(move||{
        let result=(||{
            let root=rebuild(&local)?;
            let _=events.send(InstallEvent{state:"installing".into(),message:format!("使用 {} 创建独立训练环境",base.path)});
            execute(Command::new(&base.path).args(["-m","venv"]).arg(&root),&events,&cancelled)?;
            let python=root.join("Scripts/python.exe");
            let cache=local.join("training-wheel-cache");
            execute(Command::new(&python).args(["-X","utf8","-c",DOWNLOAD_WHEELS]).arg(&cache),&events,&cancelled)?;
            let tag=format!("cp{}",base.version.split('.').take(2).collect::<String>());
            execute(Command::new(&python).args(["-m","pip","install","--disable-pip-version-check","--progress-bar","off","-r"])
                .arg(requirements)
                .arg(cache.join(format!("torch-2.6.0+cpu-{tag}-{tag}-win_amd64.whl")))
                .arg(cache.join(format!("torchvision-0.21.0+cpu-{tag}-{tag}-win_amd64.whl")))
                .env("PIP_CONFIG_FILE", "NUL").env_remove("PIP_INDEX_URL").env_remove("PIP_EXTRA_INDEX_URL")
                .env_remove("PIP_FIND_LINKS").env_remove("PIP_NO_INDEX"),&events,&cancelled)?;
            let checked=training_python::inspect(&python)?;
            if !training_python::matches(&checked){return Err("安装后的依赖版本或导入检查未通过，请重新准备".into());}
            crate::training_results::write_metadata(&root.join("ready.json"),&serde_json::to_value(checked).map_err(|e|e.to_string())?)?;
            Ok::<(),String>(())
        })();
        *INSTALLING.lock().unwrap()=None;
        drop(exclusive);
        let state=if cancelled.load(Ordering::SeqCst){"cancelled"}else if result.is_ok(){"ready"}else{"failed"};
        let message=result.err().unwrap_or_else(||"训练环境已就绪".into());
        let _=events.send(InstallEvent{state:state.into(),message});
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
