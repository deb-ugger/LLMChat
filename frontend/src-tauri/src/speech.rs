use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Manager};

// Only small commit positions are retained; transcript bodies stay on disk.
#[derive(Clone, Copy)]
enum Position { Ready(f64, usize), NeedsReplay }
type JobPosition = Arc<Mutex<Option<Position>>>;
static POSITIONS: LazyLock<Mutex<HashMap<PathBuf, JobPosition>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ROOTS_LOCK: Mutex<()> = Mutex::new(());
// Keep only file positions, not transcript text. Each folder retains its latest search.
#[derive(Default)]
struct PreviewIndex {
    length: u64,
    modified: Option<std::time::SystemTime>,
    committed: u64,
    end: f64,
    query: String,
    matches: Vec<(u64, usize)>,
}
static PREVIEW_INDEXES: LazyLock<Mutex<HashMap<PathBuf, PreviewIndex>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
pub struct SpeechStorage(pub PathBuf);
const PENDING_MARKER: &str = ".llmchat-speech-pending";
const PENDING_SIGNATURE: &[u8] = b"llmchat-speech-pending-v1\n";
type Result<T> = std::result::Result<T, String>;
fn err(error: impl std::fmt::Display) -> String { error.to_string() }

fn write_job_json(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let saved = (|| {
        let mut file = File::create(&temporary).map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.sync_data().map_err(err)?;
        drop(file);
        fs::rename(&temporary, path).map_err(err)
    })();
    if saved.is_err() { let _ = fs::remove_file(temporary); }
    saved
}

fn register_output_root(app: &AppHandle, root: &Path) -> Result<()> {
    if !root.is_absolute() { return Err("语音输出目录必须是绝对路径".into()); }
    let _lock = ROOTS_LOCK.lock().unwrap();
    let registry = app.state::<SpeechStorage>().0.join("speech-output-roots.json");
    let mut roots: Vec<PathBuf> = if registry.exists() { serde_json::from_slice(&fs::read(&registry).map_err(err)?).map_err(err)? } else { Vec::new() };
    let root = if root.exists() { fs::canonicalize(root).map_err(err)? } else { root.to_path_buf() };
    if roots.contains(&root) { return Ok(()); }
    roots.push(root);
    write_job_json(&registry, &serde_json::to_vec(&roots).map_err(err)?)
}

