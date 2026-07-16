use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};
use tauri::State;

use crate::VpnProcessState;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const APP_CONFIG_DIR: &str = "TauriSshTerminal";
const VPN_PROFILES_FILE: &str = "vpn_profiles.enc";
const VPNCLI_EXE: &str = "vpncli.exe";
const CISCO_PREFERENCES_FILE: &str = "preferences.xml";
const VPNCLI_TIMEOUT_SECONDS: u64 = 120;
const VPNCLI_DISCONNECT_TIMEOUT_SECONDS: u64 = 30;
const VPNCLI_DISCONNECT_SETTLE_SECONDS: u64 = 10;
const VPNCLI_EXIT_TIMEOUT_SECONDS: u64 = 5;
const VPNCLI_POLL_INTERVAL_MILLISECONDS: u64 = 100;
const VPNCLI_OUTPUT_BUFFER_BYTES: usize = 1024;
const MAX_VPN_FIELD_CHARS: usize = 512;
const VPN_STATUS_SCRIPT: &str = "stats\n";
const VPN_DISCONNECT_COMMAND: &str = "disconnect";
const VPN_CERTIFICATE_PROMPT: &str = "connect anyway? [y/n]:";
const VPN_GROUP_PROMPT: &str = "group:";
const VPN_USERNAME_PROMPT: &str = "username:";
const VPN_PASSWORD_PROMPT: &str = "password:";
const VPN_CONNECTION_FAILURE_MARKER: &str = "connection attempt has failed";
const VPN_CONNECTION_SUCCESS_MARKER: &str = "state: connected";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VpnProfile {
    pub id: String,
    pub name: String,
    pub server: String,
    pub group: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct VpnCommandResult {
    pub success: bool,
    pub output: String,
    #[serde(rename = "requiresCertificateConfirmation")]
    pub requires_certificate_confirmation: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct CiscoVpnProfileOption {
    pub name: String,
    pub server: String,
    pub group: Option<String>,
    pub source: String,
}

struct VpnProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
    requires_certificate_confirmation: bool,
}

#[derive(Clone, Copy)]
enum VpnOutputStream {
    Stdout,
    Stderr,
}

struct VpnOutputChunk {
    stream: VpnOutputStream,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct VpnConnectPromptState {
    certificate_handled: bool,
    group_handled: bool,
    username_handled: bool,
    password_handled: bool,
    exit_sent: bool,
    failure_handled: bool,
}

enum VpnConnectAction {
    Send(String),
    Exit,
    RequireCertificateConfirmation,
    Fail(String),
}

#[tauri::command]
pub fn get_vpncli_path() -> Result<String, String> {
    Ok(resolve_vpncli_path()?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn load_vpn_profiles() -> Result<Vec<VpnProfile>, String> {
    use windows_dpapi::{decrypt_data, Scope};

    let config_file = app_config_file(VPN_PROFILES_FILE)?;
    if !config_file.exists() {
        return Ok(Vec::new());
    }

    let encrypted_data =
        fs::read(&config_file).map_err(|e| format!("Failed to read VPN profile config: {}", e))?;
    if encrypted_data.is_empty() {
        return Ok(Vec::new());
    }

    let decrypted_data = decrypt_data(&encrypted_data, Scope::User)
        .map_err(|e| format!("Failed to decrypt VPN profile config: {:?}", e))?;
    serde_json::from_slice(&decrypted_data)
        .map_err(|e| format!("Failed to parse VPN profile config: {}", e))
}

#[tauri::command]
pub fn save_vpn_profiles(profiles: Vec<VpnProfile>) -> Result<(), String> {
    use windows_dpapi::{encrypt_data, Scope};

    for profile in &profiles {
        validate_vpn_profile(profile)?;
    }

    let config_dir = app_config_dir()?;
    fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create VPN profile config directory: {}", e))?;

    let config_file = config_dir.join(VPN_PROFILES_FILE);
    let json_bytes = serde_json::to_vec(&profiles)
        .map_err(|e| format!("Failed to serialize VPN profile config: {}", e))?;
    let encrypted_data = encrypt_data(&json_bytes, Scope::User)
        .map_err(|e| format!("Failed to encrypt VPN profile config: {:?}", e))?;

    fs::write(&config_file, &encrypted_data)
        .map_err(|e| format!("Failed to write VPN profile config: {}", e))
}

#[tauri::command]
pub fn list_cisco_vpn_profiles() -> Result<Vec<CiscoVpnProfileOption>, String> {
    let mut profiles = Vec::new();

    for dir in cisco_profile_dirs() {
        if !dir.exists() {
            continue;
        }

        for path in collect_xml_files(&dir)? {
            let source = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Cisco profile")
                .to_string();
            let xml = fs::read_to_string(&path)
                .map_err(|e| format!("Failed to read Cisco profile {}: {}", path.display(), e))?;
            profiles.extend(parse_cisco_profile_xml(&xml, &source)?);
        }
    }

    profiles.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.server.to_lowercase().cmp(&b.server.to_lowercase()))
            .then(a.group.cmp(&b.group))
    });
    profiles.dedup_by(|a, b| {
        a.server.eq_ignore_ascii_case(&b.server) && same_optional_text(&a.group, &b.group)
    });

    Ok(profiles)
}

fn collect_xml_files(dir: &PathBuf) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| {
        format!(
            "Failed to read Cisco profile directory {}: {}",
            dir.display(),
            e
        )
    })?;

    for entry in entries {
        let path = entry
            .map_err(|e| format!("Failed to read Cisco profile entry: {}", e))?
            .path();

        if path.is_dir() {
            files.extend(collect_xml_files(&path)?);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("xml") {
            files.push(path);
        }
    }

    Ok(files)
}

