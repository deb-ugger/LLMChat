use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager;

static RENDER: Mutex<()> = Mutex::new(());
const COMFY_URL: &str = "http://127.0.0.1:8188";
const HISTORY_LIMIT: usize = 30;
const REDRAW_WORKER: &str = include_str!("style_redraw.py");
const REDRAW_BOOTSTRAP: &str = "import sys; source = sys.stdin.buffer.read(int(sys.stdin.buffer.readline())); exec(compile(source, '<style-redraw>', 'exec'))";

#[tauri::command]
pub async fn run_style_redraw(directory: String, image: String, steps: u32,
                              regions: serde_json::Value, mode: String, profile: serde_json::Value, progress: Channel<String>) -> Result<serde_json::Value, String> {
    run_worker(directory, json!({ "image": image, "steps": steps, "regions": regions, "mode": mode, "profile": profile }), progress).await
}

#[tauri::command]
pub async fn prepare_redraw_ui(directory: String, progress: Channel<String>) -> Result<Value, String> {
    if let Some(stats) = comfy_get("/system_stats").await? {
        if !stats["system"].is_object() { return Err("8188 端口上的服务不是 ComfyUI".into()); }
        return Ok(json!({ "url": COMFY_URL }));
    }
    run_worker(directory, json!({ "mode": "open" }), progress).await
}

#[derive(serde::Deserialize)]
pub struct RedrawEditorBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn is_comfy_origin(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(8188)
}

#[tauri::command]
pub async fn sync_redraw_editor(app: tauri::AppHandle, game: bool, bounds: Option<RedrawEditorBounds>, close: bool) -> Result<(), String> {
    let label = if game { "comfy-redraw-game" } else { "comfy-redraw-main" };
    let current = app.get_webview(label);
    if close {
        if let Some(view) = current { view.close().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    let Some(bounds) = bounds else {
        if let Some(view) = current { view.hide().map_err(|e| e.to_string())?; }
        return Ok(());
    };
    if ![bounds.x, bounds.y, bounds.width, bounds.height].into_iter().all(f64::is_finite) {
        return Err("ComfyUI 显示区域无效".into());
    }
    let window = app.get_window("main").ok_or("找不到 LLMChat 主窗口")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let left = bounds.x.clamp(0.0, inner.width);
    let top = bounds.y.clamp(0.0, inner.height);
    let width = (bounds.x + bounds.width).clamp(left, inner.width) - left;
    let height = (bounds.y + bounds.height).clamp(top, inner.height) - top;
    if width < 1.0 || height < 1.0 {
        if let Some(view) = current { view.hide().map_err(|e| e.to_string())?; }
        return Ok(());
    }
    let position = tauri::LogicalPosition::new(left, top);
    let size = tauri::LogicalSize::new(width, height);
    if let Some(view) = current {
        view.set_bounds(tauri::Rect { position: position.into(), size: size.into() }).map_err(|e| e.to_string())?;
        return view.show().map_err(|e| e.to_string());
    }
    let url = COMFY_URL.parse().map_err(|_| "ComfyUI 地址无效")?;
    let builder = tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(url))
        .disable_drag_drop_handler()
        .on_navigation(is_comfy_origin)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    window.add_child(builder, position, size)
        .map(|_| ()).map_err(|e| format!("无法嵌入 ComfyUI 编辑器：{e}"))
}

async fn run_worker(directory: String, mut payload: Value, progress: Channel<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _active = RENDER.try_lock().map_err(|_| "已有 AI 风格重绘任务正在运行")?;
        let root = portable_directory(Path::new(&directory)).ok_or("请选择有效的 ComfyUI 便携版目录")?;
        let python = root.join("python_embeded/python.exe");
        payload["directory"] = json!(root);
        let mut command = Command::new(python);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .args(["-X", "utf8", "-u", "-c", REDRAW_BOOTSTRAP])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("无法启动重绘任务：{e}"))?;
        let mut errors = child.stderr.take().unwrap();
        let diagnostics = std::thread::spawn(move || {
            let mut text = String::new();
            let _ = errors.read_to_string(&mut text);
            text
        });
        let mut execute = || -> Result<serde_json::Value, String> {
            let mut input = child.stdin.take().unwrap();
            writeln!(input, "{}", REDRAW_WORKER.len()).map_err(|e| e.to_string())?;
            input.write_all(REDRAW_WORKER.as_bytes()).map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut input, &payload).map_err(|e| e.to_string())?;
            input.flush().map_err(|e| e.to_string())?;
            drop(input);
            for line in BufReader::new(child.stdout.take().unwrap()).lines() {
                let event: serde_json::Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                if event["type"] == "result" && event["value"].is_object() { return Ok(event["value"].clone()); }
                let value = event["value"].as_str().ok_or("重绘任务返回无效数据")?;
                match event["type"].as_str() {
                    Some("status") => { let _ = progress.send(value.to_owned()); }
                    Some("error") => return Err(value.to_owned()),
                    _ => return Err("未知重绘任务消息".into()),
                }
            }
            Err("重绘进程结束，未收到结果".into())
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

fn portable_directory(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() { return None; }
    let is_portable = |root: &Path| root.join("python_embeded/python.exe").is_file() && root.join("ComfyUI/main.py").is_file();
    if is_portable(path) { return Some(path.to_path_buf()); }
    if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("ComfyUI")) {
        return path.parent().filter(|root| is_portable(root)).map(Path::to_path_buf);
    }
    None
}

