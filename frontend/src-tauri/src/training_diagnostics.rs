use serde::Serialize;
use std::{fmt, fs, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingFailure {
    pub message: String,
    pub raw_output: String,
    pub log_path: String,
}

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn record(message: impl Into<String>, raw_output: impl Into<String>) -> TrainingFailure {
    let raw_output = raw_output.into();
    let directory = crate::training_storage::software_directory().unwrap_or_else(|_|std::env::temp_dir()).join("training-logs");
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let name = format!("{}-{stamp}-{}.log", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let mut path = directory.join(&name);
    let mut saved = fs::create_dir_all(&directory).and_then(|_| fs::write(&path, &raw_output));
    if saved.is_err() {
        let temporary = std::env::temp_dir().join("llmchat-training-logs");
        path = temporary.join(name);
        saved = fs::create_dir_all(&temporary).and_then(|_| fs::write(&path, &raw_output));
    }
    TrainingFailure {
        message: message.into(), raw_output,
        log_path: if saved.is_ok() { path.to_string_lossy().into_owned() } else { String::new() },
    }
}

impl fmt::Display for TrainingFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { self.message.fmt(formatter) }
}

impl From<String> for TrainingFailure {
    fn from(message: String) -> Self { record(message.clone(), message) }
}

impl From<&str> for TrainingFailure {
    fn from(message: &str) -> Self { record(message, message) }
}

impl From<TrainingFailure> for String {
    fn from(failure: TrainingFailure) -> Self { failure.message }
}