#[tauri::command]
pub async fn vpn_status(
    process_state: State<'_, VpnProcessState>,
) -> Result<VpnCommandResult, String> {
    let process_state = process_state.inner().clone();
    run_blocking_vpn_task(move || {
        let output = run_vpncli_script(&process_state, VPN_STATUS_SCRIPT)?;
        Ok(to_vpn_result(
            output,
            &["state: connected", "state: disconnected"],
        ))
    })
    .await
}

#[tauri::command]
pub async fn disconnect_vpn(
    process_state: State<'_, VpnProcessState>,
) -> Result<VpnCommandResult, String> {
    let process_state = process_state.inner().clone();
    run_blocking_vpn_task(move || disconnect_vpn_internal(&process_state)).await
}

#[tauri::command]
pub async fn cancel_vpn_operation(process_state: State<'_, VpnProcessState>) -> Result<(), String> {
    let process_state = process_state.inner().clone();
    run_blocking_vpn_task(move || cancel_vpn_operation_internal(&process_state)).await
}

fn cancel_vpn_operation_internal(process_state: &VpnProcessState) -> Result<(), String> {
    let process_id = {
        let state = process_state
            .lock()
            .map_err(|_| "Failed to lock VPN process state".to_string())?;
        *state
    };

    let Some(process_id) = process_id else {
        return Ok(());
    };

    let status = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("Failed to cancel vpncli.exe: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to cancel vpncli.exe process {}",
            process_id
        ))
    }
}

#[tauri::command]
pub async fn switch_vpn_profile(
    process_state: State<'_, VpnProcessState>,
    profile: VpnProfile,
    allow_invalid_certificate: bool,
) -> Result<VpnCommandResult, String> {
    validate_vpn_profile(&profile)?;
    let process_state = process_state.inner().clone();

    run_blocking_vpn_task(move || {
        let disconnect_result = disconnect_vpn_internal(&process_state)?;
        if !disconnect_result.success {
            return Err(join_outputs(&[
                "VPN switch stopped before connecting.".to_string(),
                disconnect_result.output,
            ]));
        }

        let connect_result =
            connect_vpn_internal(&process_state, &profile, allow_invalid_certificate)?;

        Ok(VpnCommandResult {
            success: connect_result.success,
            output: join_outputs(&[disconnect_result.output, connect_result.output]),
            requires_certificate_confirmation: connect_result.requires_certificate_confirmation,
        })
    })
    .await
}

async fn run_blocking_vpn_task<T>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("VPN task failed: {}", e))?
}

fn disconnect_vpn_internal(process_state: &VpnProcessState) -> Result<VpnCommandResult, String> {
    let initial_status = run_vpncli_script(process_state, VPN_STATUS_SCRIPT)?;
    if vpn_is_disconnected(&initial_status) {
        return Ok(VpnCommandResult {
            success: true,
            output: "VPN already disconnected.".to_string(),
            requires_certificate_confirmation: false,
        });
    }

    let disconnect_output = run_vpncli_disconnect(process_state)?;
    let final_status = run_vpncli_script(process_state, VPN_STATUS_SCRIPT)?;

    if vpn_is_disconnected(&final_status) {
        return Ok(VpnCommandResult {
            success: true,
            output: join_outputs(&[
                process_output_text(&disconnect_output.stdout, &disconnect_output.stderr),
                process_output_text(&final_status.stdout, &final_status.stderr),
            ]),
            requires_certificate_confirmation: false,
        });
    }

    if disconnect_output.timed_out {
        return Err(format!(
            "VPN disconnect did not complete within {} seconds.{}",
            VPNCLI_DISCONNECT_TIMEOUT_SECONDS,
            timeout_output_hint(&disconnect_output.stdout, &disconnect_output.stderr)
        ));
    }

    Err(format!(
        "VPN disconnect did not complete.{}",
        timeout_output_hint(&disconnect_output.stdout, &disconnect_output.stderr)
    ))
}

fn connect_vpn_internal(
    process_state: &VpnProcessState,
    profile: &VpnProfile,
    allow_invalid_certificate: bool,
) -> Result<VpnCommandResult, String> {
    close_vpn_ui()?;

    if let Some(group) = trimmed_optional(&profile.group) {
        set_cisco_default_group(&group)?;
    }

    let output = run_vpncli_connect(process_state, profile, allow_invalid_certificate)?;
    if output.requires_certificate_confirmation {
        return Ok(VpnCommandResult {
            success: false,
            output: "Cisco requires confirmation before connecting to this server. Its certificate does not match the server name and has expired.".to_string(),
            requires_certificate_confirmation: true,
        });
    }

    let redactions = profile_redactions(profile);

    Ok(to_vpn_result_with_redactions(
        output,
        &[
            "state: connected",
            "connection state: connected",
            "vpn session established",
        ],
        &redactions,
    ))
}

