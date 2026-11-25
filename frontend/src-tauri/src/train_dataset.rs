use serde::{Deserialize, Serialize};
use std::{fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, process::{Command, Stdio},
    sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}}};
use tauri::{ipc::Channel, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingOptions { pub comfy_dir: String, pub limit: u32 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingEvent {
    run_id: String, state: String, phase: String, current: u64, total: u64,
    message: String, output_dir: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport { ready: bool, messages: Vec<String> }
struct Active { id: String, job: Arc<win::Handle>, cancelled: Arc<AtomicBool> }
static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn error(value: impl std::fmt::Display) -> String { value.to_string() }
pub(super) fn resource(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app.path().resource_dir().map_err(error)?.join("resources/training");
    for file in ["mosaic-region-training.ps1", "train-mosaic-region-classifier.py", "torch/hub/checkpoints/mobilenet_v3_small-047dcff4.pth"] {
        if !path.join(file).is_file() { return Err(format!("训练资源缺失：{file}，请重新安装完整程序")); }
    }
    path.canonicalize().map_err(error)
}
pub(super) fn managed(root: &Path, child: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(error)?;
    let path = child.canonicalize().map_err(error)?;
    if !path.starts_with(&root) { return Err("数据集或产物路径超出受管目录".into()); }
    Ok(path)
}
pub(super) fn work(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.len() != 36 || id.chars().enumerate().any(|(i,c)| if [8,13,18,23].contains(&i) { c != '-' } else { !c.is_ascii_hexdigit() }) {
        return Err("数据集工作副本标识无效".into());
    }
    let root = app.path().app_local_data_dir().map_err(error)?.join("training-datasets");
    managed(&app.path().app_local_data_dir().map_err(error)?, &root)?;
    let path = managed(&root, &root.join(id))?;
    for name in ["manifest.json", "review.csv"] { managed(&path, &path.join(name))?; }
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(path.join("manifest.json")).map_err(error)?).map_err(error)?;
    let annotation = manifest["annotationsFile"].as_str().ok_or("数据集缺少标注文件")?;
    if Path::new(annotation).components().count() != 1 { return Err("标注文件路径无效".into()); }
    managed(&path, &path.join(annotation))?;
    let images = path.join("images");
    managed(&path, &images)?;
    for entry in fs::read_dir(&images).map_err(error)? { managed(&path, &entry.map_err(error)?.path())?; }
    Ok(path)
}
fn probe(comfy: &str, resources: &Path, output: &Path) -> EnvReport {
    let mut messages = vec![];
    let python = Path::new(comfy).join("python_embeded/python.exe");
    if comfy.trim().is_empty() { messages.push("请先在设置中指定 ComfyUI 路径".into()); }
    else if !python.is_file() { messages.push("找不到 python_embeded/python.exe，请检查 ComfyUI 路径".into()); }
    else {
        let script = "import torch, torchvision; from PIL import Image; from torchvision.models import MobileNet_V3_Small_Weights; import os; p=os.path.join(os.environ['TORCH_HOME'],'hub','checkpoints',os.path.basename(MobileNet_V3_Small_Weights.DEFAULT.url)); torch.load(p,map_location='cpu',weights_only=True); print('Python / Pillow / torch / torchvision / 预训练权重检查通过')";
        let mut command = Command::new(python);
        win::hidden(&mut command);
        match command.args(["-X", "utf8", "-c", script]).env("TORCH_HOME", resources.join("torch")).output() {
            Ok(result) if result.status.success() => {},
            Ok(result) => messages.push(format!("训练依赖或预训练权重无法加载：{}", String::from_utf8_lossy(&result.stderr).trim())),
            Err(e) => messages.push(format!("无法启动训练 Python：{e}")),
        }
    }
    let check = output.join(format!(".write-check-{}-{}", std::process::id(), SEQUENCE.fetch_add(1,Ordering::Relaxed)));
    if let Err(e) = fs::create_dir_all(output).and_then(|_| fs::write(&check, b"check")).and_then(|_| fs::remove_file(&check)) {
        messages.push(format!("训练输出目录不可写：{e}"));
    }
    EnvReport { ready: messages.is_empty(), messages }
}
#[tauri::command]
pub async fn probe_training_env(app: tauri::AppHandle, comfy_dir: String) -> Result<EnvReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resources = resource(&app)?;
        let output = app.path().app_local_data_dir().map_err(error)?.join("training-runs");
        Ok(probe(&comfy_dir, &resources, &output))
    }).await.map_err(error)?
}
#[tauri::command]
pub fn cancel_training(run_id: String) -> Result<(), String> {
    let active = ACTIVE.lock().map_err(error)?;
    let run = active.as_ref().filter(|run| run.id == run_id).ok_or("该训练任务已结束")?;
    run.cancelled.store(true, Ordering::SeqCst);
    win::terminate(&run.job)
}
#[tauri::command]
pub async fn start_training(app: tauri::AppHandle, dataset_work_id: String, options: TrainingOptions, events: Channel<TrainingEvent>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let exclusive = win::exclusive()?;
        if options.limit > 100_000 { return Err("样本上限须为 0–100000".into()); }
        let resources = resource(&app)?;
        let dataset = work(&app, &dataset_work_id)?;
        let output_root = app.path().app_local_data_dir().map_err(error)?.join("training-runs");
        let env = probe(&options.comfy_dir, &resources, &output_root);
        if !env.ready { return Err(env.messages.join("\n")); }
        managed(&app.path().app_local_data_dir().map_err(error)?, &output_root)?;
        let id = format!("{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(error)?.as_millis(), SEQUENCE.fetch_add(1,Ordering::Relaxed));
        let output = output_root.join(format!("run-{id}"));
        fs::create_dir(&output).map_err(error)?;
        let output = managed(&output_root, &output)?;
        let snapshot = crate::training_results::snapshot(&dataset, &output)?;
        let mut metadata = serde_json::json!({"runId": id, "datasetWorkId": dataset_work_id,
            "createdAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(error)?.as_millis() as u64,
            "state": "running", "limit": options.limit});
        crate::training_results::write_metadata(&output.join("run.json"), &metadata)?;
        let job = Arc::new(win::job()?);
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(resources.join("mosaic-region-training.ps1")).args(["-Action", "TrainOnly", "-Comfy"]).arg(options.comfy_dir)
            .arg("-Dataset").arg(snapshot).arg("-Output").arg(&output).arg("-Limit").arg(options.limit.to_string())
            .env("TORCH_HOME", resources.join("torch")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        win::suspended(&mut command);
        let mut child = command.spawn().map_err(error)?;
        if let Err(e) = win::assign(&job, &child) { let _ = child.kill(); let _ = child.wait(); return Err(e); }
        {
            let mut active = ACTIVE.lock().map_err(error)?;
            *active = Some(Active { id: id.clone(), job: job.clone(), cancelled: cancelled.clone() });
        }
        if let Err(e) = win::resume(&child) { let _ = win::terminate(&job); let _ = child.wait(); *ACTIVE.lock().map_err(error)? = None; return Err(e); }
        let run_id = id.clone();
        std::thread::spawn(move || {
            let _exclusive = exclusive;
            let emit = |state: &str, phase: &str, current, total, message: String| {
                let _ = events.send(TrainingEvent { run_id: id.clone(), state: state.into(), phase: phase.into(), current, total, message, output_dir: output.to_string_lossy().into() });
            };
            emit("running", "prepare", 0, 160, "正在启动训练".into());
            let stderr = child.stderr.take().unwrap();
            let log_events = events.clone(); let log_id=id.clone(); let log_output=output.clone();
            let errors = std::thread::spawn(move || {
                let mut last = String::new();
                for line in BufReader::new(stderr).lines() {
                    match line { Ok(line) => {
                        last = line.clone();
                        let _=log_events.send(TrainingEvent {run_id:log_id.clone(),state:"running".into(),phase:"log".into(),current:0,total:0,message:line,output_dir:log_output.to_string_lossy().into()});
                    }, Err(e) => {last=e.to_string();break;} }
                }
                last
            });
            for line in BufReader::new(child.stdout.take().unwrap()).lines() {
                let Ok(line) = line else { break; };
                if let Some(raw) = line.strip_prefix("PROGRESS ") {
                    if let Ok(progress) = serde_json::from_str::<serde_json::Value>(raw) {
                        emit("running", progress["phase"].as_str().unwrap_or("log"), progress["current"].as_u64().unwrap_or(0), progress["total"].as_u64().unwrap_or(0), line.clone());
                        continue;
                    }
                }
                emit("running", "log", 0, 0, line);
            }
            let status = child.wait();
            let message = errors.join().unwrap_or_default();
            let stopped = cancelled.load(Ordering::SeqCst);
            let (state, message) = if stopped { ("cancelled", "训练已中断".into()) }
                else if status.as_ref().is_ok_and(|status| status.success()) { ("complete", "训练完成，产物已保存".into()) }
                else { ("failed", format!("训练失败：{message} {}", status.map(|s|s.to_string()).unwrap_or_else(error))) };
            if let Ok(mut active) = ACTIVE.lock() { *active = None; }
            drop(job);
            drop(_exclusive);
            metadata["state"] = serde_json::json!(state);
            let saved = crate::training_results::write_metadata(&output.join("run.json"), &metadata);
            if let Err(e) = saved { emit("failed", "finished", 0, 0, e); }
            else { emit(state, "finished", 0, 0, message); }
        });
        Ok(run_id)
    }).await.map_err(error)?
}