#[tauri::command]
pub async fn find_redraw_directories(app: tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut folders = BTreeSet::new();
    for folder in [app.path().desktop_dir(), app.path().download_dir(), app.path().home_dir()].into_iter().flatten() { folders.insert(folder); }
    for folder in [std::env::current_dir().ok(), std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf))].into_iter().flatten() {
        folders.extend(folder.ancestors().take(3).map(Path::to_path_buf));
    }
    #[cfg(windows)]
    folders.extend(('C'..='Z').map(|drive| PathBuf::from(format!("{drive}:\\"))));
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = BTreeSet::new();
        for folder in folders {
            if let Some(root) = portable_directory(&folder) { roots.insert(root); }
            for item in fs::read_dir(&folder).into_iter().flatten().flatten() {
                let name = item.file_name().to_string_lossy().to_ascii_lowercase();
                if name.contains("comfyui") {
                    if let Some(root) = portable_directory(&item.path()) { roots.insert(root); }
                    for nested in fs::read_dir(item.path()).into_iter().flatten().flatten() {
                        if let Some(root) = portable_directory(&nested.path()) { roots.insert(root); }
                    }
                } else if matches!(name.as_str(), "ai" | "tools" | "downloads" | "baidunetdiskdownload" | "cursor project") {
                    for nested in fs::read_dir(item.path()).into_iter().flatten().flatten() {
                        if nested.file_name().to_string_lossy().to_ascii_lowercase().contains("comfyui") {
                            if let Some(root) = portable_directory(&nested.path()) { roots.insert(root); }
                        }
                    }
                }
            }
        }
        roots.into_iter().collect()
    }).await.map_err(|e| e.to_string())
}

fn list_weights(root: &Path, folders: &[&str]) -> Result<BTreeSet<String>, String> {
    let mut files = BTreeSet::new();
    for folder in folders {
        let base = root.join(folder);
        if !base.is_dir() { continue; }
        let mut pending = vec![base.clone()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).map_err(|e| format!("无法读取模型目录：{e}"))? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_dir() { pending.push(path); }
                else if matches!(path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
                    "safetensors" | "gguf" | "ckpt" | "pt" | "pth" | "bin" | "sft" | "pkl" | "pkl2") && path.is_file() {
                    files.insert(path.strip_prefix(&base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    Ok(files)
}

#[tauri::command]
pub async fn inspect_redraw_directory(directory: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = portable_directory(Path::new(&directory)).ok_or("未识别到便携版：目录中需要 ComfyUI/main.py 和 python_embeded/python.exe")?;
        let models = root.join("ComfyUI/models");
        Ok(json!({ "directory": root, "model": list_weights(&models, &["diffusion_models", "unet"])?,
            "clip": list_weights(&models, &["text_encoders", "clip"])?,
            "vae": list_weights(&models, &["vae"])? }))
    }).await.map_err(|e| e.to_string())?
}

fn comfy_http() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4)).build().map_err(|e| e.to_string())).as_ref().map_err(Clone::clone)
}

