use serde::Serialize;
use std::{cell::RefCell, fmt, fs, path::PathBuf, sync::atomic::{AtomicU64, Ordering}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingFailure {
    pub message: String,
    pub raw_output: String,
    pub log_path: String,
}

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
thread_local! { static DIRECTORY: RefCell<Option<PathBuf>> = const { RefCell::new(None) }; }

pub struct DiagnosticScope(Option<PathBuf>);
impl Drop for DiagnosticScope {
    fn drop(&mut self) { DIRECTORY.with(|directory| *directory.borrow_mut()=self.0.take()); }
}
pub fn scope(environment_dir:Option<&str>)->DiagnosticScope{
    let folder=environment_dir.filter(|value|!value.is_empty()).map(PathBuf::from).filter(|path|path.is_absolute())
        .and_then(|path|path.file_name().map(|name|path.with_file_name(format!("{}-logs",name.to_string_lossy()))));
    DiagnosticScope(DIRECTORY.with(|directory|directory.replace(folder)))
}

pub fn record(message: impl Into<String>, raw_output: impl Into<String>) -> TrainingFailure {
    let raw_output = raw_output.into();
    let directory = DIRECTORY.with(|directory|directory.borrow().clone()).or_else(||crate::training_storage::software_directory().ok().map(|path|path.join("training-logs")));
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let name = format!("{}-{stamp}-{}.log", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let path = directory.map(|directory|directory.join(name));
    let saved=path.as_ref().is_some_and(|path|fs::create_dir_all(path.parent().unwrap()).and_then(|_|fs::write(path,&raw_output)).is_ok());
    TrainingFailure {
        message: message.into(), raw_output,
        log_path: if saved { path.unwrap().to_string_lossy().into_owned() } else { String::new() },
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
