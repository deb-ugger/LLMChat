use std::{io::{Read, Write}, net::{IpAddr, SocketAddr, TcpStream}, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Default)]
pub struct OllamaChild(Mutex<Option<(SocketAddr, Child)>>);

fn address(host: &str, port: u16) -> Result<SocketAddr, String> {
    let ip: IpAddr = if host == "localhost" { "127.0.0.1".parse().unwrap() } else { host.parse().map_err(|_| "只能管理本机 Ollama 服务")? };
    if !ip.is_loopback() || port == 0 { return Err("只能管理本机 Ollama 服务".into()); }
    Ok(SocketAddr::new(ip, port))
}
fn probe(address: SocketAddr) -> Result<bool, String> {
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
        Ok(stream) => stream,
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => return Ok(false),
        Err(error) => return Err(format!("无法检查 Ollama 服务：{error}")),
    };
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    write!(stream, "GET /api/version HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream.take(16384).read_to_string(&mut response).map_err(|e| e.to_string())?;
    let (head, body) = response.split_once("\r\n\r\n").ok_or("服务返回了无效 HTTP 响应")?;
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| "端口已被其他服务占用，未识别为 Ollama")?;
    if !head.lines().next().unwrap_or("").contains(" 200 ") || !value["version"].is_string() { return Err("端口已被其他服务占用，未识别为 Ollama".into()); }
    Ok(true)
}
fn hidden(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.stdin(Stdio::null());
}
fn executable(models: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(models);
    let mut paths = if models.is_empty() { Vec::new() } else { vec![root.join("ollama.exe")] };
    if let Some(parent) = root.parent() { paths.push(parent.join("ollama.exe")); }
    for name in ["LOCALAPPDATA", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(name) {
            paths.push(PathBuf::from(&base).join("Ollama/ollama.exe"));
            paths.push(PathBuf::from(base).join("Programs/Ollama/ollama.exe"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&path).map(|path| path.join("ollama.exe"))); }
    paths.into_iter().find(|path| path.is_file()).ok_or("未找到 ollama.exe，请安装 Ollama 并将其加入 PATH，或将程序放在模型目录的上一级目录".into())
}

#[tauri::command]
pub async fn ollama_service_status(host: String, port: u16) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || probe(address(&host, port)?)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ollama_service_start(app: AppHandle, host: String, port: u16, models: String, proxy_enabled: bool, proxy_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let address = address(&host, port)?;
        if probe(address)? { return Ok(()); }
        if proxy_enabled && (!(proxy_url.starts_with("http://") || proxy_url.starts_with("https://")) || proxy_url.chars().any(char::is_whitespace)) { return Err("代理地址需为完整的 HTTP 或 HTTPS 地址".into()); }
        if !models.is_empty() && !PathBuf::from(&models).join("manifests").is_dir() && !PathBuf::from(&models).join("blobs").is_dir() { return Err("模型目录已失效，请重新选择".into()); }
        let state = app.state::<OllamaChild>();
        let mut owned = state.0.lock().map_err(|e| e.to_string())?;
        let log_directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&log_directory).map_err(|e| e.to_string())?;
        let log = log_directory.join("ollama-service.log");
        let output = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
        let mut command = Command::new(executable(&models)?);
        command.arg("serve").env("OLLAMA_HOST", address.to_string()).env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env_remove("HTTP_PROXY").env_remove("HTTPS_PROXY").env_remove("ALL_PROXY")
            .stdout(output.try_clone().map_err(|e| e.to_string())?).stderr(output);
        if !models.is_empty() { command.env("OLLAMA_MODELS", &models); }
        if proxy_enabled { command.env("HTTPS_PROXY", &proxy_url); }
        hidden(&mut command);
        let mut child = command.spawn().map_err(|e| format!("启动 Ollama 失败：{e}"))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Err(format!("Ollama 启动后退出（{status}），日志：{}", log.display())); }
            if probe(address).unwrap_or(false) { *owned = Some((address, child)); return Ok(()); }
            if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(format!("Ollama 启动后未就绪，日志：{}", log.display())); }
            std::thread::sleep(Duration::from_millis(200));
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ollama_service_stop(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let address = address(&host, port)?;
        if !probe(address)? { return Ok(()); }
        let state = app.state::<OllamaChild>();
        let mut owned = state.0.lock().map_err(|e| e.to_string())?;
        let stopped_owned = if let Some((_, child)) = owned.as_mut().filter(|(host, _)| *host == address) {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() { child.kill().map_err(|e| e.to_string())?; child.wait().map_err(|e| e.to_string())?; true } else { false }
        } else { false };
        if stopped_owned { *owned = None; } else {
            // Only the listener on this port, with Ollama's executable and serve command, may be stopped.
            let script = format!("$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -LocalPort {port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); $stopped=0; foreach($processId in $ids) {{ $p=Get-CimInstance Win32_Process -Filter \"ProcessId = $processId\"; if ([IO.Path]::GetFileName($p.ExecutablePath) -ieq 'ollama.exe' -and $p.CommandLine -match '(?i)\\bserve\\b') {{ Stop-Process -Id $processId -ErrorAction Stop; $stopped++ }} }}; if (!$stopped) {{ throw '未能验证 Ollama 服务进程，请从 Ollama 托盘退出服务' }}");
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", &script]); hidden(&mut command);
            let output = command.output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err(format!("关闭 Ollama 失败：{}", String::from_utf8_lossy(&output.stderr))); }
        }
        for _ in 0..25 { if !probe(address)? { return Ok(()); } std::thread::sleep(Duration::from_millis(200)); }
        Err("服务仍在运行，可能被 Ollama 托盘重新启动，请从托盘退出".into())
    }).await.map_err(|e| e.to_string())?
}
