#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) -> Result<(), std::io::Error> {
    use tauri::Emitter;
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateEventW(attributes: *const c_void, manual_reset: i32, initial: i32, name: *const u16) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // The build script first verifies this PID's executable belongs to its checkout.
    // The event only requests the normal frontend save/cancel guards; it cannot exit directly.
    let name = format!("Local\\LLMChat.Close.{}", std::process::id());
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, wide.as_ptr()) };
    if handle.is_null() { return Err(std::io::Error::last_os_error()); }
    let raw = handle as usize;
    let app = app.clone();
    let result = std::thread::Builder::new().name("build-close".into()).spawn(move || {
        let handle = raw as *mut c_void;
        while unsafe { WaitForSingleObject(handle, u32::MAX) } == 0 {
            let _ = super::runtime_log("build-close-requested", "Received build close signal; requesting normal frontend save/cancel guards");
            if let Err(error) = app.emit_to("main", "llmchat://close-requested", ()) {
                let _ = super::runtime_log("build-close-dispatch-error", &error.to_string());
            }
        }
        unsafe { CloseHandle(handle); }
    });
    if let Err(error) = result { unsafe { CloseHandle(handle); } return Err(error); }
    let _ = super::runtime_log("build-close-ready", &name);
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) -> Result<(), std::io::Error> { Ok(()) }
