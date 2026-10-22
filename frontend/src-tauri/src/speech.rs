use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager};

// Only small commit positions are retained; transcript bodies stay on disk.
static POSITIONS: LazyLock<Mutex<HashMap<PathBuf, (f64, usize)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
type Result<T> = std::result::Result<T, String>;
fn err(error: impl std::fmt::Display) -> String { error.to_string() }

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cue { pub start: f64, pub end: f64, pub text: String }
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub model: String, pub language: String, pub chinese_script: String, pub formats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<Processing>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Processing {
    pub mode: String, pub provider: String, pub model: String, pub proofread: bool, pub proofread_model: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Source { pub path: String, pub name: String, pub size: u64, pub modified: u64, pub duration: f64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String, pub folder: String, pub source: Source, pub options: Options,
    pub offset: f64, pub cue_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_stem: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Chunk { pub from: f64, pub to: f64, pub cues: Vec<Cue>, pub text: String }
#[derive(Serialize)]
pub struct Preview { pub cues: Vec<Cue>, pub total: usize }

fn quiet_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}
fn tools(app: &AppHandle) -> Result<PathBuf> {
    let path = app.path().resource_dir().map_err(err)?.join("resources").join("ffmpeg");
    if !path.join("ffmpeg.exe").is_file() || !path.join("ffprobe.exe").is_file() {
        return Err("缺少音频解码组件，请更新完整便携版。".into());
    }
    Ok(path)
}
fn modified(path: &Path) -> Result<(u64, u64)> {
    let meta = fs::metadata(path).map_err(err)?;
    if !meta.is_file() { return Err("所选音频不是文件".into()); }
    let time = meta.modified().map_err(err)?.duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_millis() as u64;
    Ok((meta.len(), time))
}
fn probe(tool_dir: &Path, source: &Path) -> Result<Source> {
    let (size, time) = modified(source)?;
    let output = quiet_command(&tool_dir.join("ffprobe.exe"))
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration:stream=duration", "-of", "json"])
        .arg(source).output().map_err(err)?;
    if !output.status.success() { return Err(format!("无法读取音频：{}", String::from_utf8_lossy(&output.stderr))); }
    let data: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(err)?;
    let duration = data["format"]["duration"].as_str().or_else(|| data["streams"][0]["duration"].as_str())
        .and_then(|s| s.parse::<f64>().ok()).filter(|n| n.is_finite() && *n > 0.0).ok_or("无法确定音频时长")?;
    if data["streams"].as_array().is_none_or(|streams| streams.is_empty()) { return Err("文件中没有音轨".into()); }
    Ok(Source { path: source.to_string_lossy().into_owned(), name: source.file_name().ok_or("无效文件名")?.to_string_lossy().into_owned(), size, modified: time, duration })
}
fn validate_options(options: &Options) -> Result<()> {
    if options.formats.is_empty() || options.formats.iter().any(|f| !["srt", "vtt", "txt"].contains(&f.as_str())) {
        return Err("至少选择一种有效输出格式".into());
    }
    Ok(())
}
fn load_job(folder: &Path) -> Result<Job> {
    let job: Job = serde_json::from_slice(&fs::read(folder.join("job.json")).map_err(err)?).map_err(err)?;
    let legacy_folder = format!("speech-{}", job.id);
    if folder.file_name().and_then(|n| n.to_str()) != Some(job.output_stem.as_deref().unwrap_or(&legacy_folder)) {
        return Err("不是有效的语音任务目录".into());
    }
    validate_options(&job.options)?;
    Ok(Job { folder: folder.to_string_lossy().into_owned(), ..job })
}
fn read_chunks(folder: &Path, repair: bool) -> Result<Vec<Chunk>> {
    let file = File::open(folder.join("progress.jsonl")).map_err(err)?;
    let mut reader = BufReader::new(file);
    let mut chunks = Vec::new();
    let mut valid_bytes = 0u64;
    let mut expected = 0.0;
    loop {
        let mut line = Vec::new();
        let count = reader.read_until(b'\n', &mut line).map_err(err)?;
        if count == 0 { break; }
        // A torn final append is not a committed record; retry that audio window.
        if line.last() != Some(&b'\n') { break; }
        let chunk: Chunk = serde_json::from_slice(&line).map_err(|e| format!("任务进度文件损坏：{e}"))?;
        if (chunk.from - expected).abs() > 0.001 || !chunk.to.is_finite() || chunk.to <= chunk.from {
            return Err("任务进度不连续".into());
        }
        expected = chunk.to;
        valid_bytes += count as u64;
        chunks.push(chunk);
    }
    if repair {
        OpenOptions::new().write(true).open(folder.join("progress.jsonl")).map_err(err)?.set_len(valid_bytes).map_err(err)?;
    }
    Ok(chunks)
}
fn timestamp(seconds: f64, dot: bool) -> String {
    let ms = (seconds.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02}{}{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, if dot { '.' } else { ',' }, ms % 1000)
}
fn chunk_text(chunk: &Chunk, format: &str, count: usize) -> String {
    if format == "txt" { return if chunk.text.trim().is_empty() { String::new() } else { format!("{}\n", chunk.text.trim()) }; }
    chunk.cues.iter().enumerate().map(|(i, cue)| format!("{}\n{} --> {}\n{}\n\n", count + i + 1, timestamp(cue.start, format == "vtt"), timestamp(cue.end, format == "vtt"), cue.text.trim())).collect()
}
fn output_path(job: &Job, format: &str) -> Result<PathBuf> {
    let original = Path::new(&job.source.name).file_stem().ok_or("无效音频文件名")?.to_string_lossy();
    let stem = job.output_stem.as_deref().unwrap_or(&original);
    Ok(Path::new(&job.folder).join(format!("{stem}.{format}")))
}
fn open_outputs(job: &Job, truncate: bool) -> Result<Vec<(String, File)>> {
    job.options.formats.iter().map(|format| {
        let mut file = OpenOptions::new().create(true).write(true).truncate(truncate).append(!truncate)
            .open(output_path(job, format)?).map_err(err)?;
        if truncate && format == "vtt" { file.write_all(b"WEBVTT\n\n").map_err(err)?; }
        Ok((format.clone(), file))
    }).collect()
}
fn rebuild(job: &mut Job) -> Result<()> {
    let chunks = read_chunks(Path::new(&job.folder), true)?;
    let mut files = open_outputs(job, true)?;
    let mut count = 0;
    for chunk in &chunks {
        for (format, file) in &mut files { file.write_all(chunk_text(chunk, format, count).as_bytes()).map_err(err)?; }
        count += chunk.cues.len();
    }
    for (_, file) in files { file.sync_data().map_err(err)?; }
    job.offset = chunks.last().map_or(0.0, |c| c.to); job.cue_count = count;
    let mut positions = POSITIONS.lock().unwrap();
    if job.offset >= job.source.duration - 0.01 { positions.remove(Path::new(&job.folder)); }
    else { positions.insert(PathBuf::from(&job.folder), (job.offset, count)); }
    Ok(())
}
fn create_job(root: &Path, id: String, source: Source, options: Options, output_date: &str) -> Result<Job> {
    if id.len() > 64 || id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("无效任务 ID".into()); }
    validate_options(&options)?;
    if output_date.len() != 10 || !output_date.bytes().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == b'-' } else { c.is_ascii_digit() }) {
        return Err("无效输出日期".into());
    }
    if modified(Path::new(&source.path))? != (source.size, source.modified) { return Err("原音频文件已更改，请重新添加".into()); }
    fs::create_dir_all(root).map_err(err)?;
    let stem = Path::new(&source.name).file_stem().ok_or("无效音频文件名")?.to_string_lossy();
    let base = format!("{stem}_{output_date}");
    let mut index = 1;
    let (folder, output_stem) = loop {
        let name = if index == 1 { base.clone() } else { format!("{base}（{index}）") };
        let folder = root.join(&name);
        match fs::create_dir(&folder) {
            Ok(()) => break (folder, name),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => index += 1,
            Err(e) => return Err(err(e)),
        }
    };
    let mut job = Job { id, folder: folder.to_string_lossy().into_owned(), source, options, offset: 0.0, cue_count: 0, output_stem: Some(output_stem) };
    File::create(folder.join("progress.jsonl")).map_err(err)?.sync_data().map_err(err)?;
    rebuild(&mut job)?;
    // Publish the task only after its journal and output headers exist.
    let mut metadata = File::create(folder.join("job.json.tmp")).map_err(err)?;
    metadata.write_all(&serde_json::to_vec_pretty(&job).map_err(err)?).map_err(err)?; metadata.sync_data().map_err(err)?;
    drop(metadata);
    fs::rename(folder.join("job.json.tmp"), folder.join("job.json")).map_err(err)?;
    Ok(job)
}
fn commit(folder: &Path, chunk: Chunk) -> Result<Job> {
    let mut job = load_job(folder)?;
    let mut positions = POSITIONS.lock().unwrap();
    let (offset, count) = if let Some(position) = positions.get(folder) { *position }
        else { let chunks = read_chunks(folder, false)?; (chunks.last().map_or(0.0, |c| c.to), chunks.iter().map(|c| c.cues.len()).sum()) };
    if (chunk.from - offset).abs() > 0.001 || !chunk.to.is_finite() || chunk.to <= offset || chunk.to > job.source.duration + 0.1 {
        return Err("保存位置与任务断点不一致".into());
    }
    if chunk.cues.iter().any(|cue| !cue.start.is_finite() || !cue.end.is_finite() || cue.start < chunk.from - 0.001 || cue.end > chunk.to + 0.001 || cue.end <= cue.start) {
        return Err("字幕时间超出当前音频片段".into());
    }
    let mut record = serde_json::to_vec(&chunk).map_err(err)?; record.push(b'\n');
    let mut journal = OpenOptions::new().append(true).open(folder.join("progress.jsonl")).map_err(err)?;
    journal.write_all(&record).map_err(err)?; journal.sync_data().map_err(err)?;
    // Journal is authoritative. Resume rebuilds outputs if power fails during writes.
    for (format, mut file) in open_outputs(&job, false)? {
        file.write_all(chunk_text(&chunk, &format, count).as_bytes()).map_err(err)?; file.sync_data().map_err(err)?;
    }
    job.offset = chunk.to; job.cue_count = count + chunk.cues.len();
    if job.offset >= job.source.duration - 0.01 { positions.remove(folder); }
    else { positions.insert(folder.to_path_buf(), (job.offset, job.cue_count)); }
    Ok(job)
}
fn cancel_job(folder: &Path) -> Result<()> {
    let job = load_job(folder)?;
    let mut positions = POSITIONS.lock().unwrap();
    for format in &job.options.formats {
        let file = output_path(&job, format)?;
        if file.exists() { fs::remove_file(file).map_err(err)?; }
    }
    fs::remove_file(folder.join("progress.jsonl")).map_err(err)?;
    fs::remove_file(folder.join("job.json")).map_err(err)?;
    positions.remove(folder);
    // Do not recursively delete unexpected/user-added files.
    match fs::remove_dir(folder) { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => Ok(()), Err(e) => Err(err(e)) }
}
fn decode_chunk(dir: &Path, folder: &Path, offset: f64) -> Result<Vec<u8>> {
    let job = load_job(folder)?;
    if !offset.is_finite() || offset < 0.0 || offset >= job.source.duration { return Err("无效解码位置".into()); }
    let output = quiet_command(&dir.join("ffmpeg.exe"))
        .args(["-nostdin", "-v", "error", "-ss", &format!("{offset:.6}"), "-i"]).arg(&job.source.path)
        .args(["-t", "30", "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-threads", "1", "-f", "f32le", "pipe:1"])
        .output().map_err(err)?;
    if !output.status.success() { return Err(format!("音频解码失败：{}", String::from_utf8_lossy(&output.stderr))); }
    if output.stdout.is_empty() { return Err("当前断点没有可解码的音频".into()); }
    Ok(output.stdout)
}

