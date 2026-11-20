use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Files the OS asked us to open (command-line arguments or macOS "Open With")
/// that the web UI has not picked up yet.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

fn is_pdf(path: &Path) -> bool {
  path
    .extension()
    .and_then(|e| e.to_str())
    .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Reads a PDF from disk and returns its raw bytes (sent as binary, not JSON).
#[tauri::command]
fn read_pdf(path: String) -> Result<tauri::ipc::Response, String> {
  let path = Path::new(&path);
  if !is_pdf(path) {
    return Err("Only .pdf files can be opened.".into());
  }
  std::fs::read(path)
    .map(tauri::ipc::Response::new)
    .map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> Result<String, String> {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
      out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|e| e.to_string())
}

/// Writes a PDF to disk. The bytes arrive as the raw request body and the path as a
/// percent-encoded `x-path` header. Writes to a temporary file first, then renames it
/// over the target, so a failed save never leaves a half-written PDF.
#[tauri::command]
fn write_pdf(request: tauri::ipc::Request) -> Result<(), String> {
  let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
    return Err("Expected the file contents as raw bytes.".into());
  };
  let header = request
    .headers()
    .get("x-path")
    .and_then(|v| v.to_str().ok())
    .ok_or("Missing destination path.")?;
  let path = PathBuf::from(percent_decode(header)?);
  if !is_pdf(&path) {
    return Err("Only .pdf files can be saved.".into());
  }
  let file_name = path.file_name().ok_or("Invalid file name.")?.to_string_lossy();
  let tmp = path.with_file_name(format!(".{file_name}.pdfstudio-tmp"));
  std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
  std::fs::rename(&tmp, &path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp);
    e.to_string()
  })
}

#[tauri::command]
fn exit_app<R: Runtime>(app: AppHandle<R>) {
  app.exit(0);
}

/// Returns and clears the list of files waiting to be opened.
#[tauri::command]
fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
  std::mem::take(&mut *state.0.lock().unwrap())
}

fn queue_files<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
  if paths.is_empty() {
    return;
  }
  app.state::<PendingFiles>().0.lock().unwrap().extend(paths);
  // The UI responds by calling `take_pending_files`.
  let _ = app.emit("open-files", ());
}

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
  let item = |id: &str, label: &str, accel: &str| {
    MenuItem::with_id(app, id, label, true, Some(accel))
  };

  #[cfg(target_os = "macos")]
  let file = Submenu::with_items(
    app,
    "File",
    true,
    &[
      &item("open", "Open…", "CmdOrCtrl+O")?,
      &PredefinedMenuItem::separator(app)?,
      &item("save", "Save", "CmdOrCtrl+S")?,
      &item("save_as", "Save As…", "CmdOrCtrl+Shift+S")?,
      &PredefinedMenuItem::separator(app)?,
      &item("combine", "Combine Files…", "CmdOrCtrl+Alt+C")?,
      &item("compress", "Reduce File Size…", "CmdOrCtrl+Alt+R")?,
      &PredefinedMenuItem::separator(app)?,
      &item("close_tab", "Close Tab", "CmdOrCtrl+W")?,
    ],
  )?;
  #[cfg(not(target_os = "macos"))]
  let file = Submenu::with_items(
    app,
    "File",
    true,
    &[
      &item("open", "Open…", "CmdOrCtrl+O")?,
      &PredefinedMenuItem::separator(app)?,
      &item("save", "Save", "CmdOrCtrl+S")?,
      &item("save_as", "Save As…", "CmdOrCtrl+Shift+S")?,
      &PredefinedMenuItem::separator(app)?,
      &item("combine", "Combine Files…", "CmdOrCtrl+Alt+C")?,
      &item("compress", "Reduce File Size…", "CmdOrCtrl+Alt+R")?,
      &PredefinedMenuItem::separator(app)?,
      &item("close_tab", "Close Tab", "CmdOrCtrl+W")?,
      &PredefinedMenuItem::separator(app)?,
      &item("quit", "Exit", "Alt+F4")?,
    ],
  )?;

  let edit = Submenu::with_items(
    app,
    "Edit",
    true,
    &[
      // Custom so they undo annotation changes; text fields are handled in the UI.
      &item("undo", "Undo", "CmdOrCtrl+Z")?,
      &item("redo", "Redo", "CmdOrCtrl+Shift+Z")?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;

  let view = Submenu::with_items(
    app,
    "View",
    true,
    &[
      &item("find", "Find…", "CmdOrCtrl+F")?,
      &PredefinedMenuItem::separator(app)?,
      &item("zoom_in", "Zoom In", "CmdOrCtrl+=")?,
      &item("zoom_out", "Zoom Out", "CmdOrCtrl+-")?,
      &item("actual_size", "Actual Size", "CmdOrCtrl+0")?,
      &item("fit_width", "Fit Width", "CmdOrCtrl+1")?,
      &item("fit_page", "Fit Page", "CmdOrCtrl+2")?,
      &PredefinedMenuItem::separator(app)?,
      &item("rotate", "Rotate View", "CmdOrCtrl+R")?,
      &item("organize", "Organize Pages", "CmdOrCtrl+Shift+O")?,
      &item("toggle_sidebar", "Toggle Sidebar", "CmdOrCtrl+Alt+S")?,
      &item("toggle_night", "Night Reading", "CmdOrCtrl+Alt+N")?,
    ],
  )?;

  #[cfg(target_os = "macos")]
  {
    let app_menu = Submenu::with_items(
      app,
      "PDF Studio",
      true,
      &[
        &PredefinedMenuItem::about(app, None, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::services(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::show_all(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        // Custom so the UI can warn about unsaved changes first.
        &item("quit", "Quit PDF Studio", "CmdOrCtrl+Q")?,
      ],
    )?;
    let window = Submenu::with_items(
      app,
      "Window",
      true,
      &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
      ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
  }
  #[cfg(not(target_os = "macos"))]
  {
    Menu::with_items(app, &[&file, &edit, &view])
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Windows and Linux pass "Open With" files as command-line arguments.
  let arg_files: Vec<String> = std::env::args()
    .skip(1)
    .filter(|a| is_pdf(Path::new(a)))
    .collect();

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(PendingFiles(Mutex::new(arg_files)))
    .menu(build_menu)
    .on_menu_event(|app, event| {
      let _ = app.emit("menu", event.id().as_ref().to_string());
    })
    .invoke_handler(tauri::generate_handler![read_pdf, write_pdf, take_pending_files, exit_app])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building PDF Studio")
    .run(|_app, _event| {
      // macOS delivers "Open With" / double-clicked files as an event.
      #[cfg(target_os = "macos")]
      if let tauri::RunEvent::Opened { urls } = _event {
        let paths = urls
          .into_iter()
          .filter_map(|u| u.to_file_path().ok())
          .filter(|p| is_pdf(p))
          .map(|p| p.to_string_lossy().into_owned())
          .collect();
        queue_files(_app, paths);
      }
    });
}