fn close_vpn_ui() -> Result<(), String> {
    let mut query = Command::new("tasklist");
    query.args(["/FI", "IMAGENAME eq vpnui.exe", "/NH"]);

    #[cfg(target_os = "windows")]
    query.creation_flags(CREATE_NO_WINDOW);

    let output = query
        .output()
        .map_err(|e| format!("Failed to check whether Cisco VPN UI is running: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to check whether Cisco VPN UI is running: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    if !String::from_utf8_lossy(&output.stdout)
        .to_lowercase()
        .contains("vpnui.exe")
    {
        return Ok(());
    }

    let mut close = Command::new("taskkill");
    close.args(["/IM", "vpnui.exe", "/T", "/F"]);

    #[cfg(target_os = "windows")]
    close.creation_flags(CREATE_NO_WINDOW);

    let status = close
        .status()
        .map_err(|e| format!("Failed to close Cisco VPN UI: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err("Failed to close Cisco VPN UI before connecting.".to_string())
    }
}

fn set_cisco_default_group(group: &str) -> Result<(), String> {
    let preferences_path = cisco_preferences_path()?;
    let preferences = fs::read_to_string(&preferences_path).map_err(|e| {
        format!(
            "Failed to read Cisco preferences {}: {}",
            preferences_path.display(),
            e
        )
    })?;
    let updated_preferences = replace_cisco_default_group(&preferences, group)?;

    fs::write(&preferences_path, updated_preferences).map_err(|e| {
        format!(
            "Failed to set Cisco default group in {}: {}",
            preferences_path.display(),
            e
        )
    })
}

fn cisco_preferences_path() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the local application-data directory".to_string())?;
    [
        local_app_data
            .join("Cisco")
            .join("Cisco AnyConnect Secure Mobility Client")
            .join(CISCO_PREFERENCES_FILE),
        local_app_data
            .join("Cisco")
            .join("Cisco Secure Client")
            .join("VPN")
            .join(CISCO_PREFERENCES_FILE),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| "Could not find Cisco preferences.xml for the current user.".to_string())
}

fn replace_cisco_default_group(preferences: &str, group: &str) -> Result<String, String> {
    const DEFAULT_GROUP_OPEN_TAG: &str = "<DefaultGroup>";
    const DEFAULT_GROUP_CLOSE_TAG: &str = "</DefaultGroup>";

    let value_start = preferences
        .find(DEFAULT_GROUP_OPEN_TAG)
        .map(|index| index + DEFAULT_GROUP_OPEN_TAG.len())
        .ok_or_else(|| "Cisco preferences do not contain DefaultGroup.".to_string())?;
    let value_end = preferences[value_start..]
        .find(DEFAULT_GROUP_CLOSE_TAG)
        .map(|index| value_start + index)
        .ok_or_else(|| "Cisco preferences contain an incomplete DefaultGroup value.".to_string())?;
    let group = escape_xml_text(group);
    let updated = format!(
        "{}{}{}",
        &preferences[..value_start],
        group,
        &preferences[value_end..]
    );

    roxmltree::Document::parse(&updated)
        .map_err(|e| format!("Updated Cisco preferences are not valid XML: {}", e))?;
    Ok(updated)
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn run_vpncli_connect(
    process_state: &VpnProcessState,
    profile: &VpnProfile,
    allow_invalid_certificate: bool,
) -> Result<VpnProcessOutput, String> {
    let vpncli_path = resolve_vpncli_path()?;
    let mut command = Command::new(&vpncli_path);
    command
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut state = process_state
        .lock()
        .map_err(|_| "Failed to lock VPN process state".to_string())?;
    if state.is_some() {
        return Err("A VPN operation is already running.".to_string());
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", vpncli_path.display(), e))?;
    let child_id = child.id();
    *state = Some(child_id);
    drop(state);
    let _process_guard = VpnProcessGuard {
        process_state,
        child_id,
    };

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open vpncli stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open vpncli stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open vpncli stderr".to_string())?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = thread::spawn({
        let sender = sender.clone();
        move || stream_vpn_pipe(stdout, VpnOutputStream::Stdout, sender)
    });
    let stderr_reader =
        thread::spawn(move || stream_vpn_pipe(stderr, VpnOutputStream::Stderr, sender));

    send_vpn_response(&mut stdin, &format!("connect {}", profile.server.trim()))?;

    let group = trimmed_optional(&profile.group);
    let username = trimmed_optional(&profile.username);
    let password = nonempty_optional(&profile.password);
    let mut prompt_state = VpnConnectPromptState::default();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut process_success = false;
    let mut connection_established = false;
    let mut timed_out = false;
    let mut requires_certificate_confirmation = false;
    let mut input_error = None;
    let mut exit_requested_at: Option<Instant> = None;
    let started_at = Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to inspect vpncli process: {}", e))?
        {
            process_success = status.success();
            break;
        }

        if started_at.elapsed() > Duration::from_secs(VPNCLI_TIMEOUT_SECONDS) {
            timed_out = true;
            break;
        }

        if exit_requested_at.is_some_and(|requested_at| {
            requested_at.elapsed() > Duration::from_secs(VPNCLI_EXIT_TIMEOUT_SECONDS)
        }) {
            break;
        }

        if let Ok(chunk) =
            receiver.recv_timeout(Duration::from_millis(VPNCLI_POLL_INTERVAL_MILLISECONDS))
        {
            append_vpn_output_chunk(chunk, &mut stdout, &mut stderr);
        }
        collect_vpn_output_chunks(&receiver, &mut stdout, &mut stderr);

        let output = process_output_text(&stdout, &stderr);
        if let Some(action) = next_vpn_connect_action(
            &output,
            &mut prompt_state,
            group.as_deref(),
            username.as_deref(),
            password,
            allow_invalid_certificate,
        ) {
            match action {
                VpnConnectAction::Send(response) => send_vpn_response(&mut stdin, &response)?,
                VpnConnectAction::Exit => {
                    send_vpn_response(&mut stdin, "exit")?;
                    connection_established = true;
                    exit_requested_at = Some(Instant::now());
                }
                VpnConnectAction::RequireCertificateConfirmation => {
                    requires_certificate_confirmation = true;
                    break;
                }
                VpnConnectAction::Fail(message) => {
                    input_error = Some(message);
                    break;
                }
            }
        }
    }

    drop(stdin);
    if child
        .try_wait()
        .map_err(|e| format!("Failed to inspect vpncli process: {}", e))?
        .is_none()
    {
        let _ = child.kill();
        let _ = child.wait();
    }

    join_stream_reader(stdout_reader, "stdout")?;
    join_stream_reader(stderr_reader, "stderr")?;
    collect_vpn_output_chunks(&receiver, &mut stdout, &mut stderr);

    if let Some(message) = input_error {
        let redactions = profile_redactions(profile);
        let output = redact_sensitive_output(&process_output_text(&stdout, &stderr), &redactions);
        let output_hint = if output.is_empty() {
            String::new()
        } else {
            format!(" Last output:\n{}", output)
        };
        return Err(format!("{}{}", message, output_hint));
    }

    Ok(VpnProcessOutput {
        success: process_success || connection_established,
        stdout,
        stderr,
        timed_out,
        requires_certificate_confirmation,
    })
}

fn run_vpncli_disconnect(process_state: &VpnProcessState) -> Result<VpnProcessOutput, String> {
    let vpncli_path = resolve_vpncli_path()?;
    let mut command = Command::new(&vpncli_path);
    command
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut state = process_state
        .lock()
        .map_err(|_| "Failed to lock VPN process state".to_string())?;
    if state.is_some() {
        return Err("A VPN operation is already running.".to_string());
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", vpncli_path.display(), e))?;
    let child_id = child.id();
    *state = Some(child_id);
    drop(state);
    let _process_guard = VpnProcessGuard {
        process_state,
        child_id,
    };

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open vpncli stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open vpncli stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open vpncli stderr".to_string())?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = thread::spawn({
        let sender = sender.clone();
        move || stream_vpn_pipe(stdout, VpnOutputStream::Stdout, sender)
    });
    let stderr_reader =
        thread::spawn(move || stream_vpn_pipe(stderr, VpnOutputStream::Stderr, sender));

    send_vpn_response(&mut stdin, VPN_DISCONNECT_COMMAND)?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut process_success = false;
    let mut disconnect_completed = false;
    let mut timed_out = false;
    let mut exit_requested_at: Option<Instant> = None;
    let started_at = Instant::now();

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to inspect vpncli process: {}", e))?
        {
            process_success = status.success();
            break;
        }

        if started_at.elapsed() > Duration::from_secs(VPNCLI_DISCONNECT_TIMEOUT_SECONDS) {
            timed_out = true;
            break;
        }

        if exit_requested_at.is_some_and(|requested_at| {
            requested_at.elapsed() > Duration::from_secs(VPNCLI_EXIT_TIMEOUT_SECONDS)
        }) {
            break;
        }

        if let Ok(chunk) =
            receiver.recv_timeout(Duration::from_millis(VPNCLI_POLL_INTERVAL_MILLISECONDS))
        {
            append_vpn_output_chunk(chunk, &mut stdout, &mut stderr);
        }
        collect_vpn_output_chunks(&receiver, &mut stdout, &mut stderr);

        let disconnect_complete =
            vpn_disconnect_is_complete(&process_output_text(&stdout, &stderr));
        if exit_requested_at.is_none()
            && (disconnect_complete
                || started_at.elapsed() > Duration::from_secs(VPNCLI_DISCONNECT_SETTLE_SECONDS))
        {
            disconnect_completed = disconnect_complete;
            send_vpn_response(&mut stdin, "exit")?;
            exit_requested_at = Some(Instant::now());
        }
    }

    drop(stdin);
    if child
        .try_wait()
        .map_err(|e| format!("Failed to inspect vpncli process: {}", e))?
        .is_none()
    {
        let _ = child.kill();
        let _ = child.wait();
    }

    join_stream_reader(stdout_reader, "stdout")?;
    join_stream_reader(stderr_reader, "stderr")?;
    collect_vpn_output_chunks(&receiver, &mut stdout, &mut stderr);

    Ok(VpnProcessOutput {
        success: process_success || disconnect_completed,
        stdout,
        stderr,
        timed_out,
        requires_certificate_confirmation: false,
    })
}

