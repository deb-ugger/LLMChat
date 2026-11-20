mod build_close;
mod clipboard;
mod game_image_zip;
mod style_redraw;
mod speech;
mod unity_offline;
mod ollama;
use std::sync::{Mutex, OnceLock};
use std::io::Write;

const BENCHMARK_WINDOW: &str = "game-benchmark";
const GAME_HELP_WINDOW: &str = "game-help";
const GAME_CONFIGURATION_WINDOW: &str = "game-configuration";
static WEBVIEW_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG_WRITE: Mutex<()> = Mutex::new(());

fn runtime_log(kind: &str, message: &str) -> Result<(), String> {
    let _guard = LOG_WRITE.lock().map_err(|error| error.to_string())?;
    let directory = LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join("runtime.log");
    if std::fs::metadata(&path).map(|meta| meta.len() >= 1024 * 1024).unwrap_or(false) {
        let backup = directory.join("runtime.previous.log");
        if backup.exists() { std::fs::remove_file(&backup).map_err(|error| error.to_string())?; }
        std::fs::rename(&path, backup).map_err(|error| error.to_string())?;
    }
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|error| error.to_string())?;
    writeln!(file, "{}", serde_json::json!({ "time": timestamp, "pid": std::process::id(), "kind": kind.chars().take(80).collect::<String>(), "message": message.chars().take(8000).collect::<String>() })).map_err(|error| error.to_string())
}
#[tauri::command]
fn write_runtime_log(kind: String, message: String) -> Result<(), String> { runtime_log(&kind, &message) }
#[tauri::command]
fn append_game_performance(record: serde_json::Value) -> Result<(), String> {
    let _guard = LOG_WRITE.lock().map_err(|error| error.to_string())?;
    let directory = LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut line = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    line.push(b'\n');
    std::fs::OpenOptions::new().create(true).append(true)
        .open(directory.join("game-performance.jsonl"))
        .and_then(|mut file| file.write_all(&line)).map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_game_performance(scope: String, step: String) -> Result<Vec<serde_json::Value>, String> {
    let file = LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?.join("game-performance.jsonl");
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOG_WRITE.lock().map_err(|error| error.to_string())?;
        use std::io::BufRead;
        let file = match std::fs::File::open(file) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取测试历史失败：{error}")),
        };
        let mut records = Vec::new();
        for (index, line) in std::io::BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() { continue; }
            let record: serde_json::Value = serde_json::from_str(&line).map_err(|error| format!("测试历史第 {} 行无法读取：{error}", index + 1))?;
            if record["scope"].as_str() == Some(scope.as_str()) && record["step"].as_str() == Some(step.as_str()) && record["benchmark"]["config"].is_object() {
                records.push(record);
            }
        }
        Ok(records)
    }).await.map_err(|error| error.to_string())?
}
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn open_game_benchmark_window(webview: tauri::Webview) -> Result<bool, String> {
    open_game_window(webview, BENCHMARK_WINDOW, "测试队列 · LLMChat", 930.0, 760.0)
}

#[tauri::command]
async fn open_game_aux_window(webview: tauri::Webview, kind: String) -> Result<bool, String> {
    match kind.as_str() {
        "help" => open_game_window(webview, GAME_HELP_WINDOW, "游戏翻译流程 · LLMChat", 760.0, 730.0),
        "configuration" => open_game_window(webview, GAME_CONFIGURATION_WINDOW, "测试配置 · LLMChat", 980.0, 740.0),
        _ => Err("未知的游戏翻译窗口".into()),
    }
}

