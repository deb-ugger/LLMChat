mod build_close;
use std::io::Cursor;
mod speech;
mod unity_offline;
mod ollama;
use std::sync::{Mutex, OnceLock};
use std::io::Write;

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
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

fn is_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".tif")
        || lower.ends_with(".tiff")
}

fn encode_rgba_png(width: usize, height: usize, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let w = u32::try_from(width).map_err(|_| "image width too large".to_string())?;
    let h = u32::try_from(height).map_err(|_| "image height too large".to_string())?;
    let expected = (width * height * 4) as usize;
    if bytes.len() < expected {
        return Err("clipboard image data incomplete".to_string());
    }
    let img = image::RgbaImage::from_raw(w, h, bytes[..expected].to_vec())
        .ok_or_else(|| "failed to build image buffer".to_string())?;
    let mut png = Vec::new();
    let mut cursor = Cursor::new(&mut png);
    img.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {e}"))?;
    Ok(png)
}

fn read_clipboard_bitmap_png() -> Result<Vec<u8>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败: {e}"))?;
    let img = clipboard
        .get_image()
        .map_err(|e| format!("剪贴板中没有位图: {e}"))?;
    encode_rgba_png(img.width, img.height, img.bytes.as_ref())
}

#[cfg(windows)]
fn read_clipboard_file_image() -> Result<Vec<u8>, String> {
    use clipboard_win::{formats, get_clipboard};

    let files: Vec<String> =
        get_clipboard(formats::FileList).map_err(|e| format!("剪贴板中没有文件: {e}"))?;
    let path = files
        .into_iter()
        .find(|p| is_image_path(p))
        .ok_or_else(|| "剪贴板文件不是图片".to_string())?;
    std::fs::read(&path).map_err(|e| format!("读取图片文件失败: {e}"))
}

#[cfg(not(windows))]
fn read_clipboard_file_image() -> Result<Vec<u8>, String> {
    Err("file clipboard image is only supported on Windows".to_string())
}

/// Read clipboard image as PNG bytes (bitmap first, then copied image file).
#[tauri::command]
async fn clipboard_read_image_png() -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(|| {
    match read_clipboard_bitmap_png() {
        Ok(png) => Ok(png),
        Err(bitmap_err) => match read_clipboard_file_image() {
            Ok(bytes) => Ok(bytes),
            Err(file_err) => Err(format!("{bitmap_err}；{file_err}")),
        },
    }.map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}

/// Write raw bytes to an absolute path chosen via the save dialog.
#[tauri::command]
fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&path, contents).map_err(|e| format!("写入文件失败: {e}"))
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
async fn finish_app_close(window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = runtime_log("shutdown-native-begin", &format!("window={}; frontend close guards accepted", window.label()));
    stop_backend(window.app_handle())?;
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
            ollama::ollama_service_start,
            ollama::ollama_service_stop,
            clipboard_read_image_png,
            write_file_bytes,
            read_file_bytes,
            file_stat,
            write_runtime_log,
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
            let _ = LOG_DIRECTORY.set(std::path::PathBuf::from(paths["data"].as_str().ok_or("Missing data storage path")?).join("logs"));
            let _ = runtime_log("startup", &format!("LLMChat started; version={}; executable={:?}; logs={:?}", env!("CARGO_PKG_VERSION"), std::env::current_exe().ok(), LOG_DIRECTORY.get()));
            app.manage(speech::SpeechStorage(std::path::PathBuf::from(paths["data"].as_str().ok_or("Missing data storage path")?)));
            let profile = paths["webview"].as_str().ok_or("Missing WebView storage path")?;
            start_backend(app.handle()).map_err(std::io::Error::other)?;
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
