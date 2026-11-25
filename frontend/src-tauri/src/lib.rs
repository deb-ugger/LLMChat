mod build_close;
mod build_speed_test;
mod train_dataset;
mod training_python;
mod training_diagnostics;
mod training_storage;
mod training_environment;
mod training_results;
mod clipboard;
mod game_image_zip;
mod style_redraw;
mod speech;
mod unity_offline;
mod ollama;
use std::sync::{Mutex, OnceLock};
use std::io::Write;

#[cfg(windows)]
mod window_frame {
    use std::{cell::Cell, mem::size_of};
    use tauri::{PhysicalPosition, PhysicalSize, Rect, Webview};
    use windows::core::w;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{
            ClientToScreen, GetMonitorInfoW, IntersectRect, MonitorFromRect, ValidateRect, MONITORINFO,
            MONITOR_DEFAULTTONEAREST,
        },
        UI::{
            HiDpi::GetDpiForWindow,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, GetClientRect, GetWindowLongW, GetWindowRect,
                IsIconic, IsZoomed, PostMessageW, SetWindowLongW, SetWindowPos, ShowWindow,
                GWL_STYLE, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP,
                HTTOPLEFT, HTTOPRIGHT, HTTRANSPARENT, HWND_TOP, NCCALCSIZE_PARAMS, SWP_FRAMECHANGED,
                SWP_NOACTIVATE, SWP_NOSENDCHANGING, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
                WM_ACTIVATE, WM_APP, WM_DPICHANGED, WM_ERASEBKGND, WM_NCCALCSIZE,
                WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_PAINT, WM_SIZE, WS_CAPTION,
                WS_CHILD, WS_EX_TRANSPARENT, WS_THICKFRAME,
            },
        },
    };

    const SUBCLASS_ID: usize = 1;
    const SYNC_LAYOUT: u32 = WM_APP + 0x347;

    struct Frame {
        grips: [HWND; 4],
        webview: Webview,
        layout_pending: Cell<bool>,
    }

    pub fn install(hwnd: HWND, webview: Webview) -> std::io::Result<()> {
        // Tauri's setup callback runs on the thread that owns the main window.
        unsafe {
            let mut grips = [HWND::default(); 4];
            let result = (|| {
                // The WebView covers the client area. Paint-free edge windows keep the
                // visible resize handles above it while preserving the restored DWM frame.
                for grip in &mut grips {
                    *grip = CreateWindowExW(
                        WS_EX_TRANSPARENT, w!("STATIC"), w!(""), WS_CHILD, 0, 0, 0, 0,
                        Some(hwnd), None, None, None,
                    ).map_err(std::io::Error::other)?;
                    if !SetWindowSubclass(*grip, Some(grip_proc), SUBCLASS_ID, hwnd.0 as usize).as_bool() {
                        return Err(std::io::Error::other("无法安装窗口缩放热区"));
                    }
                }
                let mut frame = Box::new(Frame { grips, webview, layout_pending: Cell::new(false) });
                let data = std::ptr::from_mut(frame.as_mut()) as usize;
                if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, data).as_bool() {
                    return Err(std::io::Error::other("无法安装主窗口边框处理"));
                }
                let _ = Box::into_raw(frame);
                place_grips(hwnd, &grips);
                Ok(())
            })();
            if result.is_err() {
                for grip in grips.into_iter().filter(|grip| !grip.0.is_null()) {
                    let _ = DestroyWindow(grip);
                }
            }
            result
        }
    }

    unsafe extern "system" fn grip_proc(
        hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, id: usize, parent: usize,
    ) -> LRESULT {
        unsafe {
            match msg {
                WM_NCHITTEST => {
                    let owner = HWND(parent as _);
                    let hit = can_resize(owner).then(|| resize_hit(owner, lparam)).flatten();
                    return LRESULT(hit.map_or(HTTRANSPARENT as isize, |value| value as isize));
                }
                WM_NCLBUTTONDOWN => {
                    let _ = PostMessageW(Some(HWND(parent as _)), msg, wparam, lparam);
                    return LRESULT(0);
                }
                WM_ERASEBKGND => return LRESULT(1),
                WM_PAINT => {
                    let _ = ValidateRect(Some(hwnd), None);
                    return LRESULT(0);
                }
                WM_NCDESTROY => {
                    let _ = RemoveWindowSubclass(hwnd, Some(grip_proc), id);
                }
                _ => {}
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
    }

    fn can_resize(hwnd: HWND) -> bool {
        unsafe {
            !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool()
                && GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_THICKFRAME.0 != 0
        }
    }

    fn grip_size(hwnd: HWND) -> i32 {
        ((8 * unsafe { GetDpiForWindow(hwnd) } + 48) / 96) as i32
    }

    fn place_grips(hwnd: HWND, grips: &[HWND; 4]) {
        unsafe {
            if !can_resize(hwnd) {
                for &grip in grips {
                    let _ = ShowWindow(grip, SW_HIDE);
                }
                return;
            }
            let mut client = RECT::default();
            if GetClientRect(hwnd, &mut client).is_err() || client.right <= 0 || client.bottom <= 0 {
                return;
            }
            let width = client.right;
            let height = client.bottom;
            let edge = grip_size(hwnd).min(width / 2).min(height / 2);
            let middle = height - 2 * edge;
            let areas = [
                (0, 0, width, edge),
                (0, edge, edge, middle),
                (width - edge, edge, edge, middle),
                (0, height - edge, width, edge),
            ];
            for (&grip, (x, y, width, height)) in grips.iter().zip(areas) {
                let _ = SetWindowPos(grip, Some(HWND_TOP), x, y, width, height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW);
            }
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, subclass_id: usize, data: usize,
    ) -> LRESULT {
        unsafe {
            let frame = &*(data as *const Frame);
            match msg {
                SYNC_LAYOUT => {
                    if IsZoomed(hwnd).as_bool() {
                        fit_maximized_window(hwnd);
                    }
                    frame.layout_pending.set(false);
                    if !IsIconic(hwnd).as_bool() {
                        sync_webview(hwnd, &frame.webview);
                    }
                    return LRESULT(0);
                }
                WM_NCCALCSIZE if wparam.0 != 0 && lparam.0 != 0 && IsZoomed(hwnd).as_bool() => {
                    let params = lparam.0 as *mut NCCALCSIZE_PARAMS;
                    let window_rect = (*params).rgrc[0];
                    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                    // Keep Tao's work-area and auto-hide taskbar insets. The client must
                    // also fit the proposed window rectangle once the DWM frame is removed.
                    let mut client = RECT::default();
                    if IntersectRect(&mut client, &window_rect, &(*params).rgrc[0]).as_bool() {
                        (*params).rgrc[0] = client;
                    }
                    if work_area(&window_rect).is_some_and(|work| work != window_rect) {
                        // Reposition after Windows commits the current non-client calculation.
                        request_layout_sync(hwnd, frame);
                    }
                    return result;
                }
                WM_SIZE | WM_DPICHANGED | WM_ACTIVATE => {
                    let grips = frame.grips;
                    if msg != WM_ACTIVATE {
                        request_layout_sync(hwnd, frame);
                    }
                    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                    place_grips(hwnd, &grips);
                    return result;
                }
                WM_NCHITTEST if can_resize(hwnd) => {
                    if let Some(hit) = resize_hit(hwnd, lparam) {
                        return LRESULT(hit as isize);
                    }
                }
                WM_NCDESTROY => {
                    let _ = RemoveWindowSubclass(hwnd, Some(window_proc), subclass_id);
                    drop(Box::from_raw(data as *mut Frame));
                }
                _ => {}
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
    }

    fn request_layout_sync(hwnd: HWND, frame: &Frame) {
        if !frame.layout_pending.replace(true)
            && unsafe { PostMessageW(Some(hwnd), SYNC_LAYOUT, WPARAM(0), LPARAM(0)) }.is_err()
        {
            frame.layout_pending.set(false);
        }
    }

    fn sync_webview(hwnd: HWND, webview: &Webview) {
        let mut client = RECT::default();
        if unsafe { GetClientRect(hwnd, &mut client) }.is_err() || client.right <= 0 || client.bottom <= 0 {
            return;
        }
        // The final outer-frame correction can leave the client size unchanged and
        // thus emit no further WM_SIZE for Wry. Explicitly resize its host and controller.
        let bounds = Rect {
            position: PhysicalPosition::new(0, 0).into(),
            size: PhysicalSize::new(client.right as u32, client.bottom as u32).into(),
        };
        if let Err(error) = webview.set_bounds(bounds) {
            let _ = super::runtime_log("window-webview-layout-error", &error.to_string());
        }
    }

    fn work_area(window_rect: &RECT) -> Option<RECT> {
        let monitor = unsafe { MonitorFromRect(window_rect, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool().then_some(info.rcWork)
    }

    fn fit_maximized_window(hwnd: HWND) {
        let mut current = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut current) }.is_err() {
            return;
        }
        let Some(work) = work_area(&current) else { return };
        if current == work {
            return;
        }

        unsafe {
            // Tao hides the drawn caption but keeps WS_CAPTION. Windows adds the
            // invisible maximized frame unless that style is cleared during repositioning.
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            let caption = style & WS_CAPTION.0 as i32;
            if caption != 0 && SetWindowLongW(hwnd, GWL_STYLE, style & !caption) == 0 {
                return;
            }
            let _ = SetWindowPos(
                hwnd, None, work.left, work.top, work.right - work.left, work.bottom - work.top,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOSENDCHANGING | SWP_NOZORDER,
            );
            if caption != 0 {
                let style = GetWindowLongW(hwnd, GWL_STYLE);
                let _ = SetWindowLongW(hwnd, GWL_STYLE, style | caption);
            }
        }
    }

    fn resize_hit(hwnd: HWND, lparam: LPARAM) -> Option<u32> {
        // Signed screen coordinates also work on monitors to the left or above the primary.
        let x = lparam.0 as i16 as i32;
        let y = (lparam.0 >> 16) as i16 as i32;
        let mut frame = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut frame) }.is_err() {
            return None;
        }
        if !(frame.left..frame.right).contains(&x) || !(frame.top..frame.bottom).contains(&y) {
            return None;
        }
        let mut client = RECT::default();
        let mut origin = POINT::default();
        if unsafe { GetClientRect(hwnd, &mut client) }.is_err()
            || !unsafe { ClientToScreen(hwnd, &mut origin) }.as_bool()
            || client.right <= 0 || client.bottom <= 0
        {
            return None;
        }
        // The outer rectangle includes the invisible DWM frame. Measure the
        // accessible edge from the client origin so all 8 logical pixels can be used.
        let edge = grip_size(hwnd).min(client.right / 2).min(client.bottom / 2);
        let col = if x < origin.x + edge { -1 } else if x >= origin.x + client.right - edge { 1 } else { 0 };
        let row = if y < origin.y + edge { -1 } else if y >= origin.y + client.bottom - edge { 1 } else { 0 };

        match (col, row) {
            (-1, -1) => Some(HTTOPLEFT),
            (1, -1) => Some(HTTOPRIGHT),
            (-1, 1) => Some(HTBOTTOMLEFT),
            (1, 1) => Some(HTBOTTOMRIGHT),
            (-1, 0) => Some(HTLEFT),
            (1, 0) => Some(HTRIGHT),
            (0, -1) => Some(HTTOP),
            (0, 1) => Some(HTBOTTOM),
            _ => None,
        }
    }
}

const BENCHMARK_WINDOW: &str = "game-benchmark";
const GAME_HELP_WINDOW: &str = "game-help";
const GAME_CONFIGURATION_WINDOW: &str = "game-configuration";
const GAME_BENCHMARK_REVIEW_WINDOW: &str = "game-benchmark-review";
static WEBVIEW_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG_DIRECTORY: OnceLock<std::path::PathBuf> = OnceLock::new();
static LOG_WRITE: Mutex<()> = Mutex::new(());
static SYSTEM_PERFORMANCE_BACKEND: OnceLock<(reqwest::Client, String)> = OnceLock::new();

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
#[cfg(windows)]
fn onnx_memory_snapshot() -> String {
    #[repr(C)]
    #[derive(Default)]
    struct PerformanceInformation {
        size: u32,
        commit_total: usize,
        commit_limit: usize,
        commit_peak: usize,
        physical_total: usize,
        physical_available: usize,
        system_cache: usize,
        kernel_total: usize,
        kernel_paged: usize,
        kernel_nonpaged: usize,
        page_size: usize,
        handle_count: u32,
        process_count: u32,
        thread_count: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn K32GetPerformanceInfo(info: *mut PerformanceInformation, length: u32) -> i32;
    }

    let size = std::mem::size_of::<PerformanceInformation>() as u32;
    let mut info = PerformanceInformation { size, ..Default::default() };
    if unsafe { K32GetPerformanceInfo(&mut info, size) } == 0 {
        return format!("memory_snapshot_error={}", std::io::Error::last_os_error());
    }

    let bytes = |pages: usize| pages as u64 * info.page_size as u64;
    format!("physical_available_bytes={}; physical_total_bytes={}; commit_used_bytes={}; commit_limit_bytes={}",
        bytes(info.physical_available), bytes(info.physical_total), bytes(info.commit_total), bytes(info.commit_limit))
}

#[tauri::command]
fn write_runtime_log(kind: String, message: String) -> Result<(), String> {
    #[cfg(windows)]
    if kind == "onnx-transfer" {
        return runtime_log(&kind, &format!("{message}; {}", onnx_memory_snapshot()));
    }
    runtime_log(&kind, &message)
}
#[tauri::command]
async fn append_game_performance(record: serde_json::Value) -> Result<(), String> {
    let directory = LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?;
    let path = directory.join("game-performance.jsonl");
    let mut line = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    line.push(b'\n');
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOG_WRITE.lock().map_err(|error| error.to_string())?;
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        std::fs::OpenOptions::new().create(true).append(true).open(path)
            .and_then(|mut file| file.write_all(&line)).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())??;

    let benchmark = record["benchmark"]["config"].is_object();
    let is_run = benchmark || !record["benchmark"].is_object();
    // Ack only the enqueue. The system archive's file I/O runs on the backend worker.
    if is_run && (record["reason"].as_str() == Some("completed") || record["systemPerformanceSegment"]["endedAt"].is_string()) {
        notify_system_performance(&record, benchmark).await;
    }
    Ok(())
}

async fn notify_system_performance(record: &serde_json::Value, benchmark: bool) {
    if let (Some((client, endpoint)), Some(task_id), Some(begin), Some(end)) = (
        SYSTEM_PERFORMANCE_BACKEND.get(), record["taskId"].as_str(),
        record["systemPerformanceSegment"]["beginTime"].as_str().or_else(|| record["beginTime"].as_str()),
        record["systemPerformanceSegment"]["endedAt"].as_str().or_else(|| record["endedAt"].as_str()),
    ) {
        let source = if benchmark { "benchmark" } else { "formal" };
        let body = serde_json::json!({"taskId": task_id, "source": source, "beginTime": begin, "endedAt": end});
        let response = client.post(endpoint).header("Content-Type", "application/json")
            .body(body.to_string()).send().await.and_then(|response| response.error_for_status());
        if let Err(error) = response {
            let message = error.to_string();
            let _ = tauri::async_runtime::spawn_blocking(move || runtime_log("system-performance-archive-error", &message)).await;
        }
    }
}

fn system_performance_backend(data: &std::path::Path) -> Option<(reqwest::Client, String)> {
    let port = std::fs::read_to_string(data.join("config.ini")).ok().and_then(|text| {
        text.lines().filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            if key.trim() != "port" { return None; }
            value.trim().parse::<u16>().ok().filter(|port| *port != 0)
        }).last()
    }).unwrap_or(17800);
    let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(1)).build().ok()?;
    Some((client, format!("http://127.0.0.1:{port}/api/system-performance/runs")))
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum GamePerformanceKind { Benchmark, Formal, All }

