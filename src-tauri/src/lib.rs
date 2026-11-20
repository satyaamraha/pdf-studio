use std::path::Path;
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
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
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
      &item("rotate", "Rotate Clockwise", "CmdOrCtrl+R")?,
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
        &PredefinedMenuItem::quit(app, None)?,
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
    .on_menu_event(|app, event| match event.id().as_ref() {
      "quit" => app.exit(0),
      id => {
        let _ = app.emit("menu", id.to_string());
      }
    })
    .invoke_handler(tauri::generate_handler![read_pdf, take_pending_files])
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
