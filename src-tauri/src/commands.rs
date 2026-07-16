use crate::connection::{SessionInput, SshConnection, SshOutputPayload};
use crate::DbSessionMap;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const INTERACTIVE_SSH_TIMEOUT_MILLISECONDS: u32 = 50;
const SFTP_DIRECTORY_TIMEOUT_MILLISECONDS: u32 = 5_000;
const SFTP_TRANSFER_TIMEOUT_MILLISECONDS: u32 = 30_000;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub passphrase: Option<String>,
    pub password: Option<String>,
    pub use_password: bool,
    pub namespace: Option<String>,
}

struct SftpSessionTimeoutReset<'a> {
    session: &'a Session,
}

impl<'a> SftpSessionTimeoutReset<'a> {
    fn new(session: &'a Session, timeout_milliseconds: u32) -> Self {
        session.set_timeout(timeout_milliseconds);
        Self { session }
    }
}

impl Drop for SftpSessionTimeoutReset<'_> {
    fn drop(&mut self) {
        self.session
            .set_timeout(INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);
    }
}

#[tauri::command]
pub fn select_key_file() -> Result<Option<String>, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let ssh_dir = home.join(".ssh");
    let file = rfd::FileDialog::new()
        .set_directory(if ssh_dir.exists() { &ssh_dir } else { &home })
        .pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn get_default_ssh_keys() -> Result<Vec<String>, String> {
    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".ssh");
    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }
    let mut keys = Vec::new();
    let common_keys = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
    for key_name in &common_keys {
        let key_path = ssh_dir.join(key_name);
        if key_path.exists() {
            if let Some(path_str) = key_path.to_str() {
                keys.push(path_str.to_string());
            }
        }
    }
    Ok(keys)
}

#[tauri::command]
pub fn generate_new_ssh_key() -> Result<String, String> {
    use rand::rngs::OsRng;
    use ssh_key::private::Ed25519Keypair;

    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".ssh");
    std::fs::create_dir_all(&ssh_dir)
        .map_err(|e| format!("Failed to create .ssh directory: {}", e))?;

    let private_key_path = ssh_dir.join("id_ed25519");
    let public_key_path = ssh_dir.join("id_ed25519.pub");

    if private_key_path.exists() {
        return Err("SSH key id_ed25519 already exists!".to_string());
    }

    let mut csprng = OsRng;
    let keypair = Ed25519Keypair::random(&mut csprng);
    let private_key = ssh_key::PrivateKey::from(keypair);

    let openssh_pem = private_key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| format!("Failed to generate private key format: {}", e))?;

    let public_key = private_key.public_key();
    let public_key_openssh = public_key
        .to_openssh()
        .map_err(|e| format!("Failed to generate public key format: {}", e))?;

    std::fs::write(&private_key_path, openssh_pem.as_bytes())
        .map_err(|e| format!("Failed to write private key file: {}", e))?;

    std::fs::write(&public_key_path, public_key_openssh.as_bytes())
        .map_err(|e| format!("Failed to write public key file: {}", e))?;

    Ok(public_key_openssh)
}

#[tauri::command]
pub fn load_connections() -> Result<Vec<ConnectionProfile>, String> {
    use windows_dpapi::{decrypt_data, Scope};

    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?
        .join("TauriSshTerminal");
    let config_file = config_dir.join("connections.enc");
    if !config_file.exists() {
        return Ok(Vec::new());
    }
    let encrypted_data =
        std::fs::read(&config_file).map_err(|e| format!("Failed to read config file: {}", e))?;
    if encrypted_data.is_empty() {
        return Ok(Vec::new());
    }
    let decrypted_data = decrypt_data(&encrypted_data, Scope::User)
        .map_err(|e| format!("Failed to decrypt config: {:?}", e))?;
    let connections = serde_json::from_slice(&decrypted_data)
        .map_err(|e| format!("Failed to parse config JSON: {}", e))?;
    Ok(connections)
}

#[tauri::command]
pub fn save_connections(connections: Vec<ConnectionProfile>) -> Result<(), String> {
    use windows_dpapi::{encrypt_data, Scope};

    let config_dir = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?
        .join("TauriSshTerminal");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let config_file = config_dir.join("connections.enc");
    let json_bytes = serde_json::to_vec(&connections)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    let encrypted_data = encrypt_data(&json_bytes, Scope::User)
        .map_err(|e| format!("Failed to encrypt config: {:?}", e))?;
    std::fs::write(&config_file, &encrypted_data)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn connect_ssh(
    app_handle: AppHandle,
    state: State<'_, DbSessionMap>,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    key_path: String,
    passphrase: Option<String>,
    password: Option<String>,
    use_password: bool,
) -> Result<(), String> {
    let task_session_id = session_id.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        connect_ssh_blocking(
            app_handle,
            task_session_id,
            host,
            port,
            username,
            key_path,
            passphrase,
            password,
            use_password,
        )
    })
    .await
    .map_err(|error| format!("SSH connection task failed: {}", error))??;

    let mut map = state.lock().unwrap();
    map.insert(session_id, connection);
    Ok(())
}