async fn comfy_response(route: &str) -> Result<Option<reqwest::Response>, String> {
    match comfy_http()?.get(format!("{COMFY_URL}{route}")).send().await {
        Ok(response) => Ok(Some(response)),
        Err(error) if error.is_connect() => Ok(None),
        Err(error) => Err(format!("无法读取 ComfyUI {route}：{error}")),
    }
}

async fn comfy_json(response: reqwest::Response, route: &str) -> Result<Value, String> {
    if !response.status().is_success() { return Err(format!("ComfyUI {route} 返回 HTTP {}", response.status())); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| format!("ComfyUI {route} 返回了无法识别的数据"))
}

async fn comfy_get(route: &str) -> Result<Option<Value>, String> {
    let Some(response) = comfy_response(route).await? else { return Ok(None); };
    comfy_json(response, route).await.map(Some)
}

fn redraw_inputs(graph: &Value) -> Option<Value> {
    let nodes = graph.as_object()?;
    let input = |classes: &[&str], field: &str| {
        let mut values = nodes.values().filter(|node|
            node["class_type"].as_str().is_some_and(|kind| classes.contains(&kind)));
        let value = values.next()?.get("inputs")?.get(field)?;
        values.next().is_none().then_some(value)
    };
    let has = |class: &str| nodes.values().any(|node| node["class_type"] == class);
    let (profile, model, steps) = if has("TextEncodeQwenImage21") {
        let model = input(&["UNETLoader"], "unet_name")?.as_str()?;
        if !model.to_ascii_lowercase().contains("turbo") { return None; }
        ("turbo", model, None)
    } else if has("TextEncodeQwenImageEditPlus") {
        let model = input(&["UnetLoaderGGUF"], "unet_name")?.as_str()?;
        if !model.contains("2511") { return None; }
        let steps = input(&["KSampler", "KSamplerAdvanced"], "steps")
            .and_then(Value::as_u64).filter(|steps| (1..=100).contains(steps));
        ("2511", model, steps)
    } else {
        return None;
    };
    Some(json!({ "profile": profile, "model": model, "steps": steps,
        "clip": input(&["CLIPLoader"], "clip_name").and_then(Value::as_str),
        "vae": input(&["VAELoader"], "vae_name").and_then(Value::as_str) }))
}

fn queue_rows(queue: &Value, key: &str) -> Result<Vec<Value>, String> {
    let rows = queue[key].as_array().ok_or("8188 端口未返回 ComfyUI 任务队列")?;
    let mut rows: Vec<_> = rows.iter().filter_map(|row| {
        Some(json!({"id": row.get(1)?.as_str()?, "number": row[0].as_f64().unwrap_or_default(),
            "parameters": redraw_inputs(&row[2])}))
    }).collect();
    rows.sort_by(|left, right| left["number"].as_f64().unwrap_or_default().total_cmp(&right["number"].as_f64().unwrap_or_default()));
    Ok(rows)
}

