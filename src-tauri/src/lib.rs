mod commands;
mod connection;
mod vpn;

use connection::SshConnection;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type DbSessionMap = Mutex<HashMap<String, SshConnection>>;
pub type VpnProcessState = Arc<Mutex<Option<u32>>>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(HashMap::<String, SshConnection>::new()))
        .manage(Arc::new(Mutex::new(None::<u32>)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::select_key_file,
            commands::get_default_ssh_keys,
            commands::generate_new_ssh_key,
            commands::load_connections,
            commands::save_connections,
            commands::connect_ssh,
            commands::write_ssh,
            commands::resize_ssh,
            commands::disconnect_ssh,
            commands::sftp_list_directory,
            commands::sftp_download_file,
            commands::sftp_upload_file,
            commands::sftp_create_directory,
            commands::sftp_delete_file,
            commands::sftp_delete_directory,
            commands::select_download_destination,
            commands::select_upload_file,
            vpn::get_vpncli_path,
            vpn::load_vpn_profiles,
            vpn::save_vpn_profiles,
            vpn::list_cisco_vpn_profiles,
            vpn::vpn_status,
            vpn::disconnect_vpn,
            vpn::cancel_vpn_operation,
            vpn::switch_vpn_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
