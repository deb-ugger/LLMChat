use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::Channel;

static RENDER: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn run_style_redraw(directory: String, image: String, steps: u32,
                              regions: serde_json::Value, mode: String, profile: serde_json::Value, progress: Channel<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _active = RENDER.try_lock().map_err(|_| "已有 AI 风格重绘任务正在运行")?;
        let root = PathBuf::from(&directory);
        let python = root.join("python_embeded/python.exe");
        if !root.is_absolute() || !python.is_file() || !root.join("ComfyUI/main.py").is_file() {
            return Err("请选择含 ComfyUI 和 python_embeded 的便携版目录".into());
        }
        let mut command = Command::new(python);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .args(["-X", "utf8", "-u", "-c", include_str!("style_redraw.py")])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("无法启动重绘任务：{e}"))?;
        let mut errors = child.stderr.take().unwrap();
        let diagnostics = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = errors.read_to_string(&mut text);
            text
        });
        let payload = serde_json::json!({ "directory": directory, "image": image, "steps": steps, "regions": regions, "mode": mode, "profile": profile });
        let mut execute = || -> Result<serde_json::Value, String> {
            let mut input = child.stdin.take().unwrap();
            serde_json::to_writer(&mut input, &payload).map_err(|e| e.to_string())?;
            input.flush().map_err(|e| e.to_string())?;
            drop(input);
            for line in BufReader::new(child.stdout.take().unwrap()).lines() {
                let event: serde_json::Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                if event["type"] == "result" && event["value"]["image"].is_string() { return Ok(event["value"].clone()); }
                let value = event["value"].as_str().ok_or("重绘任务返回无效数据")?;
                match event["type"].as_str() {
                    Some("status") => { let _ = progress.send(value.to_owned()); }
                    Some("error") => return Err(value.to_owned()),
                    _ => return Err("未知重绘任务消息".into()),
                }
            }
            Err("重绘进程结束，未收到图片".into())
        };
        let result = execute();
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr = diagnostics.join().unwrap_or_default();
        if !status.success() && !stderr.trim().is_empty() {
            return Err(format!("重绘进程失败：{}", stderr.trim()));
        }
        result
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn missing_redraw_weights(directory: String, model: String, clip: String, vae: String) -> Vec<String> {
    let root = PathBuf::from(directory).join("ComfyUI/models");
    let mut missing = Vec::new();
    for (file, folders) in [(model, &["unet", "diffusion_models"][..]), (clip, &["clip", "text_encoders"][..]), (vae, &["vae"][..])] {
        if !file.is_empty() && !folders.iter().any(|dir| root.join(dir).join(&file).is_file()) { missing.push(file); }
    }
    missing
}