fn history_rows(history: &Value) -> Result<Vec<Value>, String> {
    let records = history.as_object().ok_or("ComfyUI 返回了无法识别的历史记录")?;
    let mut rows: Vec<_> = records.iter().map(|(id, record)| {
        let status = &record["status"];
        let output = record["outputs"].as_object().into_iter().flat_map(|nodes| nodes.values())
            .filter_map(|node| node["images"].as_array()).flatten()
            .find(|image| image["filename"].is_string() && matches!(image["type"].as_str(), Some("temp" | "output")));
        let (mut start, mut end, mut interrupted) = (None, None, false);
        for message in status["messages"].as_array().into_iter().flatten() {
            match message[0].as_str() {
                Some("execution_start") => start = message[1]["timestamp"].as_u64(),
                Some("execution_success" | "execution_error" | "execution_interrupted") => {
                    end = message[1]["timestamp"].as_u64();
                    interrupted |= message[0] == "execution_interrupted";
                },
                _ => {}
            }
        }
        let state = if interrupted { "interrupted" } else if status["status_str"] == "success" { "done" } else { "failed" };
        json!({ "id":id, "number": record["prompt"][0].as_f64().unwrap_or_default(), "state":state,
            "time":end.or(start), "duration":start.zip(end).map(|(start,end)| end.saturating_sub(start)),
            "parameters": redraw_inputs(&record["prompt"][2]),
            "image":output.map(|image| json!({ "filename":image["filename"], "type":image["type"], "subfolder":image["subfolder"].as_str().unwrap_or("") })) })
    }).collect();
    rows.sort_by(|left, right| right["time"].as_u64().cmp(&left["time"].as_u64()).then_with(||
        right["number"].as_f64().unwrap_or_default().total_cmp(&left["number"].as_f64().unwrap_or_default())));
    rows.truncate(HISTORY_LIMIT);
    Ok(rows)
}

#[tauri::command]
pub async fn read_redraw_queue() -> Result<Value, String> {
    let Some(queue) = comfy_get("/queue").await? else { return Ok(json!({"online": false})); };
    let running = queue_rows(&queue, "queue_running")?;
    let waiting = queue_rows(&queue, "queue_pending")?;
    let Some(history) = comfy_get("/history?max_items=30").await? else { return Ok(json!({"online": false})); };
    Ok(json!({ "online":true, "running": running, "waiting": waiting, "history":history_rows(&history)? }))
}

#[tauri::command]
pub async fn read_redraw_thumbnail(filename: String, subfolder: String, kind: String, original: Option<bool>) -> Result<tauri::ipc::Response, String> {
    let asset_hash = filename.strip_prefix("blake3:")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if filename.is_empty() || (!asset_hash && filename.contains(['/', '\\', ':'])) || matches!(filename.as_str(), "." | "..") ||
        !matches!(kind.as_str(), "input" | "output" | "temp") || subfolder.contains(':') || subfolder.starts_with(['/', '\\']) ||
        subfolder.split(['/', '\\']).any(|part| matches!(part, "." | "..")) {
        return Err("ComfyUI 预览路径无效".into());
    }
    let original = original.unwrap_or(false);
    let mut url = reqwest::Url::parse(&format!("{COMFY_URL}/view")).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("filename", &filename).append_pair("subfolder", &subfolder)
        .append_pair("type", &kind);
    if !original { url.query_pairs_mut().append_pair("preview", "webp;85"); }
    let response = comfy_http()?.get(url).send().await.map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(if kind == "temp" { "此图片已不存在，可能是 ComfyUI 已清理临时文件" } else { "ComfyUI 中找不到此图片" }.into());
    }
    if !response.status().is_success() { return Err(format!("ComfyUI 预览不可用（HTTP {}）", response.status())); }
    let limit = if original { 64 } else { 4 } * 1024 * 1024;
    if response.content_length().is_some_and(|size| size > limit) { return Err("图片文件过大，无法预览".into()); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit { return Err("图片文件过大，无法预览".into()); }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

fn saved_workflow_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".json") && !path.contains('\\') && !path.contains(':') && !path.chars().any(char::is_control)
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