fn open_game_window(webview: tauri::Webview, label: &str, title: &str, width: f64, height: f64) -> Result<bool, String> {
    // The main window can also host the embedded ComfyUI webviews.
    let window = webview.window();
    if webview.label() != "main" || window.label() != "main" {
        return Err("只能从主窗口打开游戏翻译窗口".into());
    }
    let app = window.app_handle();
    let center = |child: &tauri::WebviewWindow| -> Result<(), String> {
        let location = window.outer_position().map_err(|error| error.to_string())?;
        let main = window.outer_size().map_err(|error| error.to_string())?;
        let size = child.outer_size().map_err(|error| error.to_string())?;
        child.set_position(tauri::PhysicalPosition::new(
            location.x + (main.width as i32 - size.width as i32) / 2,
            location.y + (main.height as i32 - size.height as i32) / 2,
        )).map_err(|error| error.to_string())
    };
    if let Some(existing) = app.get_webview_window(label) {
        existing.unminimize().map_err(|error| error.to_string())?;
        if label == BENCHMARK_WINDOW { center(&existing)?; }
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    let profile = WEBVIEW_DIRECTORY.get().ok_or("窗口数据目录尚未初始化")?;
    let child = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title(title)
        .inner_size(width, height)
        .min_inner_size(520.0, 420.0)
        .resizable(true)
        .visible(false)
        .data_directory(profile.clone())
        .build().map_err(|error| error.to_string())?;
    center(&child)?;
    child.show().map_err(|error| error.to_string())?;
    child.set_focus().map_err(|error| error.to_string())?;
    Ok(true)
}

struct BackendChild(Mutex<Option<CommandChild>>);

fn start_backend(app: &AppHandle) -> Result<(), String> {
    let parent_pid = std::process::id().to_string();
    let sidecar = app
        .shell()
        .sidecar("llmchat-backend")
        .map_err(|e| e.to_string())?
        .args(["--serve", "--parent-pid", parent_pid.as_str()]);

    let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;
    let backend_pid = child.pid();
    let backend_started = std::time::Instant::now();
    let _ = runtime_log("backend-started", &format!("backend_pid={backend_pid}; parent_pid={parent_pid}"));

    {
        let state = app.state::<BackendChild>();
        *state.0.lock().unwrap() = Some(child);
    }

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                    let _ = runtime_log("backend-stderr", &format!("backend_pid={backend_pid}; {}", String::from_utf8_lossy(&line)));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[backend error] {err}");
                    let _ = runtime_log("backend-process-error", &format!("backend_pid={backend_pid}; {err}"));
                }
                CommandEvent::Terminated(payload) => {
                    let code_hex = payload.code.map(|code| format!("0x{:08X}", code as u32));
                    let _ = runtime_log("backend-terminated", &format!("backend_pid={backend_pid}; lifetime_ms={}; code_hex={code_hex:?}; {payload:?}", backend_started.elapsed().as_millis()));
                    println!("[backend] terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn stop_backend(app: &AppHandle) -> Result<(), String> {
    let started = std::time::Instant::now();
    let _ = runtime_log("backend-stop-begin", "Acquiring owned backend handle");
    let state = app.state::<BackendChild>();
    let child = state.0.lock().map_err(|error| error.to_string())?.take();
    if let Some(child) = child {
        let pid = child.pid();
        let _ = runtime_log("backend-stop-kill", &format!("backend_pid={pid}; elapsed_ms={}", started.elapsed().as_millis()));
        child.kill().map_err(|error| {
            let message = format!("停止后端进程 {pid} 失败：{error}");
            let _ = runtime_log("backend-stop-error", &message);
            message
        })?;
        let _ = runtime_log("backend-stop-requested", &format!("Termination requested for owned sidecar {pid}"));
    }
    let _ = runtime_log("backend-stop-complete", &format!("elapsed_ms={}", started.elapsed().as_millis()));
    Ok(())
}

/// Write raw bytes to an absolute path chosen via the save dialog.
#[tauri::command]
fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    write_atomic_export(std::path::Path::new(&path), |file| file.write_all(&contents))
        .map_err(|error| format!("写入文件失败：{path}：{error}"))
}

fn write_atomic_export(
    target: &std::path::Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::fs::{self, OpenOptions};
    use std::io;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_EXPORT: AtomicU64 = AtomicU64::new(0);
    let parent = target.parent().filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let (temporary, mut file) = loop {
        let sequence = NEXT_EXPORT.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(".llmchat-export-{}-{sequence}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&temporary) {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };

    let written = write(&mut file).and_then(|()| file.sync_all());
    drop(file);
    // std::fs::rename also replaces an existing file on Windows.
    if let Err(error) = written.and_then(|()| fs::rename(&temporary, target)) {
        if let Err(cleanup) = fs::remove_file(&temporary) {
            return Err(io::Error::new(error.kind(), format!(
                "{error}；无法清理临时文件 {}：{cleanup}", temporary.display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

/// Read raw bytes from an absolute path chosen via the open dialog.
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map(tauri::ipc::Response::new)
            .map_err(|e| format!("读取文件失败: {e}"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn begin_game_image_zip(id: String, path: String) -> Result<(), String> {
    game_image_zip::begin(id, path)
}

#[tauri::command]
fn append_game_image_zip(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = request.headers().get("llmchat-download-id").and_then(|value| value.to_str().ok())
        .ok_or("缺少图片下载编号")?;
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => game_image_zip::append(id, bytes),
        tauri::ipc::InvokeBody::Json(value) => {
            // WebView can switch to postMessage IPC, which sends typed arrays as JSON byte lists.
            let values = value.as_array().filter(|items| items.len() <= game_image_zip::CHUNK_LIMIT)
                .ok_or("未收到有效的图片 ZIP 分块")?;
            let bytes: Vec<_> = values.iter().map(|value| {
                value.as_u64().and_then(|byte| u8::try_from(byte).ok()).ok_or("图片 ZIP 分块包含无效字节")
            }).collect::<Result<_, _>>()?;
            game_image_zip::append(id, &bytes)
        }
    }
}

#[tauri::command]
async fn finish_game_image_zip(id: String, expected_bytes: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || game_image_zip::finish(&id, expected_bytes))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_game_image_zip(id: String) -> Result<(), String> {
    game_image_zip::cancel(&id)
}

fn exit_after_close_cleanup() -> ! {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn TerminateProcess(process: *mut std::ffi::c_void, exit_code: u32) -> i32;
        }
        // Terminate only this process, whose save guards have completed.
        // ExitProcess can itself wait on a stalled DLL teardown thread.
        TerminateProcess(GetCurrentProcess(), 0);
    }
    std::process::exit(0);
}

// WebView teardown can stall after all save guards and backend cleanup finish.
// This thread must not depend on the event loop or the runtime log mutex.
fn arm_close_watchdog() {
    static WATCHDOG: OnceLock<()> = OnceLock::new();
    WATCHDOG.get_or_init(|| {
        let directory = LOG_DIRECTORY.get().cloned();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            // Use a separate file so a stalled runtime logger cannot block exit.
            if let Some(directory) = directory {
                let path = directory.join(format!("shutdown-timeout-{}.log", std::process::id()));
                let _ = std::fs::write(path, serde_json::json!({
                    "time": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok().map(|value| value.as_millis()),
                    "pid": std::process::id(), "kind": "shutdown-timeout",
                    "message": "Save guards and backend stop completed; window/event-loop teardown exceeded 5000 ms; terminating own process"
                }).to_string());
            }
            exit_after_close_cleanup();
        });
    });
}

/// Called only after the frontend has finished its save/cancel close guards.
#[tauri::command]
async fn finish_app_close(webview: tauri::Webview) -> Result<(), String> {
    let window = webview.window();
    if webview.label() != "main" || window.label() != "main" {
        return Err("只允许主窗口退出应用".into());
    }
    let _ = runtime_log("shutdown-native-begin", &format!("window={}; frontend close guards accepted", window.label()));
    for label in [BENCHMARK_WINDOW, GAME_HELP_WINDOW, GAME_CONFIGURATION_WINDOW] {
        if let Some(child) = window.app_handle().get_webview_window(label) {
            child.destroy().map_err(|error| error.to_string())?;
        }
    }
    stop_backend(window.app_handle())?;
    game_image_zip::cancel_all()?;
    arm_close_watchdog();
    let _ = runtime_log("shutdown-request", "Save guards completed and backend stopped; closing window with a 5-second teardown deadline");
    window.destroy().map_err(|error| {
        // Tao maps PostMessageW failure to a generic runtime error. Capture the
        // thread-local Windows error before logging or any other OS operation.
        let native_error = std::io::Error::last_os_error();
        let mut windows: Vec<_> = window.app_handle().webview_windows().into_keys().collect();
        windows.sort();
        let detail = format!(
            "window={}; thread={:?}; runtime_error={error:?}; last_os_error_code={:?}; last_os_error={native_error}; registered_windows={windows:?}",
            window.label(), std::thread::current().id(), native_error.raw_os_error()
        );
        let _ = runtime_log("shutdown-destroy-error", &detail);
        #[cfg(windows)]
        if native_error.raw_os_error() == Some(1400)
            && matches!(&error, tauri::Error::Runtime(_))
        {
            // The event-loop target is invalid, so waiting cannot deliver Destroy.
            let _ = runtime_log("shutdown-invalid-window-handle", "Save guards passed and backend stop was requested; exiting after failed window dispatch");
            exit_after_close_cleanup();
        }
        error.to_string()
    })?;
    let _ = runtime_log("shutdown-destroy-queued", "Window destruction queued; waiting for Destroyed and Exit events");
    Ok(())
}

/// File metadata for path-based document sessions (size + mtime ms).
#[tauri::command]
fn file_stat(path: String) -> Result<(u64, u64), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((size, mtime_ms))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { let _ = runtime_log("rust-panic", &info.to_string()); previous_hook(info); }));
    let mut context = tauri::generate_context!();
    let window_config = context.config().app.windows[0].clone();
    // Construct the WebView only after its profile is migrated/cleaned.
    context.config_mut().app.windows[0].create = false;
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(BackendChild(Mutex::new(None)))
        .manage(ollama::OllamaChild::default())
        .invoke_handler(tauri::generate_handler![
            ollama::ollama_service_status,
            ollama::ollama_runtime_status,
            ollama::ollama_service_start,
            ollama::ollama_service_stop,
            clipboard::clipboard_read_image_png,
            write_file_bytes,
            style_redraw::run_style_redraw,
            style_redraw::find_redraw_directories,
            style_redraw::inspect_redraw_directory,
            style_redraw::prepare_redraw_ui,
            style_redraw::sync_redraw_editor,
            style_redraw::read_redraw_queue,
            style_redraw::read_redraw_thumbnail,
            style_redraw::list_redraw_workflows,
            style_redraw::read_redraw_workflow,
            style_redraw::save_redraw_workflow,
            style_redraw::submit_redraw_workflow,
            begin_game_image_zip,
            append_game_image_zip,
            finish_game_image_zip,
            cancel_game_image_zip,
            read_file_bytes,
            file_stat,
            write_runtime_log,
            append_game_performance,
            read_game_performance,
            open_game_benchmark_window,
            open_game_aux_window,
            finish_app_close,
            unity_offline::unity_offline_run,
            unity_offline::unity_offline_stop,
            speech::speech_environment,
            speech::speech_probe,
            speech::speech_create_job,
            speech::speech_list_jobs,
            speech::speech_resume_job,
            speech::speech_decode_chunk,
            speech::speech_commit_chunk,
            speech::speech_save_elapsed,
            speech::speech_cancel_job,
            speech::speech_read_result
        ])
        .setup(move |app| {
            let profile = app.path().app_local_data_dir()?;
            let command = app.shell().sidecar("llmchat-backend")?
                .args(["--prepare-storage", &profile.to_string_lossy()]);
            let output = tauri::async_runtime::block_on(command.output())?;
            if !output.status.success() {
                return Err(std::io::Error::other(String::from_utf8_lossy(&output.stderr).into_owned()).into());
            }
            let paths: serde_json::Value = serde_json::from_slice(&output.stdout)?;
            let data = std::path::PathBuf::from(paths["data"].as_str().ok_or("Missing data storage path")?);
            let _ = LOG_DIRECTORY.set(data.join("logs"));
            let _ = runtime_log("startup", &format!("LLMChat started; version={}; executable={:?}; logs={:?}", env!("CARGO_PKG_VERSION"), std::env::current_exe().ok(), LOG_DIRECTORY.get()));
            app.manage(speech::SpeechStorage(data));
            let profile = paths["webview"].as_str().ok_or("Missing WebView storage path")?;
            start_backend(app.handle()).map_err(std::io::Error::other)?;
            let _ = WEBVIEW_DIRECTORY.set(std::path::PathBuf::from(profile));
            let mut config = window_config.clone();
            config.create = true;
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .data_directory(std::path::PathBuf::from(profile))
                .build()?;
            build_close::install(app.handle())?;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { .. }, .. } => {
                    let _ = runtime_log("shutdown-native-close-requested", &format!("window={label}; event_loop_thread={:?}", std::thread::current().id()));
                }
                RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } => {
                    let mut windows: Vec<_> = app_handle.webview_windows().into_keys().collect();
                    windows.sort();
                    let _ = runtime_log("shutdown-window-destroyed", &format!("window={label}; event_loop_thread={:?}; remaining_windows={windows:?}", std::thread::current().id()));
                    if windows.is_empty() {
                        let _ = stop_backend(app_handle);
                        app_handle.exit(0);
                    }
                }
                RunEvent::ExitRequested { code, .. } => { let _ = runtime_log("shutdown-exit-requested", &format!("code={code:?}")); },
                RunEvent::Exit => { let _ = runtime_log("shutdown", "Normal event-loop exit"); let _ = stop_backend(app_handle); },
                _ => {}
            }
        });
}
