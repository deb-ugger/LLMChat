use std::io::Write;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn unity_offline_run(app: AppHandle, action: String, request: serde_json::Value) -> Result<serde_json::Value, String> {
    if !["scan", "load", "save", "export"].contains(&action.as_str()) {
        return Err("未知嵌字操作".into());
    }
    let helper = app.path().resource_dir().map_err(|e| e.to_string())?
        .join("resources").join("unity").join("llmchat-unity.exe");
    if !helper.is_file() {
        return Err("缺少嵌字组件，请先运行 scripts/prepare-unity-tools.ps1 并重新构建软件。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(helper);
        command.args([action, std::process::id().to_string()])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| format!("无法启动嵌字组件：{e}"))?;
        let input = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        // Drain output while sending a potentially large saved project to avoid a full pipe.
        let mut stdin = child.stdin.take().ok_or("无法打开组件输入")?;
        let send = std::thread::spawn(move || stdin.write_all(&input));
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        send.join().map_err(|_| "写入嵌字请求失败")?.map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        serde_json::from_slice(&output.stdout).map_err(|e| format!("嵌字组件响应无效：{e}"))
    }).await.map_err(|e| e.to_string())?
}