#[tauri::command]
pub async fn list_redraw_workflows() -> Result<Option<Vec<Value>>, String> {
    let route = "/userdata?dir=workflows&recurse=true&full_info=true";
    let Some(response) = comfy_response(route).await? else { return Ok(None); };
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(Some(Vec::new())); }
    let data = comfy_json(response, route).await?;
    let records = data.as_array().ok_or("ComfyUI 未返回已保存工作流列表")?;
    let mut files: Vec<_> = records.iter().filter_map(|record| {
        let path = record["path"].as_str()?;
        saved_workflow_path(path).then(|| json!({ "path": path, "modified": record["modified"].as_u64() }))
    }).collect();
    files.sort_by(|first, second| first["path"].as_str().cmp(&second["path"].as_str()));
    Ok(Some(files))
}

#[tauri::command]
pub async fn read_redraw_workflow(path: String) -> Result<Value, String> {
    let url = redraw_workflow_url(&path)?;
    let workflow = existing_redraw_workflow(&url).await?;
    let parameters = redraw_inputs(&workflow);
    Ok(json!({ "revision": workflow_revision(&workflow), "workflow": workflow, "parameters": parameters }))
}

fn redraw_workflow_url(path: &str) -> Result<reqwest::Url, String> {
    if !saved_workflow_path(path) { return Err("请选择 ComfyUI 中保存的 JSON 工作流".into()); }
    let mut url = reqwest::Url::parse(COMFY_URL).map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "ComfyUI 地址无效")?
        .extend(["userdata", &format!("workflows/{path}")]);
    Ok(url)
}

async fn existing_redraw_workflow(url: &reqwest::Url) -> Result<Value, String> {
    let response = comfy_response(url.path()).await?.ok_or("ComfyUI 尚未启动")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Err("工作流已不存在，请刷新列表".into()); }
    comfy_json(response, "工作流").await
}