struct UnpublishedJob { folder: PathBuf, published: bool }
impl Drop for UnpublishedJob {
    fn drop(&mut self) {
        if self.published { return; }
        POSITIONS.lock().unwrap().remove(&self.folder);
        let stem = self.folder.file_name().unwrap().to_string_lossy();
        for name in [PENDING_MARKER.to_string(), "job.json.tmp".into(), "progress.jsonl".into(), format!("{stem}.srt"), format!("{stem}.vtt"), format!("{stem}.txt")] {
            let path = self.folder.join(name);
            if path.is_file() { if let Err(error) = fs::remove_file(&path) { eprintln!("Speech temporary cleanup failed: {}: {error}", path.display()); } }
        }
        match fs::remove_dir(&self.folder) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => (),
            Err(error) => eprintln!("Speech temporary cleanup failed: {}: {error}", self.folder.display()),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Cue { pub start: f64, pub end: f64, pub text: String }
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub model: String, pub language: String, pub chinese_script: String, pub formats: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processing: Option<Processing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ranges: Option<Vec<AudioRange>>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct AudioRange { pub start: f64, pub end: f64 }
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
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_stem: Option<String>,
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum ListedJob {
    Ready {
        #[serde(flatten)]
        job: Job,
        #[serde(rename = "recoveryError", skip_serializing_if = "Option::is_none")]
        recovery_error: Option<String>,
    },
    Broken {
        folder: String,
        name: String,
        #[serde(rename = "loadError")]
        load_error: String,
        #[serde(rename = "canClean")]
        can_clean: bool,
    },
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
fn validate_options(options: &Options, duration: f64) -> Result<()> {
    if options.formats.is_empty() || options.formats.iter().any(|f| !["srt", "vtt", "txt"].contains(&f.as_str())) {
        return Err("至少选择一种有效输出格式".into());
    }
    if let Some(ranges) = &options.ranges {
        if ranges.is_empty() { return Err("请先选取音频片段".into()); }
        let mut previous = 0.0;
        for range in ranges {
            if !range.start.is_finite() || !range.end.is_finite() || range.start < previous || range.end > duration || range.end <= range.start {
                return Err("音频选段无效、重叠或超出原音频范围".into());
            }
            previous = range.end;
        }
    }
    Ok(())
}
fn load_job(folder: &Path) -> Result<Job> {
    parse_job(folder, &fs::read(folder.join("job.json")).map_err(err)?)
}
fn parse_job(folder: &Path, bytes: &[u8]) -> Result<Job> {
    let job: Job = serde_json::from_slice(bytes).map_err(err)?;
    let legacy_folder = format!("speech-{}", job.id);
    if folder.file_name().and_then(|n| n.to_str()) != Some(job.output_stem.as_deref().unwrap_or(&legacy_folder)) {
        return Err("不是有效的语音任务目录".into());
    }
    validate_options(&job.options, job.source.duration)?;
    Ok(Job { folder: folder.to_string_lossy().into_owned(), ..job })
}
fn next_chunk(reader: &mut impl BufRead, line: &mut Vec<u8>, expected: f64) -> Result<Option<Chunk>> {
    line.clear();
    reader.read_until(b'\n', line).map_err(err)?;
    // A torn final append is not committed; retry that audio window on resume.
    if line.last() != Some(&b'\n') { return Ok(None); }
    let chunk: Chunk = serde_json::from_slice(line).map_err(|e| format!("任务进度文件损坏：{e}"))?;
    if (chunk.from - expected).abs() > 0.001 || !chunk.to.is_finite() || chunk.to <= chunk.from {
        return Err("任务进度不连续".into());
    }
    Ok(Some(chunk))
}

fn visit_chunks(folder: &Path, repair: bool, mut visit: impl FnMut(Chunk)) -> Result<(f64, usize)> {
    let path = folder.join("progress.jsonl");
    let mut reader = BufReader::new(File::open(&path).map_err(err)?);
    let mut line = Vec::new();
    let mut valid_bytes = 0u64;
    let mut expected = 0.0;
    let mut cues = 0;
    while let Some(chunk) = next_chunk(&mut reader, &mut line, expected)? {
        expected = chunk.to;
        valid_bytes += line.len() as u64;
        cues += chunk.cues.len();
        visit(chunk);
    }
    if repair && !line.is_empty() {
        OpenOptions::new().write(true).open(path).map_err(err)?.set_len(valid_bytes).map_err(err)?;
    }
    Ok((expected, cues))
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
    let mut files = job.options.formats.iter().map(|format| {
        let path = output_path(job, format)?;
        let file = OpenOptions::new().create(true).write(true).append(!truncate)
            .open(&path).map_err(|error| format!("{}：{error}", path.display()))?;
        Ok((format.clone(), file))
    }).collect::<Result<Vec<_>>>()?;
    // Check that every destination can be opened before replacing any existing export.
    if truncate {
        for (format, file) in &mut files {
            file.set_len(0).map_err(err)?;
            if format == "vtt" { file.write_all(b"WEBVTT\n\n").map_err(err)?; }
        }
    }
    Ok(files)
}
fn restore_outputs(job: &mut Job, require_audio_for_remaining: bool) -> Result<()> {
    // Validate the journal completely before truncating the user's exported files.
    let mut chunks = Vec::new();
    let (offset, cues) = visit_chunks(Path::new(&job.folder), true, |chunk| chunks.push(chunk))?;
    if require_audio_for_remaining && offset < job.source.duration - 0.01
        && modified(Path::new(&job.source.path))? != (job.source.size, job.source.modified) {
        return Err("原音频文件已更改，请创建新任务".into());
    }
    let mut files = open_outputs(job, true)?;
    let mut count = 0;
    for chunk in &chunks {
        for (format, file) in &mut files { file.write_all(chunk_text(chunk, format, count).as_bytes()).map_err(err)?; }
        count += chunk.cues.len();
    }
    for (_, file) in files { file.sync_data().map_err(err)?; }
    job.offset = offset;
    job.cue_count = cues;
    Ok(())
}

// Same-job operations serialize, while different files can flush their subtitles concurrently.
fn with_position<T>(folder: &Path, work: impl FnOnce(&mut Option<Position>) -> Result<T>) -> Result<T> {
    let slot = POSITIONS.lock().unwrap().entry(folder.to_owned()).or_default().clone();
    let mut position = slot.lock().unwrap();
    let result = work(&mut position);
    if position.is_none() {
        let mut positions = POSITIONS.lock().unwrap();
        // Keep the slot while a caller is already waiting on its lock.
        if Arc::strong_count(&slot) == 2 { positions.remove(folder); }
    }
    result
}

fn position_after(job: &Job) -> Option<Position> {
    (job.offset < job.source.duration - 0.01).then_some(Position::Ready(job.offset, job.cue_count))
}

fn rebuild(job: &mut Job, require_audio_for_remaining: bool) -> Result<()> {
    with_position(&PathBuf::from(&job.folder), |position| {
        *position = Some(Position::NeedsReplay);
        restore_outputs(job, require_audio_for_remaining)?;
        *position = position_after(job);
        Ok(())
    })
}
fn create_job(root: &Path, id: String, source: Source, options: Options, output_date: &str) -> Result<Job> {
    if id.len() > 64 || id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("无效任务 ID".into()); }
    validate_options(&options, source.duration)?;
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
    let mut pending = UnpublishedJob { folder: folder.clone(), published: false };
    let mut marker = File::create(folder.join(PENDING_MARKER)).map_err(err)?;
    marker.write_all(PENDING_SIGNATURE).map_err(err)?; marker.sync_data().map_err(err)?; drop(marker);
    let mut job = Job { id, folder: folder.to_string_lossy().into_owned(), source, options, offset: 0.0, cue_count: 0, elapsed_ms: 0, output_stem: Some(output_stem) };
    File::create(folder.join("progress.jsonl")).map_err(err)?.sync_data().map_err(err)?;
    rebuild(&mut job, false)?;
    // Publish the task only after its journal and output headers exist.
    write_job_json(&folder.join("job.json"), &serde_json::to_vec_pretty(&job).map_err(err)?)?;
    pending.published = true;
    if let Err(error) = fs::remove_file(folder.join(PENDING_MARKER)) { eprintln!("Speech pending marker cleanup failed: {error}"); }
    Ok(job)
}
fn commit(folder: &Path, chunk: Chunk, elapsed_ms: Option<u64>) -> Result<Job> {
    with_position(folder, |position| {
        let mut job = load_job(folder)?;
        let (offset, count) = match *position {
            Some(Position::Ready(offset, count)) => (offset, count),
            Some(Position::NeedsReplay) | None => {
                *position = Some(Position::NeedsReplay);
                restore_outputs(&mut job, false)?;
                *position = position_after(&job);
                (job.offset, job.cue_count)
            }
        };
        if (chunk.from - offset).abs() > 0.001 || !chunk.to.is_finite() || chunk.to <= offset || chunk.to > job.source.duration + 0.1 {
            return Err("保存位置与任务断点不一致".into());
        }
        if chunk.cues.iter().any(|cue| !cue.start.is_finite() || !cue.end.is_finite() || cue.start < chunk.from - 0.001 || cue.end > chunk.to + 0.001 || cue.end <= cue.start
            || job.options.ranges.as_ref().is_some_and(|ranges| !ranges.iter().any(|range| cue.start >= range.start - 0.001 && cue.end <= range.end + 0.001))) {
            return Err("字幕时间超出当前音频片段".into());
        }
        let mut record = serde_json::to_vec(&chunk).map_err(err)?; record.push(b'\n');
        let mut journal = OpenOptions::new().append(true).open(folder.join("progress.jsonl")).map_err(err)?;
        *position = Some(Position::NeedsReplay);
        journal.write_all(&record).map_err(err)?; journal.sync_data().map_err(err)?;
        // Journal is authoritative. Resume rebuilds outputs if power fails during writes.
        for (format, mut file) in open_outputs(&job, false)? {
            file.write_all(chunk_text(&chunk, &format, count).as_bytes()).map_err(err)?; file.sync_data().map_err(err)?;
        }
        if let Some(elapsed) = elapsed_ms { update_elapsed(folder, &mut job, elapsed)?; }
        job.offset = chunk.to; job.cue_count = count + chunk.cues.len();
        *position = position_after(&job);
        Ok(job)
    })
}
fn update_elapsed(folder: &Path, job: &mut Job, elapsed_ms: u64) -> Result<u64> {
    if elapsed_ms > job.elapsed_ms {
        job.elapsed_ms = elapsed_ms;
        write_job_json(&folder.join("job.json"), &serde_json::to_vec_pretty(job).map_err(err)?)?;
    }
    Ok(job.elapsed_ms)
}
fn save_elapsed(folder: &Path, elapsed_ms: u64) -> Result<u64> {
    with_position(folder, |_| update_elapsed(folder, &mut load_job(folder)?, elapsed_ms))
}
fn remove_file_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{}：{error}", path.display())),
    }
}