#[tauri::command]
async fn read_game_performance(
    scope: Option<String>, step: Option<String>, kind: Option<GamePerformanceKind>,
) -> Result<Vec<serde_json::Value>, String> {
    let path = LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?.join("game-performance.jsonl");
    let kind = kind.unwrap_or(GamePerformanceKind::Benchmark);
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufRead, Read};
        let (file, size) = {
            // Capture a complete prefix under the append lock. Reading and JSON parsing can run concurrently.
            let _guard = LOG_WRITE.lock().map_err(|error| error.to_string())?;
            let file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(format!("读取测试历史失败：{error}")),
            };
            let size = file.metadata().map_err(|error| error.to_string())?.len();
            (file, size)
        };
        let mut records = Vec::new();
        for (index, line) in std::io::BufReader::new(file.take(size)).lines().enumerate() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() { continue; }
            let record: serde_json::Value = serde_json::from_str(&line).map_err(|error| format!("测试历史第 {} 行无法读取：{error}", index + 1))?;
            let benchmark = record["benchmark"]["config"].is_object();
            let matching_kind = match kind {
                GamePerformanceKind::Benchmark => benchmark,
                GamePerformanceKind::Formal => !record["benchmark"].is_object(),
                GamePerformanceKind::All => true,
            };
            if matching_kind &&
                scope.as_deref().is_none_or(|scope| record["scope"].as_str() == Some(scope)) &&
                step.as_deref().is_none_or(|step| record["step"].as_str() == Some(step)) {
                records.push(record);
            }
        }
        Ok(records)
    }).await.map_err(|error| error.to_string())?
}


