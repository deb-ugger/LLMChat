use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::ipc::Channel;

static RUNNING: Mutex<()> = Mutex::new(());

fn source_checkout() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    executable
        .ancestors()
        .chain(Path::new(env!("CARGO_MANIFEST_DIR")).ancestors())
        .find(|path| {
            path.join("scripts/build-speed-test.ps1").is_file()
                && path.join("frontend/src-tauri/Cargo.toml").is_file()
        })
        .map(Path::to_path_buf)
        .ok_or_else(|| "需要在带源码的 LLMChat 构建目录使用构建测速。".to_string())
}

#[tauri::command]
pub async fn run_build_speed_test(
    progress: Channel<String>,
    tests: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = RUNNING.try_lock().map_err(|_| "构建测速正在运行")?;
        let root = source_checkout()?;
        let mut command = Command::new("powershell.exe");
        command
            .current_dir(&root)
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(root.join("scripts/build-speed-test.ps1"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(tests) = tests {
            if tests.is_empty() {
                return Err("请选择构建测试项。".to_string());
            }
            command.arg("-Tests").arg(tests.join(","));
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| format!("无法启动构建测速：{error}"))?;
        let mut stderr = child.stderr.take().unwrap();
        let errors = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).trim().to_owned()
        });
        let mut result = None;
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            if let Some(phase) = line.strip_prefix("PROGRESS ") {
                let _ = progress.send(phase.to_owned());
            } else if let Some(value) = line.strip_prefix("RESULT ") {
                result = Some(serde_json::from_str(value));
            }
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        let message = errors.join().unwrap_or_default();
        if !status.success() {
            return Err(if message.is_empty() { format!("构建测速失败（{status}）") } else { message });
        }
        result.ok_or_else(|| "构建测速未返回结果".to_string())?.map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}
