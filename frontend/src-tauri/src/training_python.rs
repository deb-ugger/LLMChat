use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};

#[derive(Clone, Deserialize, Serialize)]
pub struct TrainingPython {
    pub path: String,
    pub version: String,
    pub torch: String,
    pub torchvision: String,
    pub pillow: String,
    pub numpy: String,
    pub issues: Vec<String>,
}

fn output(mut command: Command) -> Result<Vec<u8>, String> {
    crate::train_dataset::win::hidden(&mut command);
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let read = |mut pipe: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    });
    let stdout = read(Box::new(child.stdout.take().unwrap()));
    let stderr = read(Box::new(child.stderr.take().unwrap()));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("解释器检查超过 20 秒，请确认该路径可正常启动".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let bytes = stdout.join().map_err(|_| "无法读取 Python 输出")?;
    let errors = stderr.join().map_err(|_| "无法读取 Python 错误")?;
    if !status.success() { return Err(String::from_utf8_lossy(&errors).trim().to_owned()); }
    Ok(bytes)
}

pub fn inspect(path: &Path) -> Result<TrainingPython, String> {
    let script = r#"
import json, sys, struct
if not (3,10) <= sys.version_info[:2] <= (3,12):
    raise RuntimeError('所选解释器是 Python ' + sys.version.split()[0] + '；当前训练环境支持 Python 3.10–3.12，请安装 3.12 或更早的受支持版本')
if struct.calcsize('P') != 8:
    raise RuntimeError('需要 64 位 Python 3.10–3.12')
import venv
result = {'path':sys.executable,'version':sys.version.split()[0],'torch':'','torchvision':'','pillow':'','numpy':'','issues':[]}
for name, field in [('torch','torch'),('torchvision','torchvision'),('PIL','pillow'),('numpy','numpy')]:
    try:
        result[field] = str(__import__(name).__version__)
    except Exception as error:
        result['issues'].append(name + ': ' + str(error))
print(json.dumps(result, ensure_ascii=False))
"#;
    let mut command = Command::new(path);
    command.args(["-X", "utf8", "-c", script]);
    let bytes = output(command)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn matches(python: &TrainingPython) -> bool {
    python.issues.is_empty() && python.torch == "2.6.0+cpu"
        && python.torchvision == "0.21.0+cpu"
        && python.pillow.split('.').next().and_then(|v|v.parse::<u32>().ok()).is_some_and(|v|v>=10)
        && python.numpy.split('.').next().and_then(|v|v.parse::<u32>().ok()).is_some_and(|v|v>=2 || (v==1 && python.numpy.split('.').nth(1).and_then(|v|v.parse::<u32>().ok()).is_some_and(|v|v>=26)))
}

fn common_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for base in [std::env::var_os("LOCALAPPDATA").map(|p|PathBuf::from(p).join("Programs/Python")), Some(PathBuf::from("C:/"))].into_iter().flatten() {
        if let Ok(entries) = fs::read_dir(base) {
            let mut folders = entries.flatten().filter(|entry|entry.file_name().to_string_lossy().starts_with("Python3")).map(|entry|entry.path()).collect::<Vec<_>>();
            folders.sort();
            paths.extend(folders.into_iter().map(|folder|folder.join("python.exe")));
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        for name in ["anaconda3", "miniconda3"] { paths.push(PathBuf::from(&profile).join(name).join("python.exe")); }
    }
    paths
}

pub fn discover(configured: Option<&str>) -> Result<TrainingPython, String> {
    if let Some(path) = configured.map(str::trim).filter(|path|!path.is_empty()) {
        return inspect(Path::new(path)).map_err(|cause| format!("指定的训练 Python 不可用：{path}。{cause}"));
    }
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("LLMCHAT_TRAINING_PYTHON").filter(|path|!path.is_empty()) { candidates.push(PathBuf::from(path)); }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in ["python.exe", "python3.exe"] {
                let path = directory.join(name);
                if path.is_file() { candidates.push(path); }
            }
        }
    }
    let path_count = candidates.len();
    let mut launcher = Command::new("py");
    launcher.args(["-3", "-c", "import sys;print(sys.executable)"]);
    if let Ok(bytes) = output(launcher) {
        let path = String::from_utf8_lossy(&bytes).trim().to_owned();
        if !path.is_empty() { candidates.push(PathBuf::from(path)); }
    }
    candidates.extend(common_candidates());
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for (index, path) in candidates.into_iter().enumerate() {
        if index >= path_count && !path.is_file() { continue; }
        if !seen.insert(path.to_string_lossy().to_lowercase()) { continue; }
        match inspect(&path) {
            Ok(python) => return Ok(python),
            Err(cause) => { if failures.len() < 5 { failures.push(format!("{}：{cause}", path.display())); } }
        }
    }
    if failures.is_empty() {
        Err("本机没有找到可用的 Python。安装 Python 3.10–3.12，或在设置中填入现有解释器路径。".into())
    } else {
        Err(format!("未找到可用于训练的 Python。已检查的候选（最多 5 条）：\n{}", failures.join("\n")))
    }
}
