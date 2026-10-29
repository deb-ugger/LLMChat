use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

fn stop_file(operation_id: &str) -> Result<std::path::PathBuf, String> {
    if operation_id.len() != 36 || !operation_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("无效嵌字任务标识".into()); }
    Ok(std::env::temp_dir().join(format!("llmchat-unity-{operation_id}.stop")))
}

#[tauri::command]
pub fn unity_offline_stop(operation_id: String) -> Result<(), String> {
    std::fs::write(stop_file(&operation_id)?, b"stop").map_err(|e| format!("无法中止嵌字任务：{e}"))
}

#[tauri::command]
pub async fn unity_offline_run(app: AppHandle, action: String, mut request: serde_json::Value, on_progress: tauri::ipc::Channel<serde_json::Value>, operation_id: Option<String>) -> Result<serde_json::Value, String> {
    if !["workspace", "resume-info", "save-task", "reset-step", "finish-rescan", "find", "inspect", "font-plan", "scan", "load", "save", "save-image", "preview-image", "export", "apply", "uninstall", "installation-status"].contains(&action.as_str()) {
        return Err("未知嵌字操作".into());
    }
    let helper = app.path().resource_dir().map_err(|e| e.to_string())?
        .join("resources").join("unity").join("llmchat-unity.exe");
    if !helper.is_file() {
        return Err("缺少嵌字组件，请先运行 scripts/prepare-unity-tools.ps1 并重新构建软件。".into());
    }
    let stop = operation_id.map(|id| stop_file(&id)).transpose()?;
    if let Some(path) = &stop { request["stopFile"] = serde_json::json!(path); }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(helper);
        command.args([action, std::process::id().to_string()])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.arg("--progress");
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("无法启动嵌字组件：{e}"))?;
        let input = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        // Drain output while sending a potentially large saved project to avoid a full pipe.
        let mut stdin = child.stdin.take().ok_or("无法打开组件输入")?;
        let send = std::thread::spawn(move || stdin.write_all(&input));
        let stderr = child.stderr.take().ok_or("无法打开组件进度输出")?;
        let progress = std::thread::spawn(move || -> Result<String, String> {
            let mut errors = Vec::new();
            for line in BufReader::new(stderr).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if let Some(json) = line.strip_prefix("LLMCHAT_PROGRESS ") {
                    let value = serde_json::from_str(json).map_err(|e| format!("嵌字进度无效：{e}"))?;
                    let _ = on_progress.send(value);
                } else { errors.push(line); }
            }
            Ok(errors.join("\n"))
        });
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        send.join().map_err(|_| "写入嵌字请求失败")?.map_err(|e| e.to_string())?;
        let errors = progress.join().map_err(|_| "读取嵌字进度失败")??;
        if !output.status.success() {
            return Err(errors);
        }
        serde_json::from_slice(&output.stdout).map_err(|e| format!("嵌字组件响应无效：{e}"))
    }).await;
    if let Some(path) = stop { let _ = std::fs::remove_file(path); }
    result.map_err(|e| e.to_string())?
}
