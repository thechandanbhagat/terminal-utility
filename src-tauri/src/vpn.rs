use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
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
const VPNCLI_TIMEOUT_SECONDS: u64 = 120;
const MAX_VPN_FIELD_CHARS: usize = 512;

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
        let output = run_vpncli(&process_state, &["stats"], None)?;
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

        let connect_result = connect_vpn_internal(&process_state, &profile)?;

        Ok(VpnCommandResult {
            success: connect_result.success,
            output: join_outputs(&[disconnect_result.output, connect_result.output]),
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
    let output = run_vpncli(process_state, &["disconnect"], None)?;
    Ok(to_vpn_result(
        output,
        &["state: disconnected", "vpn session ended", "disconnected"],
    ))
}

fn connect_vpn_internal(
    process_state: &VpnProcessState,
    profile: &VpnProfile,
) -> Result<VpnCommandResult, String> {
    let group = trimmed_optional(&profile.group);
    let username = trimmed_optional(&profile.username);
    let password = nonempty_optional(&profile.password);
    let output = if group.is_some() || username.is_some() || password.is_some() {
        let script = build_vpn_connect_script(
            &profile.server,
            group.as_deref(),
            username.as_deref(),
            password,
        );
        run_vpncli(process_state, &["-s"], Some(&script))?
    } else {
        run_vpncli(process_state, &["connect", profile.server.trim()], None)?
    };
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

fn run_vpncli(
    process_state: &VpnProcessState,
    args: &[&str],
    stdin_text: Option<&str>,
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

        if started_at.elapsed() > Duration::from_secs(VPNCLI_TIMEOUT_SECONDS) {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = join_reader(stdout_reader, "stdout")?;
            let stderr = join_reader(stderr_reader, "stderr")?;
            return Err(format!(
                "vpncli timed out after {} seconds.{}",
                VPNCLI_TIMEOUT_SECONDS,
                timeout_output_hint(&stdout, &stderr)
            ));
        }

        thread::sleep(Duration::from_millis(100));
    };

    Ok(VpnProcessOutput {
        success,
        stdout: join_reader(stdout_reader, "stdout")?,
        stderr: join_reader(stderr_reader, "stderr")?,
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