#[tauri::command]
pub fn speech_environment(app: AppHandle) -> Result<serde_json::Value> {
    let executable = std::env::current_exe().map_err(err)?;
    let program_dir = executable.parent().ok_or("无法确定软件目录")?;
    Ok(serde_json::json!({
        "outputRoot": program_dir.join("speech-output"),
        "legacyOutputRoot": app.path().app_local_data_dir().map_err(err)?.join("speech-output"),
        "toolsReady": tools(&app).is_ok()
    }))
}
#[tauri::command]
pub async fn speech_probe(app: AppHandle, path: String) -> Result<Source> {
    let dir = tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || probe(&dir, Path::new(&path))).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_create_job(root: String, id: String, source: Source, options: Options, output_date: String) -> Result<Job> {
    tauri::async_runtime::spawn_blocking(move || create_job(Path::new(&root), id, source, options, &output_date)).await.map_err(err)?
}
fn list_jobs(root: &Path) -> Result<Vec<Job>> {
    if !root.exists() { return Ok(Vec::new()); }
    let mut jobs = Vec::new();
    for entry in fs::read_dir(root).map_err(err)? {
        let folder = entry.map_err(err)?.path();
        if !folder.is_dir() { continue; }
        if !folder.join("job.json").is_file() { continue; }
        let mut job = load_job(&folder)?;
        let chunks = read_chunks(&folder, false)?;
        job.offset = chunks.last().map_or(0.0, |c| c.to); job.cue_count = chunks.iter().map(|c| c.cues.len()).sum();
        jobs.push(job);
    }
    Ok(jobs)
}
#[tauri::command]
pub async fn speech_list_jobs(root: String) -> Result<Vec<Job>> {
    tauri::async_runtime::spawn_blocking(move || list_jobs(Path::new(&root))).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_resume_job(folder: String) -> Result<Job> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut job = load_job(Path::new(&folder))?;
        let current = modified(Path::new(&job.source.path))?;
        if current != (job.source.size, job.source.modified) { return Err("原音频文件已更改，请创建新任务".into()); }
        rebuild(&mut job)?; Ok(job)
    }).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_decode_chunk(app: AppHandle, folder: String, offset: f64) -> Result<tauri::ipc::Response> {
    let dir = tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || decode_chunk(&dir, Path::new(&folder), offset).map(tauri::ipc::Response::new)).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_commit_chunk(folder: String, chunk: Chunk) -> Result<Job> {
    tauri::async_runtime::spawn_blocking(move || commit(Path::new(&folder), chunk)).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_cancel_job(folder: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || cancel_job(Path::new(&folder))).await.map_err(err)?
}
fn read_preview(folder: &Path, page: usize, query: &str) -> Result<Preview> {
    load_job(folder)?;
    let needle = query.trim().to_lowercase();
    let start = page.saturating_mul(100);
    let mut total = 0;
    let mut cues = Vec::new();
    for cue in read_chunks(folder, false)?.into_iter().flat_map(|chunk| chunk.cues) {
        if !needle.is_empty() && !cue.text.to_lowercase().contains(&needle) { continue; }
        if total >= start && cues.len() < 100 { cues.push(cue); }
        total += 1;
    }
    Ok(Preview { cues, total })
}
#[tauri::command]
pub async fn speech_read_result(folder: String, page: usize, query: Option<String>) -> Result<Preview> {
    tauri::async_runtime::spawn_blocking(move || read_preview(Path::new(&folder), page, query.as_deref().unwrap_or(""))).await.map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Job) {
        let root = std::env::temp_dir().join(format!("llmchat-speech-rust-{}-{:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), std::thread::current().id()));
        fs::create_dir_all(&root).unwrap(); let source_path = root.join("原音频.wav"); fs::write(&source_path, b"fixture").unwrap();
        let (size, time) = modified(&source_path).unwrap();
        let source = Source { path: source_path.to_string_lossy().into(), name: "原音频.wav".into(), size, modified: time, duration: 60.0 };
        let options = Options { model: "fixture".into(), language: "chinese".into(), chinese_script: "simplified".into(), formats: vec!["srt".into(), "vtt".into(), "txt".into()], processing: None };
        let job = create_job(&root, "test-id".into(), source, options, "2026-10-22").unwrap(); (root, job)
    }
    fn cleanup(root: PathBuf) {
        let resolved = root.canonicalize().unwrap();
        assert_eq!(resolved.parent().unwrap(), std::env::temp_dir().canonicalize().unwrap());
        assert!(resolved.file_name().unwrap().to_string_lossy().starts_with("llmchat-speech-rust-"));
        fs::remove_dir_all(resolved).unwrap();
    }
    #[test]
    fn preview_search_matches_all_pages() {
        let (root, job) = fixture();
        let folder = Path::new(&job.folder);
        let cues = (0..205).map(|index| Cue { start: index as f64 * 0.2, end: index as f64 * 0.2 + 0.1,
            text: format!("测试 {} {index}", if index % 2 == 0 { "KEYWORD" } else { "普通字幕" }) }).collect();
        commit(folder, Chunk { from: 0.0, to: 60.0, cues, text: "fixture".into() }).unwrap();
        let first = read_preview(folder, 0, " keyword ").unwrap();
        assert_eq!(first.total, 103); assert_eq!(first.cues.len(), 100);
        let last = read_preview(folder, 1, "kEyWoRd").unwrap();
        assert_eq!(last.total, 103); assert_eq!(last.cues.len(), 3);
        assert_eq!(last.cues[0].text, "测试 KEYWORD 200");
        assert_eq!(read_preview(folder, 2, "").unwrap().cues.len(), 5);
        assert_eq!(read_preview(folder, 0, "普通字幕").unwrap().total, 102);
        assert_eq!(read_preview(folder, 0, "不存在").unwrap().total, 0);
        cleanup(root);
    }
    #[test]
    fn processing_options_roundtrip_and_legacy() {
        let legacy = r#"{"model":"local","language":"auto","chineseScript":"simplified","formats":["srt"]}"#;
        let mut options: Options = serde_json::from_str(legacy).unwrap();
        assert!(options.processing.is_none());
        options.processing = Some(Processing { mode: "online".into(), provider: "google".into(), model: "gemini-test".into(), proofread: true, proofread_model: "chat-test".into() });
        let encoded = serde_json::to_string(&options).unwrap();
        let restored: Options = serde_json::from_str(&encoded).unwrap();
        let processing = restored.processing.unwrap();
        assert_eq!(processing.mode, "online"); assert!(processing.proofread);
        assert_eq!(processing.proofread_model, "chat-test");
        assert!(!encoded.contains("apiKey"));
    }
    #[test]
    fn dated_outputs_increment_without_overwriting() {
        let (root, job) = fixture();
        assert_eq!(job.output_stem.as_deref(), Some("原音频_2026-10-22"));
        fs::write(output_path(&job, "txt").unwrap(), "已有结果").unwrap();
        let jobs = std::thread::scope(|scope| {
            let second = scope.spawn(|| create_job(&root, "second-id".into(), job.source.clone(), job.options.clone(), "2026-10-22").unwrap());
            let third = scope.spawn(|| create_job(&root, "third-id".into(), job.source.clone(), job.options.clone(), "2026-10-22").unwrap());
            vec![second.join().unwrap(), third.join().unwrap()]
        });
        let mut names: Vec<_> = jobs.iter().map(|job| job.output_stem.as_deref().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec!["原音频_2026-10-22（2）", "原音频_2026-10-22（3）"]);
        for job in &jobs {
            for format in &job.options.formats {
                assert_eq!(output_path(job, format).unwrap().file_stem().unwrap().to_str(), job.output_stem.as_deref());
                assert!(output_path(job, format).unwrap().is_file());
            }
            assert_eq!(load_job(Path::new(&job.folder)).unwrap().output_stem, job.output_stem);
        }
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "已有结果");
        assert_eq!(list_jobs(&root).unwrap().len(), 3);
        cleanup(root);
    }
    #[test]
    fn legacy_task_keeps_original_output_names() {
        let (root, mut job) = fixture();
        let old_folder = PathBuf::from(&job.folder);
        let legacy_folder = root.join(format!("speech-{}", job.id));
        for format in &job.options.formats {
            fs::rename(output_path(&job, format).unwrap(), old_folder.join(format!("原音频.{format}"))).unwrap();
        }
        POSITIONS.lock().unwrap().remove(&old_folder);
        fs::rename(&old_folder, &legacy_folder).unwrap();
        job.folder = legacy_folder.to_string_lossy().into_owned();
        job.output_stem = None;
        fs::write(legacy_folder.join("job.json"), serde_json::to_vec(&job).unwrap()).unwrap();
        let chunk = Chunk { from: 0.0, to: 20.0, cues: vec![Cue { start: 1.0, end: 3.0, text: "旧任务续写".into() }], text: "旧任务续写".into() };
        let mut restored = commit(&legacy_folder, chunk).unwrap();
        rebuild(&mut restored).unwrap();
        assert_eq!(fs::read_to_string(legacy_folder.join("原音频.txt")).unwrap(), "旧任务续写\n");
        assert_eq!(list_jobs(&root).unwrap().len(), 1);
        cancel_job(&legacy_folder).unwrap();
        cleanup(root);
    }
    #[test]
    fn incremental_resume_and_cancel() {
        let (root, mut job) = fixture(); let folder = PathBuf::from(&job.folder);
        let chunk = Chunk { from: 0.0, to: 20.0, cues: vec![Cue { start: 1.0, end: 3.5, text: "简体字幕".into() }], text: "简体字幕".into() };
        job = commit(&folder, chunk.clone()).unwrap(); assert_eq!(job.offset, 20.0);
        assert!(fs::read_to_string(output_path(&job, "srt").unwrap()).unwrap().contains("00:00:01,000 --> 00:00:03,500"));
        assert!(commit(&folder, chunk).is_err(), "duplicate append must not duplicate output");
        OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap().write_all(b"{\"from\":20").unwrap();
        fs::write(output_path(&job, "txt").unwrap(), b"partial write").unwrap();
        rebuild(&mut job).unwrap(); assert_eq!(job.offset, 20.0);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "简体字幕\n");
        assert_eq!(read_chunks(&folder, false).unwrap().len(), 1);
        fs::write(folder.join("user-added.txt"), b"keep").unwrap();
        cancel_job(&folder).unwrap(); assert!(!output_path(&job, "srt").unwrap().exists());
        assert!(folder.join("user-added.txt").exists()); assert!(Path::new(&job.source.path).exists());
        cleanup(root);
    }
    #[test]
    fn restart_recovers_committed_progress() {
        let (root, job) = fixture(); let folder = PathBuf::from(&job.folder);
        assert!(!folder.join("job.json.tmp").exists());
        let chunk = Chunk { from: 0.0, to: 20.0, cues: vec![Cue { start: 1.0, end: 3.0, text: "第一段".into() }], text: "第一段".into() };
        commit(&folder, chunk).unwrap();
        // Simulate process loss: no in-memory position and an interrupted final write.
        POSITIONS.lock().unwrap().remove(&folder);
        assert_eq!(load_job(&folder).unwrap().offset, 0.0);
        OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap().write_all(b"{\"from\":20").unwrap();
        fs::write(output_path(&job, "txt").unwrap(), b"partial output").unwrap();
        let unpublished = root.join("speech-unpublished"); fs::create_dir(&unpublished).unwrap();
        fs::write(unpublished.join("job.json.tmp"), b"{").unwrap();
        let jobs = list_jobs(&root).unwrap(); assert_eq!(jobs.len(), 1); assert_eq!(jobs[0].offset, 20.0);
        let mut resumed = load_job(&folder).unwrap(); rebuild(&mut resumed).unwrap();
        assert_eq!(resumed.offset, 20.0); assert_eq!(resumed.cue_count, 1);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "第一段\n");
        let saved = commit(&folder, Chunk { from: 20.0, to: 40.0, cues: vec![Cue { start: 21.0, end: 23.0, text: "第二段".into() }], text: "第二段".into() }).unwrap();
        assert_eq!(saved.offset, 40.0); assert_eq!(saved.cue_count, 2);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "第一段\n第二段\n");
        assert_eq!(read_chunks(&folder, false).unwrap().len(), 2);
        POSITIONS.lock().unwrap().remove(&folder);
        cleanup(root);
    }
    #[test]
    fn ffmpeg_long_audio_uses_bounded_windows() {
        let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ffmpeg");
        assert!(tools.join("ffmpeg.exe").is_file(), "prepare-speech-tools.ps1 is required");
        let (root, template) = fixture();
        let path = root.join("long.flac");
        let generated = quiet_command(&tools.join("ffmpeg.exe")).args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "3605", "-c:a", "flac"]).arg(&path).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let source = probe(&tools, &path).unwrap(); assert!(source.duration > 3600.0);
        let job = create_job(&root, "long-id".into(), source, template.options, "2026-10-22").unwrap();
        let first = decode_chunk(&tools, Path::new(&job.folder), 0.0).unwrap();
        assert_eq!(first.len(), 30 * 16000 * 4);
        let tail = decode_chunk(&tools, Path::new(&job.folder), 3590.0).unwrap();
        assert_eq!(tail.len(), 15 * 16000 * 4);
        cleanup(root);
    }
}