use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

fn benchmark_details_path(queue_id: &str, run_id: &str) -> Result<std::path::PathBuf, String> {
    let valid = |id: &str| id.len() == 36 && id.bytes().enumerate().all(|(i, byte)| {
        if matches!(i, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    });
    if !valid(queue_id) || !valid(run_id) { return Err("无效的测试记录编号".into()); }
    Ok(LOG_DIRECTORY.get().ok_or("日志目录尚未初始化")?.join("game-benchmark-images").join(queue_id))
}

#[tauri::command]
async fn write_game_benchmark_image_details(queue_id: String, run_id: String, samples: Option<serde_json::Value>, results: serde_json::Value) -> Result<(), String> {
    let directory = benchmark_details_path(&queue_id, &run_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let write_json = |path: &std::path::Path, value: &serde_json::Value| {
            write_atomic_export(path, |file| serde_json::to_writer(file, value).map_err(std::io::Error::other))
                .map_err(|cause| format!("保存测试逐图历史失败：{cause}"))
        };
        let reference = directory.join("samples.json");
        if let Some(value) = samples { write_json(&reference, &value)?; }
        if !reference.is_file() { return Err("测试样本快照缺失".into()); }
        write_json(&directory.join(format!("{run_id}.json")), &results)
    }).await.map_err(|cause| cause.to_string())?
}

