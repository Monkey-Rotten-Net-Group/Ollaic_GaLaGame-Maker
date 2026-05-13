#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod assets;
mod characters;
mod webgal;

use std::path::PathBuf;
use tauri::Manager;
use webgal::runtime_server::RuntimeServer;

#[tauri::command]
async fn get_runtime_url(server: tauri::State<'_, RuntimeServer>) -> Result<String, String> {
    Ok(server.url())
}

#[tauri::command]
async fn set_runtime_project(
    server: tauri::State<'_, RuntimeServer>,
    project_path: Option<String>,
) -> Result<(), String> {
    server
        .set_project(project_path.map(PathBuf::from))
        .await;
    Ok(())
}

#[tauri::command]
async fn runtime_broadcast(
    server: tauri::State<'_, RuntimeServer>,
    message: String,
) -> Result<(), String> {
    server.broadcast(message);
    Ok(())
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

fn resolve_template_dir() -> PathBuf {
    if let Ok(p) = std::env::var("WEBGAL_TEMPLATE_DIR") {
        return PathBuf::from(p);
    }
    if let Some(home) = dirs::home_dir() {
        return home.join("Downloads/webgal/WebGAL/assets/templates/WebGAL_Template");
    }
    PathBuf::from("./WebGAL_Template")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let template_dir = resolve_template_dir();
            if !template_dir.exists() {
                eprintln!(
                    "[main] WebGAL template directory missing: {} — set WEBGAL_TEMPLATE_DIR or place the template at the default path",
                    template_dir.display()
                );
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match RuntimeServer::start(template_dir).await {
                    Ok(server) => {
                        handle.manage(server);
                    }
                    Err(e) => {
                        eprintln!("[main] failed to start runtime server: {e}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Scene parsing & serialization
            webgal::commands::parse_scene,
            webgal::commands::serialize_scene,
            webgal::commands::load_scene,
            webgal::commands::save_scene,
            webgal::commands::list_scenes,
            // Project management
            webgal::project::init_project,
            webgal::project::open_project,
            webgal::project::save_config,
            webgal::project::get_scene_path,
            webgal::project::create_scene,
            webgal::project::export_project,
            // Runtime preview server
            get_runtime_url,
            set_runtime_project,
            runtime_broadcast,
            open_in_browser,
            // AI
            ai::commands::get_ai_config,
            ai::commands::set_ai_config,
            ai::commands::default_ai_system_prompt,
            ai::commands::ai_chat_stream,
            // Assets
            assets::commands::list_assets,
            assets::commands::list_all_assets,
            assets::commands::import_asset,
            assets::commands::delete_asset,
            assets::commands::rename_asset,
            // Characters
            characters::commands::list_characters,
            characters::commands::get_character,
            characters::commands::create_character,
            characters::commands::update_character,
            characters::commands::delete_character,
            characters::commands::list_character_names,
            characters::commands::save_characters,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
