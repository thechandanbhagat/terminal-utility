use crate::connection::{SessionInput, SshConnection, SshOutputPayload};
use crate::DbSessionMap;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

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
pub fn connect_ssh(
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
    use base64::Engine;
    use ssh2::Session;
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
            sess_guard.set_timeout(50);
        }

        let mut buf = [0u8; 8192];
        loop {
            if should_exit_clone.load(Ordering::Relaxed) {
                break;
            }

            // Read output
            match channel.read(&mut buf) {
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
                            match channel.write(&data[written..]) {
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
                        if let Err(e) = channel.request_pty_size(cols, rows, None, None) {
                            eprintln!("Failed to resize PTY: {:?}", e);
                        }
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let _ = channel.close();
        let _ = channel.wait_close();
    });

    // Save connection state
    let mut map = state.lock().unwrap();
    map.insert(
        session_id,
        SshConnection {
            session,
            tcp,
            write_tx: tx,
            should_exit,
        },
    );

    Ok(())
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

#[tauri::command]
pub fn sftp_list_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<Vec<RemoteFile>, String> {
    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let target_path = std::path::Path::new(&path);
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
pub fn sftp_download_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;

    let mut local_file = std::fs::File::create(&local_path)
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .open(std::path::Path::new(&remote_path))
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
pub fn sftp_upload_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    use std::io::{Read, Write};

    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;

    let mut local_file = std::fs::File::open(&local_path)
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    let mut remote_file = sftp
        .create(std::path::Path::new(&remote_path))
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
pub fn sftp_create_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.mkdir(std::path::Path::new(&path), 0o755)
        .map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn sftp_delete_file(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.unlink(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn sftp_delete_directory(
    state: State<'_, DbSessionMap>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let map = state.lock().unwrap();
    let conn = map
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let sess = conn.session.lock().unwrap();
    let sftp = sess
        .sftp()
        .map_err(|e| format!("Failed to open SFTP session: {}", e))?;

    sftp.rmdir(std::path::Path::new(&path))
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