#[tauri::command]
async fn read_game_benchmark_image_details(queue_id: String, run_id: String) -> Result<serde_json::Value, String> {
    let directory = benchmark_details_path(&queue_id, &run_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let read_json = |file: std::path::PathBuf| -> Result<serde_json::Value, String> {
            let bytes = std::fs::read(file).map_err(|cause| format!("读取测试逐图历史失败：{cause}"))?;
            serde_json::from_slice(&bytes).map_err(|cause| cause.to_string())
        };
        Ok(serde_json::json!({ "samples": read_json(directory.join("samples.json"))?,
            "results": read_json(directory.join(format!("{run_id}.json")))? }))
    }).await.map_err(|cause| cause.to_string())?
}

#[tauri::command]
async fn open_game_benchmark_window(webview: tauri::Webview) -> Result<bool, String> {
    open_game_window(webview, BENCHMARK_WINDOW, "记录与测试 · LLMChat", 930.0, 760.0)
}

#[tauri::command]
async fn open_game_aux_window(webview: tauri::Webview, kind: String) -> Result<bool, String> {
    match kind.as_str() {
        "help" => open_game_window(webview, GAME_HELP_WINDOW, "游戏翻译流程 · LLMChat", 760.0, 730.0),
        "configuration" => open_game_window(webview, GAME_CONFIGURATION_WINDOW, "测试配置 · LLMChat", 980.0, 740.0),
        "benchmark-review" => open_game_window(webview, GAME_BENCHMARK_REVIEW_WINDOW, "测试结果对照 · LLMChat", 1180.0, 800.0),
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
    let auxiliary_chrome = label != "main";
    let child = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title(title)
        .decorations(!auxiliary_chrome)
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

#[derive(serde::Deserialize)]
struct FileReadRange {
    offset: u64,
    length: usize,
}

fn read_file_range(path: &str, range: FileReadRange) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind, Read, Seek, SeekFrom};

    const MAX_CHUNK: usize = 16 * 1024 * 1024;
    if range.length == 0 || range.length > MAX_CHUNK {
        return Err(Error::new(ErrorKind::InvalidInput, "文件读取分块大小无效"));
    }
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(range.offset))?;
    let mut bytes = vec![0; range.length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Read raw bytes from a path chosen via the open dialog.
#[tauri::command]
async fn read_file_bytes(path: String, range: Option<FileReadRange>) -> Result<tauri::ipc::Response, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match range {
            Some(range) => read_file_range(&path, range),
            None => std::fs::read(&path),
        };
        bytes.map(tauri::ipc::Response::new).map_err(|error| format!("读取文件失败: {error}"))
    }).await.map_err(|error| error.to_string())?
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
    for label in [BENCHMARK_WINDOW, GAME_HELP_WINDOW, GAME_CONFIGURATION_WINDOW, GAME_BENCHMARK_REVIEW_WINDOW] {
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

mod frontend_preview;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| { let _ = runtime_log("rust-panic", &info.to_string()); previous_hook(info); }));
    let mut context = tauri::generate_context!();
    if let Some(root) = std::env::var_os("LLMCHAT_FRONTEND_PREVIEW") {
        let assets = frontend_preview::PreviewAssets::open(std::path::Path::new(&root))
            .expect("failed to open the frontend preview");
        context.set_assets(Box::new(assets));
    }
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
            build_speed_test::run_build_speed_test,
            train_dataset::start_training,
            train_dataset::cancel_training,
            train_dataset::probe_training_env,
            train_dataset::training_dataset_directory,
            training_storage::training_storage_info,
            training_storage::clear_training_pip_cache,
            training_storage::remove_legacy_training_environment,
            training_environment::ensure_training_venv,
            training_environment::cancel_training_environment,
            training_results::list_training_runs,
            training_results::read_training_result,
            training_results::training_model_status,
            training_results::enable_training_model,
            training_results::correct_training_label,
            ollama::ollama_service_status,
            ollama::ollama_runtime_status,
            ollama::ollama_service_start,
            ollama::ollama_service_stop,
            clipboard::clipboard_read_image_png,
            write_file_bytes,
            style_redraw::run_style_redraw,
            style_redraw::cancel_mosaic_redraw,
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
            write_game_benchmark_image_details,
            read_game_benchmark_image_details,
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
            if let Some(backend) = system_performance_backend(&data) {
                let _ = SYSTEM_PERFORMANCE_BACKEND.set(backend);
            }
            let _ = runtime_log("startup", &format!("LLMChat started; version={}; executable={:?}; logs={:?}", env!("CARGO_PKG_VERSION"), std::env::current_exe().ok(), LOG_DIRECTORY.get()));
            app.manage(speech::SpeechStorage(data));
            let profile = paths["webview"].as_str().ok_or("Missing WebView storage path")?;
            start_backend(app.handle()).map_err(std::io::Error::other)?;
            let _ = WEBVIEW_DIRECTORY.set(std::path::PathBuf::from(profile));
            let mut config = window_config.clone();
            config.create = true;
            let main_window = tauri::WebviewWindowBuilder::from_config(app, &config)?
                .data_directory(std::path::PathBuf::from(profile))
                .build()?;
            #[cfg(windows)]
            if !config.decorations {
                window_frame::install(main_window.hwnd()?, main_window.as_ref().clone())?;
            }
            #[cfg(not(windows))]
            let _ = main_window;
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