// The suspended parent is assigned before it can launch Python.
#[cfg(windows)]
pub(super) mod win {
    use super::*;
    use std::{ffi::c_void, os::windows::{io::AsRawHandle, process::CommandExt, fs::OpenOptionsExt}};
    type Raw = *mut c_void;
    #[link(name="kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: Raw, name: *const u16) -> Raw;
        fn AssignProcessToJobObject(job: Raw, process: Raw) -> i32;
        fn TerminateJobObject(job: Raw, code: u32) -> i32;
        fn CloseHandle(handle: Raw) -> i32;
        fn SetInformationJobObject(job: Raw, class: i32, value: Raw, length: u32) -> i32;
    }
    #[link(name="ntdll")]
    unsafe extern "system" { fn NtResumeProcess(process: Raw) -> i32; }
    pub struct Handle(usize);
    impl Handle { fn raw(&self) -> Raw { self.0 as Raw } }
    impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.raw()); } } }
    pub fn exclusive() -> Result<fs::File,String> {
        fs::OpenOptions::new().create(true).truncate(false).write(true).share_mode(0)
            .open(std::env::temp_dir().join("llmchat-dataset-training.lock"))
            .map_err(|e| if e.raw_os_error()==Some(32) {"已有训练任务正在运行".into()} else {e.to_string()})
    }
    pub fn job() -> Result<Handle,String> {
        let handle=unsafe { CreateJobObjectW(std::ptr::null_mut(),std::ptr::null()) };
        if handle.is_null() {return Err(std::io::Error::last_os_error().to_string());}
        let handle=Handle(handle as usize);
        #[repr(C)]
        #[derive(Default)]
        struct Basic { times:[i64;2], flags:u32, minimum:usize, maximum:usize, active:u32, affinity:usize, priority:u32, scheduling:u32 }
        #[repr(C)]
        #[derive(Default)]
        struct Extended { basic:Basic, io:[u64;6], memory:[usize;4] }
        let mut info=Extended::default();info.basic.flags=0x2000;
        if unsafe {SetInformationJobObject(handle.raw(),9,&mut info as *mut _ as Raw,std::mem::size_of::<Extended>() as u32)}==0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(handle)
    }
    pub fn assign(job: &Handle, child: &std::process::Child) -> Result<(),String> {
        if unsafe { AssignProcessToJobObject(job.raw(),child.as_raw_handle()) } == 0 {Err(std::io::Error::last_os_error().to_string())} else {Ok(())}
    }
    pub fn terminate(job: &Handle) -> Result<(),String> {
        if unsafe { TerminateJobObject(job.raw(),1) } == 0 {Err(std::io::Error::last_os_error().to_string())} else {Ok(())}
    }
    pub fn resume(child: &std::process::Child) -> Result<(),String> {
        if unsafe { NtResumeProcess(child.as_raw_handle()) } < 0 {Err("无法恢复训练进程".into())} else {Ok(())}
    }
    pub fn hidden(command: &mut Command) {command.creation_flags(0x08000000);}
    pub fn suspended(command: &mut Command) {command.creation_flags(0x08000004);}
}