fn next_vpn_connect_action(
    output: &str,
    state: &mut VpnConnectPromptState,
    group: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
    allow_invalid_certificate: bool,
) -> Option<VpnConnectAction> {
    let output = output.to_lowercase();

    if output.contains(VPN_CERTIFICATE_PROMPT) && !state.certificate_handled {
        state.certificate_handled = true;
        return Some(if allow_invalid_certificate {
            VpnConnectAction::Send("y".to_string())
        } else {
            VpnConnectAction::RequireCertificateConfirmation
        });
    }

    if output.contains(VPN_CONNECTION_FAILURE_MARKER) && !state.failure_handled {
        state.failure_handled = true;
        return Some(VpnConnectAction::Fail(
            "Cisco rejected the VPN connection attempt.".to_string(),
        ));
    }

    if output.contains(VPN_GROUP_PROMPT) && !state.group_handled {
        state.group_handled = true;
        return Some(match group {
            Some(group) => VpnConnectAction::Send(group.to_string()),
            None => VpnConnectAction::Fail(
                "Cisco requested a VPN group, but this shortcut does not have one.".to_string(),
            ),
        });
    }

    if output.contains(VPN_USERNAME_PROMPT) && !state.username_handled {
        state.username_handled = true;
        return Some(match username {
            Some(username) => VpnConnectAction::Send(username.to_string()),
            None => VpnConnectAction::Fail("Cisco requested a VPN username.".to_string()),
        });
    }

    if output.contains(VPN_PASSWORD_PROMPT) && !state.password_handled {
        state.password_handled = true;
        return Some(match password {
            Some(password) => VpnConnectAction::Send(password.to_string()),
            None => VpnConnectAction::Fail("Cisco requested a VPN password.".to_string()),
        });
    }

    if output.contains(VPN_CONNECTION_SUCCESS_MARKER) && !state.exit_sent {
        state.exit_sent = true;
        return Some(VpnConnectAction::Exit);
    }

    None
}