fn cancel_job(folder: &Path) -> Result<()> {
    with_position(folder, |position| {
        let manifest = folder.join("job.json");
        let job = match fs::read(&manifest) {
            Ok(bytes) => Some(parse_job(folder, &bytes)?),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(err(error)),
        };
        if let Some(job) = &job {
            for format in &job.options.formats {
                remove_file_if_present(&output_path(job, format)?)?;
            }
            remove_file_if_present(&folder.join("progress.jsonl"))?;
            remove_file_if_present(&manifest)?;
        }
        *position = None;
        PREVIEW_INDEXES.lock().unwrap().remove(folder);
        if job.is_none() { return Ok(()); }
        // Do not recursively delete unexpected/user-added files.
        match fs::remove_dir(folder) {
            Ok(()) => Ok(()),
            Err(error) if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty) => Ok(()),
            Err(error) => Err(err(error)),
        }
    })
}
fn decode_duration(job: &Job, offset: f64) -> Result<f64> {
    if !offset.is_finite() || offset < 0.0 || offset >= job.source.duration { return Err("无效解码位置".into()); }
    let end = if let Some(ranges) = &job.options.ranges {
        ranges.iter().find(|range| offset >= range.start && offset < range.end).ok_or("解码位置不在所选音频片段内")?.end
    } else { job.source.duration };
    Ok((end - offset).min(30.0))
}
fn decode_chunk(dir: &Path, folder: &Path, offset: f64) -> Result<Vec<u8>> {
    let job = load_job(folder)?;
    let duration = decode_duration(&job, offset)?;
    let output = quiet_command(&dir.join("ffmpeg.exe"))
        .args(["-nostdin", "-v", "error", "-ss", &format!("{offset:.6}"), "-i"]).arg(&job.source.path)
        .args(["-t", &format!("{duration:.6}"), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-threads", "1", "-f", "f32le", "pipe:1"])
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
pub async fn speech_create_job(app: AppHandle, root: String, id: String, source: Source, options: Options, output_date: String) -> Result<Job> {
    register_output_root(&app, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || create_job(Path::new(&root), id, source, options, &output_date)).await.map_err(err)?
}
fn inspect_job(folder: &Path, position: &mut Option<Position>) -> Result<Option<ListedJob>> {
    let broken = |load_error: String, can_clean| ListedJob::Broken {
        folder: folder.to_string_lossy().into_owned(),
        name: folder.file_name().unwrap_or(folder.as_os_str()).to_string_lossy().into_owned(),
        load_error,
        can_clean,
    };
    let bytes = match fs::read(folder.join("job.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Ok(Some(broken(format!("无法读取任务文件：{error}"), false))),
    };
    let mut job = match parse_job(folder, &bytes) {
        Ok(job) => job,
        Err(error) => return Ok(Some(broken(format!("任务文件无效：{error}"), false))),
    };

    let mut lengths: Vec<u64> = job.options.formats.iter()
        .map(|format| if format == "vtt" { b"WEBVTT\n\n".len() as u64 } else { 0 })
        .collect();
    let mut count = 0;
    (job.offset, job.cue_count) = match visit_chunks(folder, false, |chunk| {
        for (format, length) in job.options.formats.iter().zip(&mut lengths) {
            *length += chunk_text(&chunk, format, count).len() as u64;
        }
        count += chunk.cues.len();
    }) {
        Ok(progress) => progress,
        Err(error) => return Ok(Some(broken(format!("无法恢复任务进度：{error}"), true))),
    };

    let recovery_error = if job.offset >= job.source.duration - 0.01
        && job.options.formats.iter().zip(lengths).any(|(format, length)| {
            !output_path(&job, format).and_then(|path| fs::metadata(path).map_err(err))
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() == length)
        }) {
        // A committed final chunk is complete only once all configured exports are on disk.
        *position = Some(Position::NeedsReplay);
        match restore_outputs(&mut job, false) {
            Ok(()) => { *position = position_after(&job); None }
            Err(error) => Some(format!("字幕输出修复失败：{error}")),
        }
    } else {
        None
    };
    Ok(Some(ListedJob::Ready { job, recovery_error }))
}

fn list_jobs(root: &Path) -> Result<Vec<ListedJob>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(err(error)),
    };
    let mut jobs = Vec::new();
    for entry in entries {
        let folder = entry.map_err(err)?.path();
        if !folder.is_dir() { continue; }
        if let Some(job) = with_position(&folder, |position| inspect_job(&folder, position))? {
            jobs.push(job);
        }
    }
    Ok(jobs)
}
#[tauri::command]
pub async fn speech_list_jobs(app: AppHandle, root: String) -> Result<Vec<ListedJob>> {
    register_output_root(&app, Path::new(&root))?;
    tauri::async_runtime::spawn_blocking(move || list_jobs(Path::new(&root))).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_resume_job(folder: String) -> Result<Job> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut job = load_job(Path::new(&folder))?;
        rebuild(&mut job, true)?; Ok(job)
    }).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_decode_chunk(app: AppHandle, folder: String, offset: f64) -> Result<tauri::ipc::Response> {
    let dir = tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || decode_chunk(&dir, Path::new(&folder), offset).map(tauri::ipc::Response::new)).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_commit_chunk(folder: String, chunk: Chunk, elapsed_ms: Option<u64>) -> Result<Job> {
    tauri::async_runtime::spawn_blocking(move || commit(Path::new(&folder), chunk, elapsed_ms)).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_save_elapsed(folder: String, elapsed_ms: u64) -> Result<u64> {
    tauri::async_runtime::spawn_blocking(move || save_elapsed(Path::new(&folder), elapsed_ms)).await.map_err(err)?
}
#[tauri::command]
pub async fn speech_cancel_job(folder: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || cancel_job(Path::new(&folder))).await.map_err(err)?
}
fn read_preview(folder: &Path, page: usize, query: &str) -> Result<Preview> {
    load_job(folder)?;
    let needle = query.trim().to_lowercase();
    let file = File::open(folder.join("progress.jsonl")).map_err(err)?;
    let metadata = file.metadata().map_err(err)?;
    let mut indexes = PREVIEW_INDEXES.lock().unwrap();
    let index = indexes.entry(folder.to_path_buf()).or_default();
    // The journal is append-only; truncation/replacement or a new search rebuilds positions.
    if index.query != needle || metadata.len() < index.length
        || (metadata.len() == index.length && metadata.modified().ok() != index.modified) {
        *index = PreviewIndex { query: needle, ..PreviewIndex::default() };
    }
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(index.committed)).map_err(err)?;
    let mut line = Vec::new();
    while let Some(chunk) = next_chunk(&mut reader, &mut line, index.end)? {
        for (cue_index, cue) in chunk.cues.iter().enumerate() {
            if index.query.is_empty() || cue.text.to_lowercase().contains(&index.query) {
                index.matches.push((index.committed, cue_index));
            }
        }
        index.end = chunk.to;
        index.committed += line.len() as u64;
    }
    index.length = metadata.len();
    index.modified = metadata.modified().ok();
    let start = page.saturating_mul(100);
    let total = index.matches.len();
    let mut cues = Vec::new();
    let mut current_offset = None;
    let mut chunk: Option<Chunk> = None;
    for &(offset, cue_index) in index.matches.iter().skip(start).take(100) {
        if current_offset != Some(offset) {
            reader.seek(SeekFrom::Start(offset)).map_err(err)?;
            line.clear();
            reader.read_until(b'\n', &mut line).map_err(err)?;
            chunk = Some(serde_json::from_slice(&line).map_err(err)?);
            current_offset = Some(offset);
        }
        cues.push(chunk.as_ref().unwrap().cues[cue_index].clone());
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
        let options = Options { model: "fixture".into(), language: "chinese".into(), chinese_script: "simplified".into(), formats: vec!["srt".into(), "vtt".into(), "txt".into()], processing: None, ranges: None };
        let job = create_job(&root, "test-id".into(), source, options, "2026-10-22").unwrap(); (root, job)
    }
    fn committed_records(folder: &Path) -> usize {
        let mut records = 0;
        visit_chunks(folder, false, |_| records += 1).unwrap();
        records
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
        commit(folder, Chunk { from: 0.0, to: 60.0, cues, text: "fixture".into() }, None).unwrap();
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
    fn preview_index_tracks_append_and_truncated_tail() {
        let (root, job) = fixture();
        let folder = Path::new(&job.folder);
        let make_chunk = |from: f64, to: f64, count: usize| Chunk { from, to,
            cues: (0..count).map(|i| Cue { start: from, end: to, text: format!("match {from} {i}") }).collect(), text: "fixture".into() };
        commit(folder, make_chunk(0.0, 20.0, 105), None).unwrap();
        assert_eq!(read_preview(folder, 1, "match").unwrap().cues.len(), 5);
        let committed = PREVIEW_INDEXES.lock().unwrap()[folder].committed;
        commit(folder, make_chunk(20.0, 40.0, 10), None).unwrap();
        let preview = read_preview(folder, 1, "MATCH").unwrap();
        assert_eq!(preview.total, 115);
        assert_eq!(preview.cues.len(), 15);
        assert_eq!(preview.cues[5].text, "match 20 0");
        let indexed = PREVIEW_INDEXES.lock().unwrap()[folder].committed;
        assert!(indexed > committed);
        assert_eq!(read_preview(folder, 0, "match").unwrap().total, 115);
        assert_eq!(PREVIEW_INDEXES.lock().unwrap()[folder].committed, indexed);
        let tail = serde_json::to_vec(&make_chunk(40.0, 60.0, 2)).unwrap();
        let mut journal = OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap();
        journal.write_all(&tail[..tail.len() / 2]).unwrap(); journal.flush().unwrap();
        assert_eq!(read_preview(folder, 0, "match").unwrap().total, 115, "partial append is not visible");
        journal.write_all(&tail[tail.len() / 2..]).unwrap(); journal.write_all(b"\n").unwrap(); journal.flush().unwrap();
        assert_eq!(read_preview(folder, 1, "match").unwrap().total, 117);
        drop(journal);
        OpenOptions::new().write(true).open(folder.join("progress.jsonl")).unwrap().set_len(committed).unwrap();
        assert_eq!(read_preview(folder, 1, "match").unwrap().total, 105, "truncation resets cached positions");
        PREVIEW_INDEXES.lock().unwrap().remove(folder);
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
        let mut restored = commit(&legacy_folder, chunk, None).unwrap();
        rebuild(&mut restored, false).unwrap();
        assert_eq!(fs::read_to_string(legacy_folder.join("原音频.txt")).unwrap(), "旧任务续写\n");
        assert_eq!(list_jobs(&root).unwrap().len(), 1);
        cancel_job(&legacy_folder).unwrap();
        cleanup(root);
    }
    #[test]
    fn incremental_resume_and_cancel() {
        let (root, mut job) = fixture(); let folder = PathBuf::from(&job.folder);
        let chunk = Chunk { from: 0.0, to: 20.0, cues: vec![Cue { start: 1.0, end: 3.5, text: "简体字幕".into() }], text: "简体字幕".into() };
        job = commit(&folder, chunk.clone(), None).unwrap(); assert_eq!(job.offset, 20.0);
        assert!(fs::read_to_string(output_path(&job, "srt").unwrap()).unwrap().contains("00:00:01,000 --> 00:00:03,500"));
        assert!(commit(&folder, chunk, None).is_err(), "duplicate append must not duplicate output");
        OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap().write_all(b"{\"from\":20").unwrap();
        fs::write(output_path(&job, "txt").unwrap(), b"partial write").unwrap();
        rebuild(&mut job, false).unwrap(); assert_eq!(job.offset, 20.0);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "简体字幕\n");
        assert_eq!(committed_records(&folder), 1);
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
        commit(&folder, chunk, None).unwrap();
        // Simulate process loss: no in-memory position and an interrupted final write.
        POSITIONS.lock().unwrap().remove(&folder);
        assert_eq!(load_job(&folder).unwrap().offset, 0.0);
        OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap().write_all(b"{\"from\":20").unwrap();
        fs::write(output_path(&job, "txt").unwrap(), b"partial output").unwrap();
        let unpublished = root.join("speech-unpublished"); fs::create_dir(&unpublished).unwrap();
        fs::write(unpublished.join("job.json.tmp"), b"{").unwrap();
        let jobs = list_jobs(&root).unwrap(); assert_eq!(jobs.len(), 1);
        assert!(matches!(&jobs[0], ListedJob::Ready { job, .. } if job.offset == 20.0));
        let mut resumed = load_job(&folder).unwrap(); rebuild(&mut resumed, true).unwrap();
        assert_eq!(resumed.offset, 20.0); assert_eq!(resumed.cue_count, 1);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "第一段\n");
        let saved = commit(&folder, Chunk { from: 20.0, to: 40.0, cues: vec![Cue { start: 21.0, end: 23.0, text: "第二段".into() }], text: "第二段".into() }, None).unwrap();
        assert_eq!(saved.offset, 40.0); assert_eq!(saved.cue_count, 2);
        assert_eq!(fs::read_to_string(output_path(&job, "txt").unwrap()).unwrap(), "第一段\n第二段\n");
        assert_eq!(committed_records(&folder), 2);
        POSITIONS.lock().unwrap().remove(&folder);
        cleanup(root);
    }
    #[test]
    fn job_recovery_replays_final_exports_before_completion() {
        let (root, job) = fixture();
        let folder = Path::new(&job.folder);
        let first = Chunk { from: 0.0, to: 20.0, cues: vec![Cue { start: 1.0, end: 2.0, text: "第一段".into() }], text: "第一段".into() };
        commit(folder, first, None).unwrap();
        let last = Chunk { from: 20.0, to: 60.0, cues: vec![Cue { start: 21.0, end: 24.0, text: "最后一段".into() }], text: "最后一段".into() };
        let mut journal = OpenOptions::new().append(true).open(folder.join("progress.jsonl")).unwrap();
        serde_json::to_writer(&mut journal, &last).unwrap();
        journal.write_all(b"\n").unwrap();
        journal.sync_data().unwrap();
        drop(journal);
        let vtt = output_path(&job, "vtt").unwrap();
        let srt = output_path(&job, "srt").unwrap();
        let txt = output_path(&job, "txt").unwrap();
        fs::remove_file(&vtt).unwrap();
        POSITIONS.lock().unwrap().remove(folder);

        let listed = list_jobs(&root).unwrap();
        assert!(matches!(&listed[..], [ListedJob::Ready { job, recovery_error: None }] if job.offset == 60.0 && job.cue_count == 2));
        assert_eq!(fs::read_to_string(&txt).unwrap(), "第一段\n最后一段\n");
        assert!(fs::read_to_string(&srt).unwrap().contains("2\n00:00:21,000 --> 00:00:24,000"));
        assert!(fs::read_to_string(&vtt).unwrap().starts_with("WEBVTT\n\n"));

        fs::remove_file(&vtt).unwrap();
        fs::create_dir(&vtt).unwrap();
        let listed = list_jobs(&root).unwrap();
        assert!(matches!(&listed[..], [ListedJob::Ready { job, recovery_error: Some(error) }] if job.offset == 60.0 && error.contains("字幕输出修复失败")));
        assert!(fs::read_to_string(&srt).unwrap().contains("2\n00:00:21,000 --> 00:00:24,000"));
        fs::remove_dir(&vtt).unwrap();
        // The journal already contains all audio, so repairing exports requires no source audio.
        fs::remove_file(&job.source.path).unwrap();
        let mut retry = load_job(folder).unwrap();
        rebuild(&mut retry, true).unwrap();
        assert_eq!(retry.offset, 60.0);
        assert_eq!(fs::read_to_string(&txt).unwrap(), "第一段\n最后一段\n");
        assert_eq!(committed_records(folder), 2);
        cleanup(root);
    }

    #[test]
    fn job_recovery_lists_good_and_broken_tasks_together() {
        let (root, good) = fixture();
        let bad_manifest = root.join("bad-metadata");
        fs::create_dir(&bad_manifest).unwrap();
        fs::write(bad_manifest.join("job.json"), b"{").unwrap();
        let bad_journal = create_job(&root, "bad-journal".into(), good.source.clone(), good.options.clone(), "2026-10-22").unwrap();
        fs::remove_file(Path::new(&bad_journal.folder).join("progress.jsonl")).unwrap();

        let jobs = list_jobs(&root).unwrap();
        assert_eq!(jobs.len(), 3);
        assert!(jobs.iter().any(|item| matches!(item, ListedJob::Ready { job, recovery_error: None } if job.id == good.id)));
        assert!(jobs.iter().any(|item| matches!(item, ListedJob::Broken { name, load_error, can_clean: false, .. }
            if name == "bad-metadata" && load_error.contains("任务文件无效"))));
        assert!(jobs.iter().any(|item| matches!(item, ListedJob::Broken { folder, load_error, can_clean: true, .. }
            if folder == &bad_journal.folder && load_error.contains("无法恢复任务进度"))));
        cancel_job(Path::new(&bad_journal.folder)).unwrap();
        assert_eq!(list_jobs(&root).unwrap().len(), 2);
        POSITIONS.lock().unwrap().remove(Path::new(&good.folder));
        cleanup(root);
    }

    #[test]
    fn job_recovery_retries_partial_cleanup() {
        let (root, job) = fixture();
        let folder = Path::new(&job.folder);
        let manifest = folder.join("job.json");
        let user_file = folder.join("keep.txt");
        fs::write(&user_file, "用户文件").unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let locked_manifest = OpenOptions::new().read(true).share_mode(0x3).open(&manifest).unwrap();
            assert!(cancel_job(folder).is_err(), "the open manifest prevents the last deletion");
            assert!(manifest.is_file());
            assert!(!folder.join("progress.jsonl").exists());
            for format in &job.options.formats { assert!(!output_path(&job, format).unwrap().exists()); }
            drop(locked_manifest);
        }
        #[cfg(not(windows))]
        {
            for format in &job.options.formats { fs::remove_file(output_path(&job, format).unwrap()).unwrap(); }
            fs::remove_file(folder.join("progress.jsonl")).unwrap();
        }

        cancel_job(folder).unwrap();
        cancel_job(folder).unwrap();
        assert!(!manifest.exists());
        assert_eq!(fs::read_to_string(user_file).unwrap(), "用户文件");
        assert!(Path::new(&job.source.path).is_file());
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