fn workflow_revision(workflow: &Value) -> String {
    let mut hash = DefaultHasher::new();
    workflow.to_string().hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn api_workflow(graph: &Value) -> bool {
    graph.as_object().is_some_and(|nodes| !nodes.is_empty() &&
        nodes.values().all(|node| node["class_type"].is_string() && node["inputs"].is_object()))
}

fn api_link(graph: &Value, value: &Value) -> bool {
    value.as_array().is_some_and(|link| link.len() == 2 &&
        link[0].as_str().is_some_and(|id| graph.get(id).is_some()) && link[1].is_u64())
}

#[derive(serde::Deserialize)]
pub struct WorkflowEdit {
    pointer: String,
    value: Value,
}

fn apply_workflow_edits(workflow: &mut Value, edits: Vec<WorkflowEdit>) -> Result<(), String> {
    let api = api_workflow(workflow);
    if !api && !workflow["nodes"].is_array() { return Err("工作流格式无法识别".into()); }
    for edit in edits {
        let parts: Vec<_> = edit.pointer.strip_prefix('/').unwrap_or("").split('/').collect();
        let allowed = if api {
            matches!(parts.as_slice(), [_, "inputs", _])
        } else {
            matches!(parts.as_slice(),
                ["nodes", _, "widgets_values" | "widgets_values_named", _] |
                ["definitions", "subgraphs", _, "nodes", _, "widgets_values" | "widgets_values_named", _])
        };
        let old = workflow.pointer(&edit.pointer).filter(|old| allowed &&
            (old.is_number() && edit.value.is_number() || std::mem::discriminant(*old) == std::mem::discriminant(&edit.value)) &&
            !(api && (api_link(workflow, old) || api_link(workflow, &edit.value))));
        if old.is_none() { return Err("只能修改已有的工作流参数，不能改动节点或连线".into()); }
        *workflow.pointer_mut(&edit.pointer).ok_or("工作流参数不存在")? = edit.value;
    }
    Ok(())
}

async fn edited_workflow(path: &str, revision: &str, edits: Vec<WorkflowEdit>) -> Result<(reqwest::Url, Value), String> {
    let url = redraw_workflow_url(path)?;
    let mut workflow = existing_redraw_workflow(&url).await?;
    if workflow_revision(&workflow) != revision { return Err("工作流已在 ComfyUI 中更新，请重新读取后再操作".into()); }
    apply_workflow_edits(&mut workflow, edits)?;
    Ok((url, workflow))
}

#[tauri::command]
pub async fn save_redraw_workflow(path: String, revision: String, edits: Vec<WorkflowEdit>) -> Result<Value, String> {
    if edits.is_empty() { return Err("没有需要保存的参数修改".into()); }
    let (mut url, workflow) = edited_workflow(&path, &revision, edits).await?;
    url.query_pairs_mut().append_pair("overwrite", "true");
    let response = comfy_http()?.post(url).header("Content-Type", "application/json")
        .body(workflow.to_string()).send().await.map_err(|e| format!("无法保存 ComfyUI 工作流：{e}"))?;
    if !response.status().is_success() { return Err(format!("ComfyUI 保存工作流失败（HTTP {}）", response.status())); }
    Ok(json!({ "revision": workflow_revision(&workflow), "workflow": workflow }))
}

fn prompt_result(value: Value) -> Result<Value, String> {
    if value["prompt_id"].is_string() { return Ok(value); }
    let message = value["error"]["message"].as_str().or_else(|| value["error"].as_str()).unwrap_or("ComfyUI 未返回任务 ID");
    let detail = value["error"]["details"].as_str().filter(|detail| !detail.is_empty());
    Err(if let Some(detail) = detail { format!("{message}：{detail}") } else { message.to_owned() })
}

async fn run_visual_workflow(app: tauri::AppHandle, workflow: Value, path: String) -> Result<Value, String> {
    static RUN_ID: AtomicU64 = AtomicU64::new(0);
    let label = format!("comfy-workflow-submit-{}", RUN_ID.fetch_add(1, Ordering::Relaxed));
    let serialized = json!({ "workflow": workflow, "path": path }).to_string();
    let script = format!("globalThis.__llmchatSavedRun = JSON.parse({});\n{}",
        json!(serialized), include_str!("style_redraw_submit.js"));
    let (send, receive) = mpsc::sync_channel(1);
    let window = tauri::WebviewWindowBuilder::new(&app, label,
        tauri::WebviewUrl::External(COMFY_URL.parse().map_err(|_| "ComfyUI 地址无效")?))
        .visible(false)
        .incognito(true)
        .initialization_script(script)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_navigation(move |url| {
            let local = is_comfy_origin(url);
            if local && url.path() == "/__llmchat_workflow_result" {
                if let Some((_, data)) = url.query_pairs().find(|(name, _)| name == "data") {
                    let result = serde_json::from_str::<Value>(&data).map_err(|_| "ComfyUI 返回无效任务结果".to_owned()).and_then(prompt_result);
                    let _ = send.try_send(result);
                }
                return false;
            }
            local
        })
        .build().map_err(|e| format!("无法打开 ComfyUI 工作流转换器：{e}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(55))).await;
    let _ = window.destroy();
    result.map_err(|e| e.to_string())?
        .map_err(|_| "未收到任务提交确认，请先查看 ComfyUI 队列再重试".to_owned())?
}

#[tauri::command]
pub async fn submit_redraw_workflow(app: tauri::AppHandle, path: String, revision: String, edits: Vec<WorkflowEdit>) -> Result<Value, String> {
    let (_, workflow) = edited_workflow(&path, &revision, edits).await?;
    if !api_workflow(&workflow) { return run_visual_workflow(app, workflow, path).await; }
    let response = comfy_http()?.post(format!("{COMFY_URL}/prompt")).header("Content-Type", "application/json")
        .body(json!({ "prompt": workflow, "extra_data": { "llmchat_workflow": path } }).to_string())
        .send().await.map_err(|e| format!("无法提交工作流：{e}"))?;
    let text = response.bytes().await.map_err(|e| e.to_string())?;
    prompt_result(serde_json::from_slice(&text).map_err(|_| "ComfyUI 返回无效任务结果")?)
}