fn send_vpn_response(stdin: &mut impl Write, response: &str) -> Result<(), String> {
    stdin
        .write_all(response.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Failed to write vpncli input: {}", e))
}

fn stream_vpn_pipe(
    mut pipe: impl Read,
    stream: VpnOutputStream,
    sender: Sender<VpnOutputChunk>,
) -> Result<(), String> {
    let mut buffer = [0; VPNCLI_OUTPUT_BUFFER_BYTES];

    loop {
        let bytes_read = pipe
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read vpncli output: {}", e))?;
        if bytes_read == 0 {
            return Ok(());
        }

        sender
            .send(VpnOutputChunk {
                stream,
                bytes: buffer[..bytes_read].to_vec(),
            })
            .map_err(|_| "Failed to forward vpncli output".to_string())?;
    }
}

fn append_vpn_output_chunk(chunk: VpnOutputChunk, stdout: &mut Vec<u8>, stderr: &mut Vec<u8>) {
    match chunk.stream {
        VpnOutputStream::Stdout => stdout.extend(chunk.bytes),
        VpnOutputStream::Stderr => stderr.extend(chunk.bytes),
    }
}

fn collect_vpn_output_chunks(
    receiver: &Receiver<VpnOutputChunk>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
) {
    while let Ok(chunk) = receiver.try_recv() {
        append_vpn_output_chunk(chunk, stdout, stderr);
    }
}

fn join_stream_reader(
    reader: thread::JoinHandle<Result<(), String>>,
    stream_name: &str,
) -> Result<(), String> {
    reader
        .join()
        .map_err(|_| format!("Failed to join vpncli {} reader", stream_name))?
}

fn run_vpncli_script(
    process_state: &VpnProcessState,
    script: &str,
) -> Result<VpnProcessOutput, String> {
    run_vpncli(process_state, &["-s"], Some(script))
}

fn run_vpncli(
    process_state: &VpnProcessState,
    args: &[&str],
    stdin_text: Option<&str>,
) -> Result<VpnProcessOutput, String> {
    let output = run_vpncli_with_timeout(process_state, args, stdin_text, VPNCLI_TIMEOUT_SECONDS)?;

    if output.timed_out {
        return Err(format!(
            "vpncli timed out after {} seconds.{}",
            VPNCLI_TIMEOUT_SECONDS,
            timeout_output_hint(&output.stdout, &output.stderr)
        ));
    }

    Ok(output)
}

fn run_vpncli_with_timeout(
    process_state: &VpnProcessState,
    args: &[&str],
    stdin_text: Option<&str>,
    timeout_seconds: u64,
) -> Result<VpnProcessOutput, String> {
    let vpncli_path = resolve_vpncli_path()?;
    let mut command = Command::new(&vpncli_path);
    command
        .args(args)
        .stdin(if stdin_text.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut state = process_state
        .lock()
        .map_err(|_| "Failed to lock VPN process state".to_string())?;
    if state.is_some() {
        return Err("A VPN operation is already running.".to_string());
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", vpncli_path.display(), e))?;
    let child_id = child.id();
    *state = Some(child_id);
    drop(state);
    let _process_guard = VpnProcessGuard {
        process_state,
        child_id,
    };

    if let Some(text) = stdin_text {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open vpncli stdin".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("Failed to write vpncli input: {}", e))?;
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open vpncli stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open vpncli stderr".to_string())?;

    let stdout_reader = thread::spawn(move || read_pipe(&mut stdout));
    let stderr_reader = thread::spawn(move || read_pipe(&mut stderr));
    let started_at = Instant::now();

    let success = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to inspect vpncli process: {}", e))?
        {
            break status.success();
        }

        if started_at.elapsed() > Duration::from_secs(timeout_seconds) {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = join_reader(stdout_reader, "stdout")?;
            let stderr = join_reader(stderr_reader, "stderr")?;
            return Ok(VpnProcessOutput {
                success: false,
                stdout,
                stderr,
                timed_out: true,
                requires_certificate_confirmation: false,
            });
        }

        thread::sleep(Duration::from_millis(VPNCLI_POLL_INTERVAL_MILLISECONDS));
    };

    Ok(VpnProcessOutput {
        success,
        stdout: join_reader(stdout_reader, "stdout")?,
        stderr: join_reader(stderr_reader, "stderr")?,
        timed_out: false,
        requires_certificate_confirmation: false,
    })
}

struct VpnProcessGuard<'a> {
    process_state: &'a VpnProcessState,
    child_id: u32,
}

impl Drop for VpnProcessGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.process_state.lock() {
            if *state == Some(self.child_id) {
                *state = None;
            }
        }
    }
}

