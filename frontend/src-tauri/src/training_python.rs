use crate::training_diagnostics::{record, TrainingFailure};
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

struct ProcessOutput { success: bool, stdout: Vec<u8>, stderr: Vec<u8> }

fn output(mut command: Command) -> Result<ProcessOutput, TrainingFailure> {
    let program = command.get_program().to_string_lossy().into_owned();
    crate::train_dataset::win::hidden(&mut command);
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| record(format!("{program} 无法启动，请确认解释器路径是否正确"), e.to_string()))?;
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
            let bytes = stdout.join().unwrap_or_default();
            let errors = stderr.join().unwrap_or_default();
            return Err(record(format!("{program} 检查超过 20 秒，请确认该路径可正常启动"),
                format!("{}\n{}", String::from_utf8_lossy(&errors), String::from_utf8_lossy(&bytes))));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let bytes = stdout.join().map_err(|_| "无法读取 Python 输出")?;
    let errors = stderr.join().map_err(|_| "无法读取 Python 错误")?;
    Ok(ProcessOutput { success: status.success(), stdout: bytes, stderr: errors })
}

pub fn inspect(path: &Path) -> Result<TrainingPython, TrainingFailure> {
    let script = r#"
import json, sys, struct
def reject(kind, message):
    print(json.dumps({'failure':kind, 'path':sys.executable, 'version':sys.version.split()[0]}), flush=True)
    raise RuntimeError(message)
if not (3,10) <= sys.version_info[:2] <= (3,12):
    reject('version', '所选解释器是 Python ' + sys.version.split()[0] + '；当前训练环境支持 Python 3.10–3.12，请安装 3.12 或更早的受支持版本')
if struct.calcsize('P') != 8:
    reject('architecture', '需要 64 位 Python 3.10–3.12')
try:
    import venv
except Exception:
    print(json.dumps({'failure':'venv', 'path':sys.executable, 'version':sys.version.split()[0]}), flush=True)
    raise
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
    let result = output(command)?;
    let metadata = serde_json::from_slice::<serde_json::Value>(&result.stdout);
    if !result.success {
        let version = metadata.as_ref().ok().and_then(|value|value["version"].as_str()).unwrap_or("未知版本");
        let kind = metadata.as_ref().ok().and_then(|value|value["failure"].as_str()).unwrap_or("process");
        let path = path.to_string_lossy().replace('\\', "/");
        let message = match kind {
            "version" => format!("{path} 是 Python {version}，不受支持；训练需要 3.10–3.12，请安装 3.12 或更早版本"),
            "architecture" => format!("{path} 是 Python {version}，位数不受支持；请安装 64 位 Python 3.10–3.12"),
            "venv" => format!("{path} 是 Python {version}，缺少 venv；请安装包含 venv 的 Python 3.10–3.12"),
            _ => format!("{path} 无法完成环境检查，请确认它是支持 venv 的 Python 3.10–3.12"),
        };
        return Err(record(message, String::from_utf8_lossy(&result.stderr).into_owned()));
    }
    serde_json::from_slice(&result.stdout).map_err(|_| record(
        format!("{} 未返回有效的 Python 环境信息，请确认解释器路径", path.display()),
        format!("{}\n{}", String::from_utf8_lossy(&result.stderr), String::from_utf8_lossy(&result.stdout))))
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

pub fn discover(configured: Option<&str>) -> Result<TrainingPython, TrainingFailure> {
    if let Some(path) = configured.map(str::trim).filter(|path|!path.is_empty()) {
        return inspect(Path::new(path));
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
    if let Ok(result) = output(launcher) {
        if result.success {
            let path = String::from_utf8_lossy(&result.stdout).trim().to_owned();
            if !path.is_empty() { candidates.push(PathBuf::from(path)); }
        }
    }
    candidates.extend(common_candidates());
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for (index, path) in candidates.into_iter().enumerate() {
        if index >= path_count && !path.is_file() { continue; }
        if !seen.insert(path.to_string_lossy().to_lowercase()) { continue; }
        match inspect(&path) {
            Ok(python) => return Ok(python),
            Err(cause) => { if failures.len() < 5 { failures.push(cause); } }
        }
    }
    if failures.is_empty() {
        Err("本机没有找到可用的 Python。安装 Python 3.10–3.12，或在设置中填入现有解释器路径。".into())
    } else {
        let message = failures.iter().map(|failure|failure.message.as_str()).collect::<Vec<_>>().join("；");
        let raw = failures.iter().map(|failure|failure.raw_output.as_str()).collect::<Vec<_>>().join("\n");
        Err(record(format!("未找到可用于训练的 Python；已检查的候选：{message}"), raw))
    }
}