fn connect_ssh_blocking(
    app_handle: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    key_path: String,
    passphrase: Option<String>,
    password: Option<String>,
    use_password: bool,
) -> Result<SshConnection, String> {
    use base64::Engine;
    use std::io::{ErrorKind, Read};
    use std::net::TcpStream;
    use std::sync::atomic::AtomicBool;

    // Connect socket
    let addr = format!("{}:{}", host, port);
    let tcp =
        TcpStream::connect(&addr).map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;

    // Init session
    let mut sess =
        Session::new().map_err(|e| format!("Failed to initialize SSH session: {}", e))?;
    sess.set_tcp_stream(
        tcp.try_clone()
            .map_err(|e| format!("Failed to clone TCP stream: {}", e))?,
    );
    sess.handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    // Auth
    if use_password {
        let pass = password.ok_or_else(|| "Password is required".to_string())?;
        sess.userauth_password(&username, &pass)
            .map_err(|e| format!("Authentication failed: {}", e))?;
    } else {
        let private_key = std::path::Path::new(&key_path);
        if !private_key.exists() {
            return Err(format!("Private key file does not exist: {}", key_path));
        }
        sess.userauth_pubkey_file(&username, None, private_key, passphrase.as_deref())
            .map_err(|e| format!("Authentication failed: {}", e))?;
    }

    let session = Arc::new(Mutex::new(sess));
    let should_exit = Arc::new(AtomicBool::new(false));

    // Channel for writing
    let (tx, mut rx) = tokio::sync::mpsc::channel::<SessionInput>(1000);

    let session_clone = Arc::clone(&session);
    let should_exit_clone = Arc::clone(&should_exit);
    let app_handle_clone = app_handle.clone();
    let session_id_clone = session_id.clone();

    // Spawn processing thread
    std::thread::spawn(move || {
        let mut channel = {
            let sess_guard = session_clone.lock().unwrap();
            let mut ch = match sess_guard.channel_session() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to open channel: {}", e);
                    let _ = app_handle_clone.emit(
                        "ssh-error",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: format!("Failed to open channel: {}", e),
                        },
                    );
                    return;
                }
            };
            if let Err(e) = ch.handle_extended_data(ssh2::ExtendedData::Merge) {
                eprintln!("Failed to set extended data: {}", e);
            }
            if let Err(e) = ch.request_pty("xterm-256color", None, None) {
                eprintln!("Failed to request PTY: {}", e);
            }
            if let Err(e) = ch.shell() {
                eprintln!("Failed to request shell: {}", e);
                let _ = app_handle_clone.emit(
                    "ssh-error",
                    SshOutputPayload {
                        session_id: session_id_clone.clone(),
                        data: format!("Failed to open shell: {}", e),
                    },
                );
                return;
            }
            ch
        };

        // Configure session timeout to 50ms for non-blocking interactive I/O
        {
            let sess_guard = session_clone.lock().unwrap();
            sess_guard.set_timeout(INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);
        }

        let mut buf = [0u8; 8192];
        loop {
            if should_exit_clone.load(Ordering::Relaxed) {
                break;
            }

            // Read output
            let read_result = {
                let _session_guard = session_clone.lock().unwrap();
                channel.read(&mut buf)
            };
            match read_result {
                Ok(0) => {
                    let _ = app_handle_clone.emit(
                        "ssh-closed",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: "EOF reached".to_string(),
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let base64_data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_handle_clone.emit(
                        "ssh-output",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: base64_data,
                        },
                    );
                }
                Err(ref e)
                    if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock =>
                {
                    // Timeout (normal)
                }
                Err(e) => {
                    eprintln!("SSH read error: {:?}", e);
                    let _ = app_handle_clone.emit(
                        "ssh-error",
                        SshOutputPayload {
                            session_id: session_id_clone.clone(),
                            data: format!("Read error: {}", e),
                        },
                    );
                    break;
                }
            }

            // Write inputs
            while let Ok(input) = rx.try_recv() {
                use std::io::Write;
                match input {
                    SessionInput::Write(data) => {
                        let mut written = 0;
                        while written < data.len() {
                            let write_result = {
                                let _session_guard = session_clone.lock().unwrap();
                                channel.write(&data[written..])
                            };
                            match write_result {
                                Ok(n) => {
                                    written += n;
                                }
                                Err(ref e)
                                    if e.kind() == ErrorKind::TimedOut
                                        || e.kind() == ErrorKind::WouldBlock =>
                                {
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                }
                                Err(e) => {
                                    eprintln!("SSH write error: {:?}", e);
                                    break;
                                }
                            }
                        }
                    }
                    SessionInput::Resize { cols, rows } => {
                        let resize_result = {
                            let _session_guard = session_clone.lock().unwrap();
                            channel.request_pty_size(cols, rows, None, None)
                        };
                        if let Err(e) = resize_result {
                            eprintln!("Failed to resize PTY: {:?}", e);
                        }
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let _session_guard = session_clone.lock().unwrap();
        let _ = channel.close();
        let _ = channel.wait_close();
    });

    Ok(SshConnection {
        session,
        tcp,
        write_tx: tx,
        should_exit,
    })
}

#[tauri::command]
pub async fn write_ssh(
    state: State<'_, DbSessionMap>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::Engine;

    // Clone the Sender to release the lock immediately
    let tx = {
        let map = state.lock().unwrap();
        map.get(&session_id).map(|conn| conn.write_tx.clone())
    };

    if let Some(write_tx) = tx {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| format!("Failed to decode base64 write data: {}", e))?;
        write_tx
            .send(SessionInput::Write(decoded))
            .await
            .map_err(|e| format!("Failed to send write command: {}", e))?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
pub async fn resize_ssh(
    state: State<'_, DbSessionMap>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    // Clone the Sender to release the lock immediately
    let tx = {
        let map = state.lock().unwrap();
        map.get(&session_id).map(|conn| conn.write_tx.clone())
    };

    if let Some(write_tx) = tx {
        write_tx
            .send(SessionInput::Resize { cols, rows })
            .await
            .map_err(|e| format!("Failed to send resize command: {}", e))?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
pub fn disconnect_ssh(state: State<'_, DbSessionMap>, session_id: String) -> Result<(), String> {
    let mut map = state.lock().unwrap();
    if let Some(conn) = map.remove(&session_id) {
        conn.disconnect();
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[derive(Serialize, Clone)]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

fn sftp_session_for(state: &DbSessionMap, session_id: &str) -> Result<Arc<Mutex<Session>>, String> {
    let map = state.lock().unwrap();
    map.get(session_id)
        .map(|connection| Arc::clone(&connection.session))
        .ok_or_else(|| "Session not found".to_string())
}

async fn run_sftp_task<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("SFTP task failed: {}", e))?
}

#[tauri::command]
pub async fn sftp_list_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteFile>, String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_list_directory_internal(&session, &path)).await
}

fn sftp_list_directory_internal(
    session: &Arc<Mutex<Session>>,
    path: &str,
) -> Result<Vec<RemoteFile>, String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let target_path = std::path::Path::new(path);
    let files = sftp
        .readdir(target_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut result = Vec::new();
    for (path_buf, stat) in files {
        let name = path_buf
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let path_str = path_buf.to_string_lossy().to_string();
        let is_dir = stat.is_dir();
        let size = stat.size.unwrap_or(0);

        result.push(RemoteFile {
            name,
            path: path_str,
            is_dir,
            size,
        });
    }

    // Sort directories first, then files alphabetically
    result.sort_by(|a, b| {
        if a.is_dir && !b.is_dir {
            std::cmp::Ordering::Less
        } else if !a.is_dir && b.is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(result)
}

#[tauri::command]
pub async fn sftp_resolve_path(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_resolve_path_internal(&session, &path)).await
}

fn sftp_resolve_path_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<String, String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.realpath(std::path::Path::new(path))
        .map(|resolved_path| resolved_path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to resolve directory path: {}", e))
}

#[tauri::command]
pub async fn sftp_download_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_download_file_internal(&session, &remote_path, &local_path)).await
}

fn sftp_download_file_internal(
    session: &Arc<Mutex<Session>>,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let mut local_file = std::fs::File::create(local_path)
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_TRANSFER_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .open(std::path::Path::new(remote_path))
        .map_err(|e| format!("Failed to open remote file: {}", e))?;

    let mut buf = [0u8; 16384];
    loop {
        match remote_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                local_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Failed to write to local file: {}", e))?;
            }
            Err(e) => return Err(format!("Failed to read remote file: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_upload_file_internal(&session, &local_path, &remote_path)).await
}

fn sftp_upload_file_internal(
    session: &Arc<Mutex<Session>>,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let mut local_file =
        std::fs::File::open(local_path).map_err(|e| format!("Failed to open local file: {}", e))?;

    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_TRANSFER_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .create(std::path::Path::new(remote_path))
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    let mut buf = [0u8; 16384];
    loop {
        match local_file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                remote_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Failed to write to remote file: {}", e))?;
            }
            Err(e) => return Err(format!("Failed to read local file: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_create_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_create_directory_internal(&session, &path)).await
}

fn sftp_create_directory_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.mkdir(std::path::Path::new(path), 0o755)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_delete_file_internal(&session, &path)).await
}

fn sftp_delete_file_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.unlink(std::path::Path::new(path))
        .map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let session = sftp_session_for(&state, &session_id)?;
    run_sftp_task(move || sftp_delete_directory_internal(&session, &path)).await
}

fn sftp_delete_directory_internal(session: &Arc<Mutex<Session>>, path: &str) -> Result<(), String> {
    let sess = session.lock().unwrap();
    let _timeout_reset = SftpSessionTimeoutReset::new(&sess, SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.rmdir(std::path::Path::new(path))
        .map_err(|e| format!("Failed to delete directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn select_download_destination(filename: String) -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new().set_file_name(&filename).save_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn select_upload_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new().pick_file();
    Ok(file.map(|p| p.to_string_lossy().to_string()))
}

#[derive(Debug, Serialize, Clone)]
pub struct PortEntry {
    pub protocol: String,
    pub local_port: u16,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
}

#[tauri::command]
pub fn list_listening_ports() -> Result<Vec<PortEntry>, String> {
    use std::collections::HashMap;
    use std::process::Command;

    let netstat = Command::new("netstat")
        .args(["-ano"])
        .output()
        .map_err(|e| format!("Failed to run netstat: {}", e))?;
    let netstat_out = String::from_utf8_lossy(&netstat.stdout).to_string();

    let tasklist = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
        .map_err(|e| format!("Failed to run tasklist: {}", e))?;
    let tasklist_out = String::from_utf8_lossy(&tasklist.stdout).to_string();

    let mut pid_to_name: HashMap<u32, String> = HashMap::new();
    for line in tasklist_out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // CSV: "name","pid","session","num","mem"
        let parts: Vec<&str> = line.splitn(6, ',').collect();
        if parts.len() >= 2 {
            let name = parts[0].trim_matches('"').to_string();
            if let Ok(pid) = parts[1].trim_matches('"').parse::<u32>() {
                pid_to_name.insert(pid, name);
            }
        }
    }

    let mut entries = Vec::new();
    for line in netstat_out.lines() {
        let line = line.trim();
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let proto = parts[0];
        if proto != "TCP" && proto != "UDP" {
            continue;
        }
        if parts.len() < 4 {
            continue;
        }
        let local_addr = parts[1];
        let local_port = match local_addr.rfind(':') {
            Some(pos) => match local_addr[pos + 1..].parse::<u16>() {
                Ok(p) => p,
                Err(_) => continue,
            },
            None => continue,
        };
        let (state, pid_str) = if proto == "TCP" {
            if parts.len() < 5 {
                continue;
            }
            (parts[3].to_string(), parts[4])
        } else {
            (String::new(), parts[3])
        };
        let pid = match pid_str.parse::<u32>() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let process_name = pid_to_name
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| format!("PID {}", pid));

        entries.push(PortEntry {
            protocol: proto.to_string(),
            local_port,
            state,
            pid,
            process_name,
        });
    }

    entries.sort_by_key(|e| e.local_port);
    Ok(entries)
}

#[tauri::command]
pub fn kill_port_process(pid: u32) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sftp_timeouts_allow_remote_operations_to_wait_longer_than_terminal_polls() {
        assert!(SFTP_DIRECTORY_TIMEOUT_MILLISECONDS > INTERACTIVE_SSH_TIMEOUT_MILLISECONDS);
        assert!(SFTP_TRANSFER_TIMEOUT_MILLISECONDS > SFTP_DIRECTORY_TIMEOUT_MILLISECONDS);
    }

    #[tokio::test]
    async fn run_sftp_task_returns_the_background_task_result() {
        let result = run_sftp_task(|| Ok("completed".to_string())).await;

        assert_eq!(result.unwrap(), "completed");
    }
}