fn read_pipe(pipe: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read vpncli output: {}", e))?;
    Ok(bytes)
}

fn join_reader(
    reader: thread::JoinHandle<Result<Vec<u8>, String>>,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    reader
        .join()
        .map_err(|_| format!("Failed to join vpncli {} reader", stream_name))?
}

fn to_vpn_result(output: VpnProcessOutput, success_markers: &[&str]) -> VpnCommandResult {
    to_vpn_result_with_redactions(output, success_markers, &[])
}

fn to_vpn_result_with_redactions(
    output: VpnProcessOutput,
    success_markers: &[&str],
    redactions: &[&str],
) -> VpnCommandResult {
    let raw_text = process_output_text(&output.stdout, &output.stderr);
    let lower_text = raw_text.to_lowercase();
    let text = redact_sensitive_output(&raw_text, redactions);
    let success = output.success
        || success_markers
            .iter()
            .any(|marker| lower_text.contains(marker));

    VpnCommandResult {
        success,
        output: text,
        requires_certificate_confirmation: false,
    }
}

fn redact_sensitive_output(output: &str, redactions: &[&str]) -> String {
    redactions
        .iter()
        .copied()
        .filter(|value| !value.is_empty())
        .fold(output.to_string(), |redacted, value| {
            redacted.replace(value, "[redacted]")
        })
}

fn process_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout_text = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr_text = String::from_utf8_lossy(stderr).trim().to_string();
    join_outputs(&[stdout_text, stderr_text])
}

fn vpn_is_disconnected(output: &VpnProcessOutput) -> bool {
    process_output_text(&output.stdout, &output.stderr)
        .lines()
        .map(str::trim)
        .any(|line| {
            let line = line.to_lowercase();
            line.strip_prefix("connection state:")
                .is_some_and(|state| state.trim() == "disconnected")
        })
}

fn vpn_disconnect_is_complete(output: &str) -> bool {
    output.lines().map(str::trim).any(|line| {
        let line = line.to_lowercase();
        line.contains(">> state: disconnected") || line.contains("vpn session ended")
    })
}

fn join_outputs(outputs: &[String]) -> String {
    outputs
        .iter()
        .filter(|output| !output.trim().is_empty())
        .map(|output| output.trim())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn timeout_output_hint(stdout: &[u8], stderr: &[u8]) -> String {
    let output = process_output_text(stdout, stderr);
    if output.is_empty() {
        String::new()
    } else {
        format!(" Last output:\n{}", output)
    }
}

fn resolve_vpncli_path() -> Result<PathBuf, String> {
    vpncli_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Could not find vpncli.exe. Install Cisco Secure Client or AnyConnect.".to_string()
        })
}

fn vpncli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("CISCO_VPNCLI_PATH") {
        candidates.push(PathBuf::from(path));
    }

    for base in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base_path) = env::var_os(base) {
            let base_path = PathBuf::from(base_path);
            for relative_path in [
                &["Cisco", "Cisco Secure Client", VPNCLI_EXE][..],
                &["Cisco", "Cisco Secure Client", "VPN", VPNCLI_EXE][..],
                &[
                    "Cisco",
                    "Cisco AnyConnect Secure Mobility Client",
                    VPNCLI_EXE,
                ][..],
            ] {
                candidates.push(
                    relative_path
                        .iter()
                        .fold(base_path.clone(), |path, part| path.join(part)),
                );
            }
        }
    }

    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|dir| dir.join(VPNCLI_EXE)));
    }

    candidates
}

fn cisco_profile_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(program_data) = env::var_os("ProgramData") {
        let program_data = PathBuf::from(program_data);
        dirs.push(
            program_data
                .join("Cisco")
                .join("Cisco AnyConnect Secure Mobility Client")
                .join("Profile"),
        );
        dirs.push(
            program_data
                .join("Cisco")
                .join("Cisco Secure Client")
                .join("VPN")
                .join("Profile"),
        );
    }

    dirs
}

