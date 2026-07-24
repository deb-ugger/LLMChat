use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct BackendChild(Mutex<Option<CommandChild>>);

fn start_backend(app: &AppHandle) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("llmchat-backend")
        .map_err(|e| e.to_string())?;

    let (mut rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;

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
                }
                CommandEvent::Error(err) => {
                    eprintln!("[backend error] {err}");
                }
                CommandEvent::Terminated(payload) => {
                    println!("[backend] terminated: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn stop_backend(app: &AppHandle) {
    let state = app.state::<BackendChild>();
    let child = {
        let mut guard = state.0.lock().unwrap();
        guard.take()
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendChild(Mutex::new(None)))
        .setup(|app| {
            if let Err(err) = start_backend(app.handle()) {
                eprintln!("Failed to start backend sidecar: {err}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                stop_backend(app_handle);
            }
        });
}