fn parse_cisco_profile_xml(xml: &str, source: &str) -> Result<Vec<CiscoVpnProfileOption>, String> {
    let document = roxmltree::Document::parse(xml)
        .map_err(|e| format!("Failed to parse Cisco VPN profile XML: {}", e))?;
    let mut profiles = Vec::new();

    for host_entry in document
        .descendants()
        .filter(|node| node.has_tag_name("HostEntry"))
    {
        let server =
            child_text(host_entry, "HostAddress").or_else(|| child_text(host_entry, "HostName"));
        let Some(server) = server else {
            continue;
        };

        let name = child_text(host_entry, "HostName").unwrap_or_else(|| server.clone());

        profiles.push(CiscoVpnProfileOption {
            name,
            server,
            group: child_text(host_entry, "UserGroup"),
            source: source.to_string(),
        });
    }

    Ok(profiles)
}

fn child_text(node: roxmltree::Node<'_, '_>, tag_name: &str) -> Option<String> {
    node.children()
        .find(|child| child.has_tag_name(tag_name))
        .and_then(|child| child.text())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn app_config_file(file_name: &str) -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join(file_name))
}

fn app_config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|dir| dir.join(APP_CONFIG_DIR))
        .ok_or_else(|| "Could not find config directory".to_string())
}

fn validate_vpn_profile(profile: &VpnProfile) -> Result<(), String> {
    validate_cli_field("VPN profile id", &profile.id)?;
    validate_cli_field("VPN profile name", &profile.name)?;
    validate_cli_field("VPN server", &profile.server)?;

    if let Some(group) = &profile.group {
        validate_cli_field("VPN group", group)?;
    }

    if let Some(username) = &profile.username {
        validate_cli_field("VPN username", username)?;
    }

    if let Some(password) = &profile.password {
        validate_cli_field("VPN password", password)?;

        if trimmed_optional(&profile.username).is_none() {
            return Err("VPN username is required when password is saved".to_string());
        }
    }

    Ok(())
}

fn validate_cli_field(label: &str, value: &str) -> Result<(), String> {
    let trimmed_value = value.trim();
    if trimmed_value.is_empty() {
        return Err(format!("{} is required", label));
    }

    if value.chars().count() > MAX_VPN_FIELD_CHARS {
        return Err(format!(
            "{} must be {} characters or fewer",
            label, MAX_VPN_FIELD_CHARS
        ));
    }

    // vpncli -s treats newlines as new commands, so profile fields must stay single-line.
    if value.chars().any(|c| matches!(c, '\r' | '\n' | '\0')) {
        return Err(format!("{} cannot contain control characters", label));
    }

    Ok(())
}

fn trimmed_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn nonempty_optional(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

fn build_vpn_connect_script(
    server: &str,
    group: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
) -> String {
    let mut lines = vec![format!("connect {}", server.trim())];

    if let Some(group) = group {
        let group = group.trim();
        if !group.is_empty() {
            lines.push(group.to_string());
        }
    }

    if let Some(username) = username {
        let username = username.trim();
        if !username.is_empty() {
            lines.push(username.to_string());
        }
    }

    if let Some(password) = password {
        if !password.is_empty() {
            lines.push(password.to_string());
        }
    }

    format!("{}\n", lines.join("\n"))
}

fn profile_redactions(profile: &VpnProfile) -> Vec<&str> {
    [profile.username.as_deref(), profile.password.as_deref()]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect()
}

fn same_optional_text(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_cli_field_rejects_newline() {
        let result = validate_cli_field("VPN group", "prod\nconnect other");

        assert!(result.is_err());
    }

    #[test]
    fn validate_cli_field_rejects_trailing_newline() {
        let result = validate_cli_field("VPN password", "secret\n");

        assert!(result.is_err());
    }

    #[test]
    fn validate_cli_field_accepts_cisco_group_name() {
        let result = validate_cli_field("VPN group", "DfltGrpPolicy-Employees");

        assert!(result.is_ok());
    }

    #[test]
    fn build_vpn_connect_script_adds_group_as_single_response_line() {
        let script = build_vpn_connect_script("vpn.example.com", Some("Employees"), None, None);

        assert_eq!(script, "connect vpn.example.com\nEmployees\n");
    }

    #[test]
    fn build_vpn_connect_script_adds_credentials_after_group() {
        let script = build_vpn_connect_script(
            "vpn.example.com",
            Some("Employees"),
            Some("Chandan.Bhagat"),
            Some(" pass phrase "),
        );

        assert_eq!(
            script,
            "connect vpn.example.com\nEmployees\nChandan.Bhagat\n pass phrase \n"
        );
    }

    #[test]
    fn validate_vpn_profile_rejects_password_without_username() {
        let profile = VpnProfile {
            id: "vpn_1".to_string(),
            name: "Corporate".to_string(),
            server: "vpn.example.com".to_string(),
            group: Some("Employees".to_string()),
            username: None,
            password: Some("secret-password".to_string()),
        };

        let result = validate_vpn_profile(&profile);

        assert!(result.is_err());
    }

    #[test]
    fn replace_cisco_default_group_updates_only_the_group_value() {
        let preferences = r#"<?xml version="1.0" encoding="UTF-8"?>
<AnyConnectPreferences>
<DefaultHostName>64.253.43.4:4443</DefaultHostName>
<DefaultGroup>26SSQVPN_Users</DefaultGroup>
</AnyConnectPreferences>"#;

        let updated = replace_cisco_default_group(preferences, "OLLCreativeTeamVPN_Users").unwrap();

        assert!(updated.contains("<DefaultHostName>64.253.43.4:4443</DefaultHostName>"));
        assert!(updated.contains("<DefaultGroup>OLLCreativeTeamVPN_Users</DefaultGroup>"));
    }

    #[test]
    fn replace_cisco_default_group_escapes_xml_text() {
        let preferences =
            "<AnyConnectPreferences><DefaultGroup>Old</DefaultGroup></AnyConnectPreferences>";

        let updated = replace_cisco_default_group(preferences, "Creative & Support").unwrap();

        assert!(updated.contains("<DefaultGroup>Creative &amp; Support</DefaultGroup>"));
    }

    #[test]
    fn replace_cisco_default_group_rejects_missing_value() {
        let result = replace_cisco_default_group("<AnyConnectPreferences />", "Employees");

        assert!(result.is_err());
    }

    #[test]
    fn vpn_is_disconnected_uses_connection_state() {
        let disconnected = VpnProcessOutput {
            success: true,
            stdout: b"Connection State: Disconnected".to_vec(),
            stderr: Vec::new(),
            timed_out: false,
            requires_certificate_confirmation: false,
        };
        let connected = VpnProcessOutput {
            success: true,
            stdout: b"Connection State: Connected\nManagement Connection State: Disconnected (user tunnel active)".to_vec(),
            stderr: Vec::new(),
            timed_out: false,
            requires_certificate_confirmation: false,
        };

        assert!(vpn_is_disconnected(&disconnected));
        assert!(!vpn_is_disconnected(&connected));
    }

    #[test]
    fn vpn_disconnect_waits_for_a_terminal_disconnected_state() {
        assert!(!vpn_disconnect_is_complete(
            ">> state: Disconnecting\n>> notice: Disconnect in progress, please wait..."
        ));
        assert!(vpn_disconnect_is_complete(">> state: Disconnected"));
        assert!(vpn_disconnect_is_complete("VPN session ended"));
    }

    #[test]
    fn vpn_connect_requires_explicit_certificate_confirmation() {
        let mut state = VpnConnectPromptState::default();

        let action = next_vpn_connect_action(
            "Connect Anyway? [y/n]:",
            &mut state,
            Some("Employees"),
            Some("chandan"),
            Some("password"),
            false,
        );

        assert!(matches!(
            action,
            Some(VpnConnectAction::RequireCertificateConfirmation)
        ));
    }

    #[test]
    fn vpn_connect_sends_group_after_confirmed_certificate() {
        let mut state = VpnConnectPromptState::default();

        let certificate_action = next_vpn_connect_action(
            "Connect Anyway? [y/n]:",
            &mut state,
            Some("Employees"),
            Some("chandan"),
            Some("password"),
            true,
        );
        let group_action = next_vpn_connect_action(
            "Connect Anyway? [y/n]: Group:",
            &mut state,
            Some("Employees"),
            Some("chandan"),
            Some("password"),
            true,
        );

        assert!(matches!(
            certificate_action,
            Some(VpnConnectAction::Send(response)) if response == "y"
        ));
        assert!(matches!(
            group_action,
            Some(VpnConnectAction::Send(response)) if response == "Employees"
        ));
    }

    #[test]
    fn redact_sensitive_output_removes_saved_credentials() {
        let output = "Username: Chandan.Bhagat\nPassword: secret-password";
        let redacted = redact_sensitive_output(output, &["Chandan.Bhagat", "secret-password"]);

        assert_eq!(redacted, "Username: [redacted]\nPassword: [redacted]");
    }

    #[test]
    fn parse_cisco_profile_xml_extracts_server_and_group() {
        let xml = r#"
            <AnyConnectProfile>
              <ServerList>
                <HostEntry>
                  <HostName>Corporate VPN</HostName>
                  <HostAddress>vpn.example.com</HostAddress>
                  <UserGroup>Employees</UserGroup>
                </HostEntry>
              </ServerList>
            </AnyConnectProfile>
        "#;

        let profiles = parse_cisco_profile_xml(xml, "profile.xml").unwrap();

        assert_eq!(
            profiles,
            vec![CiscoVpnProfileOption {
                name: "Corporate VPN".to_string(),
                server: "vpn.example.com".to_string(),
                group: Some("Employees".to_string()),
                source: "profile.xml".to_string(),
            }]
        );
    }

    #[test]
    fn parse_cisco_profile_xml_skips_entries_without_server() {
        let xml = r#"
            <AnyConnectProfile>
              <ServerList>
                <HostEntry>
                  <HostName></HostName>
                </HostEntry>
              </ServerList>
            </AnyConnectProfile>
        "#;

        let profiles = parse_cisco_profile_xml(xml, "profile.xml").unwrap();

        assert!(profiles.is_empty());
    }

    #[test]
    fn same_optional_text_is_case_insensitive() {
        assert!(same_optional_text(
            &Some("Employees".to_string()),
            &Some("employees".to_string())
        ));
    }
}
