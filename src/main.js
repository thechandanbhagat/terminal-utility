const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State management
let savedProfiles = [];
let savedVpnProfiles = [];
let activeSessions = {}; // sessionId -> { id, name, host, term, fitAddon, container, isClosed }
let activeTabId = null;
let vpnOperationCancelRequested = false;
let pendingVpnCredentialResolver = null;
let pendingVpnCredentialProfile = null;

// DOM Elements
const sidebarTabs = document.querySelectorAll(".nav-tab");
const tabPanes = document.querySelectorAll(".tab-pane");
const btnAddProfile = document.getElementById("btn-add-profile");
const profilesList = document.getElementById("profiles-list");
const systemKeysList = document.getElementById("system-keys-list");
const btnGenerateKey = document.getElementById("btn-generate-key");
const keyDisplaySection = document.getElementById("key-display-section");
const pubkeyText = document.getElementById("pubkey-text");
const btnCopyPubkey = document.getElementById("btn-copy-pubkey");

const btnAddVpnProfile = document.getElementById("btn-add-vpn-profile");
const vpnProfilesList = document.getElementById("vpn-profiles-list");
const vpnClientPath = document.getElementById("vpn-client-path");
const vpnStatusOutput = document.getElementById("vpn-status-output");
const btnRefreshVpnStatus = document.getElementById("btn-refresh-vpn-status");
const btnDisconnectVpn = document.getElementById("btn-disconnect-vpn");
const btnCancelVpnOperation = document.getElementById("btn-cancel-vpn-operation");
const btnScanCiscoVpnProfiles = document.getElementById("btn-scan-cisco-vpn-profiles");
const ciscoVpnProfilesList = document.getElementById("cisco-vpn-profiles-list");
const vpnProfileModal = document.getElementById("vpn-profile-modal");
const vpnProfileForm = document.getElementById("vpn-profile-form");
const vpnModalTitle = document.getElementById("vpn-modal-title");
const btnCloseVpnModal = document.getElementById("btn-close-vpn-modal");
const btnCancelVpnModal = document.getElementById("btn-cancel-vpn-modal");
const vpnCredentialModal = document.getElementById("vpn-credential-modal");
const vpnCredentialForm = document.getElementById("vpn-credential-form");
const vpnCredentialTitle = document.getElementById("vpn-credential-title");
const vpnRuntimeUsername = document.getElementById("vpn-runtime-username");
const vpnRuntimePassword = document.getElementById("vpn-runtime-password");
const btnCloseVpnCredentialModal = document.getElementById("btn-close-vpn-credential-modal");
const btnCancelVpnCredentialModal = document.getElementById("btn-cancel-vpn-credential-modal");

// Quick Connect Form
const quickConnectForm = document.getElementById("quick-connect-form");
const qcAuthModeRadio = document.getElementsByName("qc-auth-mode");
const qcAuthKeyFields = document.getElementById("qc-auth-key-fields");
const qcAuthPasswordFields = document.getElementById("qc-auth-password-fields");
const qcKeypathInput = document.getElementById("qc-keypath");

// Modal Elements
const profileModal = document.getElementById("profile-modal");
const profileForm = document.getElementById("profile-form");
const modalTitle = document.getElementById("modal-title");
const btnCloseModal = document.getElementById("btn-close-modal");
const btnCancelModal = document.getElementById("btn-cancel-modal");
const btnSelectKeyfile = document.getElementById("btn-select-keyfile");
const profAuthModeRadio = document.getElementsByName("prof-auth-mode");
const profAuthKeyFields = document.getElementById("prof-auth-key-fields");
const profAuthPasswordFields = document.getElementById("prof-auth-password-fields");
const profKeypathInput = document.getElementById("prof-keypath");

// Workspace Elements
const tabsContainer = document.getElementById("tabs-container");
const btnNewTabPlus = document.getElementById("btn-new-tab-plus");
const workspaceViewport = document.getElementById("workspace-viewport");
const welcomeScreen = document.getElementById("welcome-screen");
const welcomeBtnNew = document.getElementById("welcome-btn-new");
const welcomeBtnAdd = document.getElementById("welcome-btn-add");

// Helper to encode string to base64 safely supporting Unicode/ANSI
function stringToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binString = "";
  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  return btoa(binString);
}

// Helper to decode base64 to Uint8Array for binary-safe terminal output
function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Initialize Application
window.addEventListener("DOMContentLoaded", () => {
  initWindowControls();
  initSettings();
  initZoomControls();
  initNavigation();
  initModal();
  initProfileList();
  initKeyManager();
  initVpnManager();
  initConnectionListeners();
  initWorkspace();
});

// --- WINDOW CONTROLS ---
function initWindowControls() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const appWindow = getCurrentWindow();

  document.getElementById("titlebar-minimize").addEventListener("click", () => {
    appWindow.minimize();
  });
  document.getElementById("titlebar-maximize").addEventListener("click", () => {
    appWindow.toggleMaximize();
  });
  document.getElementById("titlebar-close").addEventListener("click", () => {
    appWindow.close();
  });

  // Settings Tab trigger
  document.getElementById("titlebar-settings").addEventListener("click", () => {
    openSettingsTab();
  });
}

// --- SETTINGS MANAGEMENT ---
let appSettings = {
  fontSize: 14,
  zoomLevel: 1.0,
  defaultUser: "",
  defaultPort: 22,
  showVpnTab: false
};

function applyVpnTabVisibility() {
  const vpnTab = document.querySelector('.nav-tab[data-tab="vpn"]');
  if (vpnTab) {
    if (appSettings.showVpnTab) {
      vpnTab.classList.remove("hidden");
    } else {
      vpnTab.classList.add("hidden");
      // If the current active tab was VPN, switch to connections
      if (vpnTab.classList.contains("active")) {
        const connTab = document.querySelector('.nav-tab[data-tab="connections"]');
        if (connTab) {
          connTab.click();
        }
      }
    }
  }
}

function initSettings() {
  const saved = localStorage.getItem("sleekssh_settings");
  if (saved) {
    try {
      appSettings = { ...appSettings, ...JSON.parse(saved) };
    } catch (e) {
      console.error("Failed to parse settings:", e);
    }
  }

  // Apply default zoom
  zoomLevel = appSettings.zoomLevel;
  setAppZoom(zoomLevel);

  // Apply VPN tab visibility
  applyVpnTabVisibility();

  // Autofill forms default configurations
  const qcUser = document.getElementById("qc-username");
  const qcPort = document.getElementById("qc-port");
  const profPort = document.getElementById("prof-port");

  if (qcUser) qcUser.placeholder = appSettings.defaultUser || "root";
  if (qcPort && appSettings.defaultPort) qcPort.value = appSettings.defaultPort;
  if (profPort && appSettings.defaultPort) profPort.value = appSettings.defaultPort;
}

function saveSettings() {
  const fontSizeEl = document.getElementById("setting-font-size");
  const zoomEl = document.getElementById("setting-zoom-level");
  const userEl = document.getElementById("setting-default-user");
  const portEl = document.getElementById("setting-default-port");
  const showVpnEl = document.getElementById("setting-show-vpn");

  const fontSize = fontSizeEl ? (parseInt(fontSizeEl.value, 10) || 14) : appSettings.fontSize;
  const zoomFactor = zoomEl ? (parseFloat(zoomEl.value) || 1.0) : appSettings.zoomLevel;
  const defaultUser = userEl ? userEl.value.trim() : appSettings.defaultUser;
  const defaultPort = portEl ? (parseInt(portEl.value, 10) || 22) : appSettings.defaultPort;
  const showVpnTab = showVpnEl ? showVpnEl.checked : appSettings.showVpnTab;

  appSettings = {
    fontSize,
    zoomLevel: zoomFactor,
    defaultUser,
    defaultPort,
    showVpnTab
  };

  localStorage.setItem("sleekssh_settings", JSON.stringify(appSettings));

  // Apply VPN tab visibility
  applyVpnTabVisibility();

  // Apply zoom factor
  if (zoomLevel !== zoomFactor) {
    zoomLevel = zoomFactor;
    setAppZoom(zoomLevel);
  }

  // Apply font size to active xterm instances
  Object.values(activeSessions).forEach(session => {
    if (session.term) {
      session.term.options.fontSize = fontSize;
      setTimeout(() => fitTerminal(session), 50);
    }
  });

  // Autofill forms default configurations
  const qcUser = document.getElementById("qc-username");
  const qcPort = document.getElementById("qc-port");
  if (qcUser) qcUser.placeholder = defaultUser || "root";
  if (qcPort && document.activeElement !== qcPort) {
    qcPort.value = defaultPort;
  }
}

// --- ZOOM CONTROLS ---
let zoomLevel = 1.0;

function initZoomControls() {
  window.addEventListener("keydown", async (e) => {
    if (e.ctrlKey) {
      let zoomChanged = false;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomLevel = Math.min(zoomLevel + 0.1, 2.0);
        zoomChanged = true;
      } else if (e.key === "-") {
        e.preventDefault();
        zoomLevel = Math.max(zoomLevel - 0.1, 0.5);
        zoomChanged = true;
      } else if (e.key === "0") {
        e.preventDefault();
        zoomLevel = 1.0;
        zoomChanged = true;
      }

      if (zoomChanged) {
        await setAppZoom(zoomLevel);
        
        // Update Settings Select box value
        const zoomSelect = document.getElementById("setting-zoom-level");
        if (zoomSelect) {
          zoomSelect.value = zoomLevel.toFixed(1);
        }

        // Save zoom factor to persistent storage
        appSettings.zoomLevel = zoomLevel;
        localStorage.setItem("sleekssh_settings", JSON.stringify(appSettings));
      }
    }
  });
}

async function setAppZoom(factor) {
  try {
    const { getCurrentWebview } = window.__TAURI__.webview;
    const webview = getCurrentWebview();
    await webview.setZoom(factor);
  } catch (err) {
    console.error("Zoom failed:", err);
  }
}

// --- NAVIGATION & TABS (Sidebar) ---
function initNavigation() {
  sidebarTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      sidebarTabs.forEach(t => t.classList.remove("active"));
      tabPanes.forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      const targetPane = document.getElementById(`pane-${tab.dataset.tab}`);
      if (targetPane) targetPane.classList.add("active");
    });
  });

  // Radio button toggles for auth mode
  const setupAuthToggles = (radios, keyFields, pwdFields, keypathInput) => {
    radios.forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.value === "key") {
          keyFields.classList.remove("hidden");
          pwdFields.classList.add("hidden");
          // Fill keypath with default key if empty
          if (!keypathInput.value && savedProfiles.length > 0) {
            loadDefaultKeyForInput(keypathInput);
          }
        } else {
          keyFields.classList.add("hidden");
          pwdFields.classList.remove("hidden");
        }
      });
    });
  };

  setupAuthToggles(qcAuthModeRadio, qcAuthKeyFields, qcAuthPasswordFields, qcKeypathInput);
  setupAuthToggles(profAuthModeRadio, profAuthKeyFields, profAuthPasswordFields, profKeypathInput);

  // File browser for private key paths
  const selectKeyFileHandler = async (inputEl) => {
    try {
      const selected = await invoke("select_key_file");
      if (selected) {
        inputEl.value = selected;
      }
    } catch (e) {
      console.error("Failed to select key file:", e);
    }
  };

  btnSelectKeyfile.addEventListener("click", () => selectKeyFileHandler(profKeypathInput));
  
  // Quick connect key selector - let's make it click placeholder to open dial or add direct select
  qcKeypathInput.addEventListener("click", () => selectKeyFileHandler(qcKeypathInput));

  // Add click to check default key
  loadDefaultKeyForInput(qcKeypathInput);
  loadDefaultKeyForInput(profKeypathInput);
}

async function loadDefaultKeyForInput(inputEl) {
  try {
    const keys = await invoke("get_default_ssh_keys");
    if (keys && keys.length > 0) {
      inputEl.value = keys[0];
    }
  } catch (e) {
    console.error("Error loading default keys:", e);
  }
}

// --- PROFILE STORAGE & LIST ---
async function initProfileList() {
  try {
    savedProfiles = await invoke("load_connections");
    renderProfiles();
  } catch (e) {
    console.error("Failed to load profiles:", e);
    profilesList.innerHTML = `<div class="empty-state">Error loading profiles: ${e}</div>`;
  }
}

function renderProfiles() {
  if (savedProfiles.length === 0) {
    profilesList.innerHTML = `<div class="empty-state">No saved profiles. Click "+" to add.</div>`;
    return;
  }

  profilesList.innerHTML = "";

  // Group profiles by namespace
  const groups = {};
  savedProfiles.forEach(p => {
    const ns = p.namespace ? p.namespace.trim() : "";
    if (!groups[ns]) {
      groups[ns] = [];
    }
    groups[ns].push(p);
  });

  // Sort group names: Root/ungrouped first, folders alphabetically
  const groupNames = Object.keys(groups).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  groupNames.forEach(groupName => {
    const profiles = groups[groupName];
    
    if (groupName === "") {
      // Ungrouped profiles at root
      profiles.forEach(p => {
        const item = createProfileItemElement(p);
        profilesList.appendChild(item);
      });
    } else {
      // Collapsible folder for namespace
      const folderEl = document.createElement("div");
      folderEl.className = "profile-folder";
      
      const isCollapsed = localStorage.getItem(`folder_collapsed_${groupName}`) === "true";
      if (isCollapsed) {
        folderEl.classList.add("collapsed");
      }

      folderEl.innerHTML = `
        <div class="folder-header">
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span class="folder-name">${escapeHtml(groupName)}</span>
          <span class="folder-count">(${profiles.length})</span>
          <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="folder-content">
          <!-- Profiles appended here -->
        </div>
      `;

      const contentEl = folderEl.querySelector(".folder-content");
      profiles.forEach(p => {
        const item = createProfileItemElement(p);
        contentEl.appendChild(item);
      });

      // Toggle collapse on header click
      folderEl.querySelector(".folder-header").addEventListener("click", () => {
        const nowCollapsed = folderEl.classList.toggle("collapsed");
        localStorage.setItem(`folder_collapsed_${groupName}`, nowCollapsed);
      });

      profilesList.appendChild(folderEl);
    }
  });

  hookProfileActions();
}

function createProfileItemElement(p) {
  const item = document.createElement("div");
  item.className = "profile-item";
  item.innerHTML = `
    <div class="profile-item-header">
      <span class="profile-name">${escapeHtml(p.name)}</span>
      <div class="profile-actions">
        <button class="btn-action edit-action" title="Edit Profile" data-id="${p.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn-action delete-action" title="Delete Profile" data-id="${p.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="profile-details">
      <span>${escapeHtml(p.username)}@${escapeHtml(p.host)}:${p.port}</span>
      <span>(${p.use_password ? "pwd" : "key"})</span>
    </div>
  `;

  item.addEventListener("click", (e) => {
    if (e.target.closest(".btn-action")) return;
    connectProfile(p);
  });

  return item;
}

function hookProfileActions() {
  document.querySelectorAll(".edit-action").forEach(btn => {
    btn.addEventListener("click", () => {
      const profile = savedProfiles.find(p => p.id === btn.dataset.id);
      if (profile) showProfileModal(profile);
    });
  });

  document.querySelectorAll(".delete-action").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Are you sure you want to delete this connection profile?")) {
        savedProfiles = savedProfiles.filter(p => p.id !== btn.dataset.id);
        try {
          await invoke("save_connections", { connections: savedProfiles });
          renderProfiles();
        } catch (e) {
          alert("Failed to delete profile: " + e);
        }
      }
    });
  });
}

// --- SSH KEYS MANAGER ---
async function initKeyManager() {
  try {
    const keys = await invoke("get_default_ssh_keys");
    renderSystemKeys(keys);
  } catch (e) {
    console.error("Failed to load default keys:", e);
    systemKeysList.innerHTML = `<div class="key-item">Error reading ~/.ssh</div>`;
  }

  btnGenerateKey.addEventListener("click", async () => {
    btnGenerateKey.disabled = true;
    btnGenerateKey.textContent = "Generating Key...";
    try {
      const pubkey = await invoke("generate_new_ssh_key");
      pubkeyText.value = pubkey;
      keyDisplaySection.classList.remove("hidden");
      
      // Re-scan system keys
      const keys = await invoke("get_default_ssh_keys");
      renderSystemKeys(keys);
      alert("Ed25519 key generated successfully and saved to ~/.ssh/id_ed25519");
    } catch (e) {
      alert("Failed to generate SSH key: " + e);
    } finally {
      btnGenerateKey.disabled = false;
      btnGenerateKey.textContent = "Generate Ed25519 Key";
    }
  });

  btnCopyPubkey.addEventListener("click", () => {
    pubkeyText.select();
    navigator.clipboard.writeText(pubkeyText.value);
    btnCopyPubkey.textContent = "Copied!";
    setTimeout(() => {
      btnCopyPubkey.textContent = "Copy Key to Clipboard";
    }, 2000);
  });
}

function renderSystemKeys(keys) {
  if (!keys || keys.length === 0) {
    systemKeysList.innerHTML = `<div class="key-item" style="color: var(--text-secondary)">No existing keys found. Generate one below!</div>`;
    return;
  }

  systemKeysList.innerHTML = "";
  keys.forEach(k => {
    const item = document.createElement("div");
    item.className = "key-item";
    // Extract filename from full path
    const filename = k.split(/[\\/]/).pop();
    item.innerHTML = `
      <span>${escapeHtml(filename)}</span>
      <span class="small-text" style="color: var(--text-secondary); word-break: keep-all; font-size: 0.65rem;">${escapeHtml(k)}</span>
    `;
    systemKeysList.appendChild(item);
  });
}

async function initVpnManager() {
  btnAddVpnProfile.addEventListener("click", () => showVpnProfileModal());
  btnCloseVpnModal.addEventListener("click", hideVpnProfileModal);
  btnCancelVpnModal.addEventListener("click", hideVpnProfileModal);
  btnRefreshVpnStatus.addEventListener("click", () => refreshVpnStatus());
  btnDisconnectVpn.addEventListener("click", disconnectVpn);
  btnCancelVpnOperation.addEventListener("click", cancelVpnOperation);
  btnScanCiscoVpnProfiles.addEventListener("click", scanCiscoVpnProfiles);
  btnCloseVpnCredentialModal.addEventListener("click", cancelVpnCredentialPrompt);
  btnCancelVpnCredentialModal.addEventListener("click", cancelVpnCredentialPrompt);

  vpnProfileForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const id = document.getElementById("vpn-id").value || "vpn_" + Date.now();
    const name = document.getElementById("vpn-name").value.trim();
    const server = document.getElementById("vpn-server").value.trim();
    const group = document.getElementById("vpn-group").value.trim() || null;
    const username = document.getElementById("vpn-username").value.trim() || null;
    const password = document.getElementById("vpn-password").value || null;

    const newProfile = { id, name, server, group, username, password };
    const existingIndex = savedVpnProfiles.findIndex(p => p.id === id);

    if (existingIndex > -1) {
      savedVpnProfiles[existingIndex] = newProfile;
    } else {
      savedVpnProfiles.push(newProfile);
    }

    try {
      await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
      hideVpnProfileModal();
      renderVpnProfiles();
    } catch (err) {
      alert("Failed to save VPN shortcut: " + err);
    }
  });

  vpnCredentialForm.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!pendingVpnCredentialResolver || !pendingVpnCredentialProfile) return;

    const username = vpnRuntimeUsername.value.trim();
    const password = vpnRuntimePassword.value;

    if (!username || !password) {
      alert("VPN username and password are required to continue.");
      return;
    }

    const profile = {
      ...pendingVpnCredentialProfile,
      username,
      password
    };
    const resolve = pendingVpnCredentialResolver;

    closeVpnCredentialPrompt();
    resolve(profile);
  });

  await loadVpnProfiles();
  await detectVpnCli();
  refreshVpnStatus();
}

async function loadVpnProfiles() {
  try {
    savedVpnProfiles = await invoke("load_vpn_profiles");
    renderVpnProfiles();
  } catch (e) {
    console.error("Failed to load VPN shortcuts:", e);
    vpnProfilesList.innerHTML = `<div class="empty-state">Error loading VPN shortcuts: ${escapeHtml(e)}</div>`;
  }
}

function renderVpnProfiles() {
  if (savedVpnProfiles.length === 0) {
    vpnProfilesList.innerHTML = `<div class="empty-state">No VPN shortcuts saved. Click "+" to add one.</div>`;
    return;
  }

  vpnProfilesList.innerHTML = "";
  savedVpnProfiles
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(profile => {
      vpnProfilesList.appendChild(createVpnProfileItemElement(profile));
    });

  hookVpnProfileActions();
}

function createVpnProfileItemElement(profile) {
  const item = document.createElement("div");
  item.className = "profile-item vpn-profile-item";
  item.innerHTML = `
    <div class="profile-item-header">
      <span class="profile-name">${escapeHtml(profile.name)}</span>
      <div class="profile-actions">
        <button class="btn-action vpn-edit-action" title="Edit VPN Shortcut" data-id="${profile.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn-action vpn-delete-action" title="Delete VPN Shortcut" data-id="${profile.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="profile-details vpn-profile-details">
      <span>${escapeHtml(profile.server)}</span>
      <span>${profile.group ? escapeHtml(profile.group) : "Default group"}</span>
      <span>${profile.username ? escapeHtml(profile.username) : "No saved username"} / ${profile.password ? "Password saved" : "No saved password"}</span>
    </div>
  `;

  item.addEventListener("click", (e) => {
    if (e.target.closest(".btn-action")) return;
    switchVpnProfile(profile);
  });

  return item;
}

function hookVpnProfileActions() {
  document.querySelectorAll(".vpn-edit-action").forEach(btn => {
    btn.addEventListener("click", () => {
      const profile = savedVpnProfiles.find(p => p.id === btn.dataset.id);
      if (profile) showVpnProfileModal(profile);
    });
  });

  document.querySelectorAll(".vpn-delete-action").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (confirm("Are you sure you want to delete this VPN shortcut?")) {
        savedVpnProfiles = savedVpnProfiles.filter(p => p.id !== btn.dataset.id);
        try {
          await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
          renderVpnProfiles();
        } catch (e) {
          alert("Failed to delete VPN shortcut: " + e);
        }
      }
    });
  });
}

function showVpnProfileModal(profile = null) {
  vpnProfileForm.reset();

  if (profile) {
    vpnModalTitle.textContent = "Edit VPN Shortcut";
    document.getElementById("vpn-id").value = profile.id;
    document.getElementById("vpn-name").value = profile.name;
    document.getElementById("vpn-server").value = profile.server;
    document.getElementById("vpn-group").value = profile.group || "";
    document.getElementById("vpn-username").value = profile.username || "";
    document.getElementById("vpn-password").value = profile.password || "";
  } else {
    vpnModalTitle.textContent = "New VPN Shortcut";
    document.getElementById("vpn-id").value = "";
  }

  vpnProfileModal.classList.remove("hidden");
}

function hideVpnProfileModal() {
  vpnProfileModal.classList.add("hidden");
}

async function detectVpnCli() {
  try {
    vpnClientPath.textContent = await invoke("get_vpncli_path");
  } catch (e) {
    vpnClientPath.textContent = "vpncli.exe not found";
    setVpnStatus("Install Cisco Secure Client or AnyConnect, then refresh.");
  }
}

async function refreshVpnStatus(showLoading = true) {
  if (showLoading) {
    setVpnStatus("Checking VPN status...");
  }

  try {
    const result = await invoke("vpn_status");
    setVpnStatus(result.output || (result.success ? "VPN command completed." : "VPN status unavailable."));
  } catch (e) {
    setVpnStatus("VPN status failed: " + e);
  }
}

async function disconnectVpn() {
  setVpnControlsBusy(true, true);
  vpnOperationCancelRequested = false;
  setVpnStatus("Disconnecting VPN...");

  try {
    const result = await invoke("disconnect_vpn");
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN disconnect canceled.");
      return;
    }

    setVpnStatus(result.output || (result.success ? "VPN disconnected." : "Disconnect command did not report success."));
  } catch (e) {
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN disconnect canceled.");
      return;
    }

    setVpnStatus("VPN disconnect failed: " + e);
    alert("VPN disconnect failed: " + e);
  } finally {
    setVpnControlsBusy(false);
  }
}

async function switchVpnProfile(profile) {
  const connectProfile = await resolveVpnCredentials(profile);
  if (!connectProfile) return;

  setVpnControlsBusy(true, true);
  vpnOperationCancelRequested = false;
  setVpnStatus("Switching to " + profile.name + "...");

  try {
    const result = await invoke("switch_vpn_profile", { profile: connectProfile });
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN request canceled.");
      return;
    }

    setVpnStatus(result.output || (result.success ? "VPN switch completed." : "VPN switch did not report success."));
    if (!result.success) {
      alert("VPN switch command completed, but Cisco did not report a connected state.");
    }
  } catch (e) {
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN request canceled.");
      return;
    }

    setVpnStatus("VPN switch failed: " + e);
    alert("VPN switch failed: " + e);
  } finally {
    setVpnControlsBusy(false);
  }
}

async function cancelVpnOperation() {
  vpnOperationCancelRequested = true;
  btnCancelVpnOperation.disabled = true;
  setVpnStatus("Canceling VPN request...");

  try {
    await invoke("cancel_vpn_operation");
  } catch (e) {
    setVpnStatus("VPN cancel failed: " + e);
    alert("VPN cancel failed: " + e);
  }
}

function resolveVpnCredentials(profile) {
  if (profile.username && profile.password) {
    return Promise.resolve(profile);
  }

  return new Promise(resolve => {
    pendingVpnCredentialResolver = resolve;
    pendingVpnCredentialProfile = profile;
    vpnCredentialTitle.textContent = "VPN Credentials";
    vpnRuntimeUsername.value = profile.username || "";
    vpnRuntimePassword.value = "";
    vpnCredentialModal.classList.remove("hidden");
    setTimeout(() => {
      if (vpnRuntimeUsername.value) {
        vpnRuntimePassword.focus();
      } else {
        vpnRuntimeUsername.focus();
      }
    }, 0);
  });
}

function cancelVpnCredentialPrompt() {
  if (pendingVpnCredentialResolver) {
    pendingVpnCredentialResolver(null);
  }

  closeVpnCredentialPrompt();
}

function closeVpnCredentialPrompt() {
  vpnCredentialModal.classList.add("hidden");
  vpnCredentialForm.reset();
  pendingVpnCredentialResolver = null;
  pendingVpnCredentialProfile = null;
}

async function scanCiscoVpnProfiles() {
  setVpnControlsBusy(true);
  ciscoVpnProfilesList.innerHTML = `<div class="small-text">Scanning Cisco profile XML...</div>`;

  try {
    const profiles = await invoke("list_cisco_vpn_profiles");
    renderCiscoVpnProfiles(profiles);
  } catch (e) {
    ciscoVpnProfilesList.innerHTML = `<div class="small-text">Scan failed: ${escapeHtml(e)}</div>`;
  } finally {
    setVpnControlsBusy(false);
  }
}

function renderCiscoVpnProfiles(profiles) {
  if (!profiles || profiles.length === 0) {
    ciscoVpnProfilesList.innerHTML = `<div class="small-text">No Cisco VPN profile groups found.</div>`;
    return;
  }

  ciscoVpnProfilesList.innerHTML = "";
  profiles.forEach((profile, index) => {
    const item = document.createElement("div");
    item.className = "vpn-import-item";
    item.innerHTML = `
      <div class="vpn-import-details">
        <span class="vpn-import-name">${escapeHtml(profile.name)}</span>
        <span class="vpn-import-meta">${escapeHtml(profile.server)}${profile.group ? " / " + escapeHtml(profile.group) : ""}</span>
        <span class="vpn-import-source">${escapeHtml(profile.source)}</span>
      </div>
      <button class="btn btn-secondary btn-small" data-index="${index}">Import</button>
    `;

    item.querySelector("button").addEventListener("click", async () => {
      await importCiscoVpnProfile(profile);
    });

    ciscoVpnProfilesList.appendChild(item);
  });
}

async function importCiscoVpnProfile(profile) {
  const exists = savedVpnProfiles.some(savedProfile =>
    savedProfile.server.toLowerCase() === profile.server.toLowerCase()
    && (savedProfile.group || "").toLowerCase() === (profile.group || "").toLowerCase()
  );

  if (exists) {
    alert("That VPN shortcut already exists.");
    return;
  }

  savedVpnProfiles.push({
    id: "vpn_" + Date.now(),
    name: profile.name,
    server: profile.server,
    group: profile.group || null,
    username: null,
    password: null
  });

  try {
    await invoke("save_vpn_profiles", { profiles: savedVpnProfiles });
    renderVpnProfiles();
  } catch (e) {
    alert("Failed to import VPN shortcut: " + e);
  }
}

function setVpnStatus(message) {
  vpnStatusOutput.textContent = message;
}

function setVpnControlsBusy(isBusy, canCancel = false) {
  [
    btnAddVpnProfile,
    btnRefreshVpnStatus,
    btnDisconnectVpn,
    btnScanCiscoVpnProfiles
  ].forEach(button => {
    button.disabled = isBusy;
  });

  document.querySelectorAll(".vpn-profile-item").forEach(item => {
    item.classList.toggle("busy", isBusy);
  });

  btnCancelVpnOperation.classList.toggle("hidden", !(isBusy && canCancel));
  btnCancelVpnOperation.disabled = !(isBusy && canCancel);
}

// --- MODAL DIALOGS ---
function initModal() {
  btnAddProfile.addEventListener("click", () => showProfileModal());
  btnCloseModal.addEventListener("click", hideProfileModal);
  btnCancelModal.addEventListener("click", hideProfileModal);

  profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const id = document.getElementById("prof-id").value || "prof_" + Date.now();
    const name = document.getElementById("prof-name").value;
    const namespace = document.getElementById("prof-namespace").value.trim() || null;
    const host = document.getElementById("prof-host").value;
    const port = parseInt(document.getElementById("prof-port").value, 10);
    const username = document.getElementById("prof-username").value;
    const usePassword = document.querySelector('input[name="prof-auth-mode"]:checked').value === "password";
    const keyPath = profKeypathInput.value;
    const passphrase = document.getElementById("prof-passphrase").value || null;
    const password = document.getElementById("prof-password").value || null;

    const newProfile = {
      id,
      name,
      host,
      port,
      username,
      key_path: keyPath,
      passphrase,
      password,
      use_password: usePassword,
      namespace
    };

    const existingIndex = savedProfiles.findIndex(p => p.id === id);
    if (existingIndex > -1) {
      savedProfiles[existingIndex] = newProfile;
    } else {
      savedProfiles.push(newProfile);
    }

    try {
      await invoke("save_connections", { connections: savedProfiles });
      hideProfileModal();
      initProfileList();
    } catch (err) {
      alert("Failed to save profile: " + err);
    }
  });
}

function showProfileModal(profile = null) {
  profileForm.reset();
  loadDefaultKeyForInput(profKeypathInput);

  if (profile) {
    modalTitle.textContent = "Edit Connection Profile";
    document.getElementById("prof-id").value = profile.id;
    document.getElementById("prof-name").value = profile.name;
    document.getElementById("prof-namespace").value = profile.namespace || "";
    document.getElementById("prof-host").value = profile.host;
    document.getElementById("prof-port").value = profile.port;
    document.getElementById("prof-username").value = profile.username;
    
    if (profile.use_password) {
      document.querySelector('input[name="prof-auth-mode"][value="password"]').checked = true;
      profAuthKeyFields.classList.add("hidden");
      profAuthPasswordFields.classList.remove("hidden");
      document.getElementById("prof-password").value = profile.password || "";
    } else {
      document.querySelector('input[name="prof-auth-mode"][value="key"]').checked = true;
      profAuthKeyFields.classList.remove("hidden");
      profAuthPasswordFields.classList.add("hidden");
      profKeypathInput.value = profile.key_path;
      document.getElementById("prof-passphrase").value = profile.passphrase || "";
    }
  } else {
    modalTitle.textContent = "New Connection Profile";
    document.getElementById("prof-id").value = "";
    document.getElementById("prof-namespace").value = "";
    document.querySelector('input[name="prof-auth-mode"][value="key"]').checked = true;
    profAuthKeyFields.classList.remove("hidden");
    profAuthPasswordFields.classList.add("hidden");
  }

  profileModal.classList.remove("hidden");
}

function hideProfileModal() {
  profileModal.classList.add("hidden");
}

// --- WORKSPACE & TAB MANAGEMENT ---
function initWorkspace() {
  btnNewTabPlus.addEventListener("click", () => {
    // Switch to Quick Connect tab in sidebar and show connect
    const qcTab = Array.from(sidebarTabs).find(t => t.dataset.tab === "quick-connect");
    if (qcTab) qcTab.click();
  });

  welcomeBtnNew.addEventListener("click", () => {
    const qcTab = Array.from(sidebarTabs).find(t => t.dataset.tab === "quick-connect");
    if (qcTab) qcTab.click();
  });

  welcomeBtnAdd.addEventListener("click", () => {
    showProfileModal();
  });

  quickConnectForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("qc-name").value;
    const host = document.getElementById("qc-host").value;
    const port = parseInt(document.getElementById("qc-port").value, 10);
    const username = document.getElementById("qc-username").value;
    const usePassword = document.querySelector('input[name="qc-auth-mode"]:checked').value === "password";
    const keyPath = qcKeypathInput.value;
    const passphrase = document.getElementById("qc-passphrase").value || null;
    const password = document.getElementById("qc-password").value || null;

    const quickProfile = {
      id: "qc_" + Date.now(),
      name,
      host,
      port,
      username,
      key_path: keyPath,
      passphrase,
      password,
      use_password: usePassword
    };

    connectProfile(quickProfile);
  });

  // Global window resize to fit terminals
  window.addEventListener("resize", () => {
    Object.values(activeSessions).forEach(session => {
      if (session.fitAddon) {
        fitTerminal(session);
      }
    });
  });
}

function switchTab(sessionId) {
  activeTabId = sessionId;

  // Update Tab Elements UI
  document.querySelectorAll(".terminal-tab").forEach(tab => {
    if (tab.dataset.id === sessionId) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });

  // Update Container Elements UI
  document.querySelectorAll(".session-container").forEach(container => {
    if (container.dataset.id === sessionId) {
      container.classList.add("active");
    } else {
      container.classList.remove("active");
    }
  });

  // Focus terminal
  const activeSession = activeSessions[sessionId];
  if (activeSession && activeSession.term) {
    activeSession.term.focus();
    // Refit after active display
    setTimeout(() => fitTerminal(activeSession), 50);
  }
}

function fitTerminal(session) {
  try {
    session.fitAddon.fit();
    const cols = session.term.cols;
    const rows = session.term.rows;
    // Send resize command to backend
    invoke("resize_ssh", { sessionId: session.id, cols, rows }).catch(e => {
      console.warn("Resize failed:", e);
    });
  } catch (e) {
    console.error("Fit error:", e);
  }
}

async function closeTab(sessionId) {
  const session = activeSessions[sessionId];
  if (!session) return;

  // Call disconnect for actual SSH sessions
  if (sessionId !== "settings") {
    try {
      await invoke("disconnect_ssh", { sessionId });
    } catch (e) {
      console.warn("Disconnect request failed:", e);
    }
  }

  // Remove elements
  const tabEl = document.querySelector(`.terminal-tab[data-id="${sessionId}"]`);
  if (tabEl) tabEl.remove();

  const containerEl = document.querySelector(`.session-container[data-id="${sessionId}"]`);
  if (containerEl) containerEl.remove();

  // Dispose terminal
  if (session.term) {
    session.term.dispose();
  }

  delete activeSessions[sessionId];

  // Select next active tab
  const remainingIds = Object.keys(activeSessions);
  if (remainingIds.length > 0) {
    switchTab(remainingIds[remainingIds.length - 1]);
  } else {
    activeTabId = null;
    welcomeScreen.classList.remove("hidden");
  }
}

// --- SSH CONNECTIONS ---
async function connectProfile(profile) {
  welcomeScreen.classList.add("hidden");
  const sessionId = profile.id + "_" + Date.now();

  // Create loading tab
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-tab active";
  tabEl.dataset.id = sessionId;
  tabEl.innerHTML = `
    <span class="tab-title">Connecting...</span>
    <button class="btn-tab-close">&times;</button>
  `;
  tabsContainer.appendChild(tabEl);

  // Close tab hook
  tabEl.querySelector(".btn-tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(sessionId);
  });

  tabEl.addEventListener("click", () => switchTab(sessionId));

  // Create session split layout container (Terminal + SFTP Panel)
  const sessionContainer = document.createElement("div");
  sessionContainer.className = "session-container active";
  sessionContainer.dataset.id = sessionId;
  sessionContainer.innerHTML = `
    <div class="terminal-viewport"></div>
    <button class="sftp-toggle-btn" title="Toggle SFTP Panel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
    </button>
    <div class="sftp-panel">
      <div class="sftp-header">
        <button class="sftp-btn btn-up" title="Up Directory">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="19" x2="12" y2="5"></line>
            <polyline points="5 12 12 5 19 12"></polyline>
          </svg>
        </button>
        <input type="text" class="sftp-path-input" value="/" />
        <button class="sftp-btn btn-refresh" title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
        </button>
        <button class="sftp-btn btn-new-folder" title="New Folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
        </button>
        <button class="sftp-btn btn-upload" title="Upload File">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="17 8 12 3 7 8"></polyline>
            <line x1="12" y1="3" x2="12" y2="15"></line>
          </svg>
        </button>
      </div>
      <div class="sftp-files-list">
        <!-- Files list populated dynamically -->
      </div>
    </div>
  `;
  workspaceViewport.appendChild(sessionContainer);

  // Switch to it immediately
  switchTab(sessionId);

  // Mark in active sessions
  activeSessions[sessionId] = {
    id: sessionId,
    name: profile.name,
    host: profile.host,
    container: sessionContainer,
    isClosed: false,
    currentPath: "/",
    sftpPanelOpen: true
  };

  try {
    // Initiate connection
    await invoke("connect_ssh", {
      appHandle: null, // Tauri injects this automatically
      state: null,     // Tauri injects this automatically
      sessionId,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      keyPath: profile.key_path || "",
      passphrase: profile.passphrase,
      password: profile.password,
      usePassword: profile.use_password
    });

    // Update tab title
    tabEl.querySelector(".tab-title").textContent = profile.name;

    // Create Xterm terminal
    const term = new Terminal({
      theme: {
        background: "#000000",
        foreground: "#f8f8f2",
        cursor: "#f8f8f0",
        black: "#000000",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#bfbfbf",
        brightBlack: "#4d4d4d",
        brightRed: "#ff6e67",
        brightGreen: "#5af78e",
        brightYellow: "#f4f99d",
        brightBlue: "#caa9fa",
        brightMagenta: "#ff92d0",
        brightCyan: "#9aedfe",
        brightWhite: "#e6e6e6"
      },
      cursorBlink: true,
      fontFamily: "Fira Code, monospace",
      fontSize: appSettings.fontSize,
      scrollback: 5000
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    term.open(sessionContainer.querySelector(".terminal-viewport"));
    fitAddon.fit();

    // Store objects in state
    activeSessions[sessionId].term = term;
    activeSessions[sessionId].fitAddon = fitAddon;

    // Initialize SFTP panel for session
    initSftpForSession(activeSessions[sessionId]);

    // Hook inputs
    term.onData((data) => {
      if (activeSessions[sessionId].isClosed) return;
      const b64 = stringToBase64(data);
      invoke("write_ssh", { sessionId, dataBase64: b64 }).catch(err => {
        console.error("Write error:", err);
      });
    });

    // Fit & Resize initial size
    fitTerminal(activeSessions[sessionId]);
    term.focus();

  } catch (err) {
    // If it fails, print error or clean up
    console.error("SSH Connect failed:", err);
    tabEl.querySelector(".tab-title").textContent = "Failed";
    tabEl.querySelector(".tab-title").style.color = "var(--danger-color)";
    
    // Inject custom alert container or show on screen
    const errorMsg = document.createElement("div");
    errorMsg.style.padding = "20px";
    errorMsg.style.color = "var(--danger-color)";
    errorMsg.style.fontFamily = "var(--font-mono)";
    errorMsg.style.fontSize = "0.9rem";
    errorMsg.innerHTML = `
      <h3>Connection Failed</h3>
      <p style="margin-top: 10px; color: var(--text-primary);">${escapeHtml(err)}</p>
      <button class="btn btn-secondary" style="margin-top: 20px;" onclick="document.querySelector('.terminal-tab[data-id=\\'${sessionId}\\'] .btn-tab-close').click()">Close Tab</button>
    `;
    sessionContainer.appendChild(errorMsg);
    activeSessions[sessionId].isClosed = true;
  }
}

// --- CONFIGURE TAURI EVENT LISTENERS ---
function initConnectionListeners() {
  // Listen for terminal output
  listen("ssh-output", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (session && session.term) {
      const bytes = base64ToBytes(payload.data);
      session.term.write(bytes);
    }
  });

  // Listen for connection close
  listen("ssh-closed", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (session) {
      session.isClosed = true;
      if (session.term) {
        session.term.write("\r\n\x1b[31m[Connection closed by remote host]\x1b[0m\r\n");
      }
    }
  });

  // Listen for connection errors
  listen("ssh-error", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (session) {
      session.isClosed = true;
      if (session.term) {
        session.term.write(`\r\n\x1b[31m[SSH Connection Error: ${escapeHtml(payload.data)}]\x1b[0m\r\n`);
      }
    }
  });
}

// --- HELPER FUNCTIONS ---
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// --- SFTP FRONTEND INTEGRATION ---

function initSftpForSession(session) {
  const container = session.container;
  const toggleBtn = container.querySelector(".sftp-toggle-btn");
  const btnUp = container.querySelector(".btn-up");
  const btnRefresh = container.querySelector(".btn-refresh");
  const btnNewFolder = container.querySelector(".btn-new-folder");
  const btnUpload = container.querySelector(".btn-upload");
  const pathInput = container.querySelector(".sftp-path-input");

  // Toggle panel collapse/expand
  toggleBtn.addEventListener("click", () => {
    session.sftpPanelOpen = !session.sftpPanelOpen;
    if (session.sftpPanelOpen) {
      container.classList.remove("sftp-collapsed");
    } else {
      container.classList.add("sftp-collapsed");
    }
    // Refit terminal to new width
    setTimeout(() => fitTerminal(session), 260);
  });

  // Go up one directory level
  btnUp.addEventListener("click", () => {
    let parts = session.currentPath.split("/").filter(Boolean);
    parts.pop();
    let parentPath = "/" + parts.join("/");
    loadSftpDirectory(session, parentPath);
  });

  // Refresh directory
  btnRefresh.addEventListener("click", () => {
    loadSftpDirectory(session, session.currentPath);
  });

  // Create directory
  btnNewFolder.addEventListener("click", async () => {
    const folderName = prompt("Enter new folder name:");
    if (!folderName || !folderName.trim()) return;
    
    let path = session.currentPath;
    if (!path.endsWith("/")) path += "/";
    path += folderName.trim();

    try {
      await invoke("sftp_create_directory", { sessionId: session.id, path });
      loadSftpDirectory(session, session.currentPath);
    } catch (e) {
      alert("Failed to create folder: " + e);
    }
  });

  // Upload file
  btnUpload.addEventListener("click", async () => {
    try {
      const localPath = await invoke("select_upload_file");
      if (!localPath) return;

      const filename = localPath.split(/[\\/]/).pop();
      let remotePath = session.currentPath;
      if (!remotePath.endsWith("/")) remotePath += "/";
      remotePath += filename;

      // Show upload indicator
      const fileListEl = container.querySelector(".sftp-files-list");
      fileListEl.innerHTML = `<div class="sftp-status">Uploading: ${escapeHtml(filename)}...</div>`;

      await invoke("sftp_upload_file", { sessionId: session.id, localPath, remotePath });
      loadSftpDirectory(session, session.currentPath);
    } catch (e) {
      alert("Upload failed: " + e);
      loadSftpDirectory(session, session.currentPath);
    }
  });

  // Path input navigation
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadSftpDirectory(session, pathInput.value.trim());
    }
  });

  // Load initial root directory
  loadSftpDirectory(session, "/");
}

async function loadSftpDirectory(session, path) {
  const container = session.container;
  const fileListEl = container.querySelector(".sftp-files-list");
  const pathInput = container.querySelector(".sftp-path-input");

  if (!fileListEl) return;

  fileListEl.innerHTML = `<div class="sftp-status">Loading files...</div>`;

  // Standardize root empty path
  if (!path || path.trim() === "") {
    path = "/";
  }

  try {
    const files = await invoke("sftp_list_directory", { sessionId: session.id, path });
    
    // Update path cache and UI input box
    session.currentPath = path;
    if (pathInput) pathInput.value = path;

    if (files.length === 0) {
      fileListEl.innerHTML = `<div class="sftp-status">Empty Directory</div>`;
      return;
    }

    fileListEl.innerHTML = "";
    files.forEach(file => {
      const item = document.createElement("div");
      item.className = "sftp-item";
      item.dataset.path = file.path;
      item.dataset.isDir = file.is_dir;
      
      const sizeStr = file.is_dir ? "" : formatBytes(file.size);

      item.innerHTML = `
        <div class="sftp-item-icon ${file.is_dir ? 'folder' : 'file'}">
          ${file.is_dir 
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`
          }
        </div>
        <span class="sftp-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="sftp-item-size">${sizeStr}</span>
        <div class="sftp-item-actions">
          ${!file.is_dir ? `
            <button class="btn-sftp-download sftp-btn" title="Download file">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </button>
          ` : ''}
          <button class="btn-sftp-delete sftp-btn danger" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>
      `;

      // Handle folder navigation or file selection
      item.addEventListener("dblclick", () => {
        if (file.is_dir) {
          loadSftpDirectory(session, file.path);
        } else {
          // Trigger file download automatically on double-click
          const downloadBtn = item.querySelector(".btn-sftp-download");
          if (downloadBtn) downloadBtn.click();
        }
      });

      // Selection indicator
      item.addEventListener("click", () => {
        container.querySelectorAll(".sftp-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");
      });

      // Download file handler
      const downloadBtn = item.querySelector(".btn-sftp-download");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const localDestination = await invoke("select_download_destination", { filename: file.name });
            if (!localDestination) return;

            fileListEl.innerHTML = `<div class="sftp-status">Downloading: ${escapeHtml(file.name)}...</div>`;
            await invoke("sftp_download_file", { sessionId: session.id, remotePath: file.path, localPath: localDestination });
            
            // Reload list
            loadSftpDirectory(session, session.currentPath);
          } catch (err) {
            alert("Download failed: " + err);
            loadSftpDirectory(session, session.currentPath);
          }
        });
      }

      // Delete file / folder handler
      const deleteBtn = item.querySelector(".btn-sftp-delete");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete "${file.name}"?`)) {
            try {
              if (file.is_dir) {
                await invoke("sftp_delete_directory", { sessionId: session.id, path: file.path });
              } else {
                await invoke("sftp_delete_file", { sessionId: session.id, path: file.path });
              }
              loadSftpDirectory(session, session.currentPath);
            } catch (err) {
              alert("Deletion failed: " + err);
            }
          }
        });
      }

      fileListEl.appendChild(item);
    });

  } catch (err) {
    console.error("SFTP List failed:", err);
    fileListEl.innerHTML = `<div class="sftp-status error">Error: ${escapeHtml(err)}</div>`;
  }
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function openSettingsTab() {
  const settingsTabId = "settings";
  
  // Check if already open
  const existingTab = document.querySelector(`.terminal-tab[data-id="${settingsTabId}"]`);
  if (existingTab) {
    switchTab(settingsTabId);
    return;
  }
  
  welcomeScreen.classList.add("hidden");
  
  // Create tab header
  const tabEl = document.createElement("div");
  tabEl.className = "terminal-tab active";
  tabEl.dataset.id = settingsTabId;
  tabEl.innerHTML = `
    <span class="tab-title" style="display: flex; align-items: center; gap: 6px;">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: translateY(0.5px);"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      Settings
    </span>
    <button class="btn-tab-close">&times;</button>
  `;
  tabsContainer.appendChild(tabEl);
  
  // Close tab hook
  tabEl.querySelector(".btn-tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(settingsTabId);
  });
  
  tabEl.addEventListener("click", () => switchTab(settingsTabId));
  
  // Create settings container in workspace
  const settingsContainer = document.createElement("div");
  settingsContainer.className = "session-container active";
  settingsContainer.dataset.id = settingsTabId;
  settingsContainer.innerHTML = `
    <div class="settings-tab-viewport" style="flex: 1; overflow-y: auto; padding: 40px 20px;">
      <div class="settings-content-wrapper" style="max-width: 600px; margin: 0 auto; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 12px; box-shadow: 0 15px 35px rgba(0,0,0,0.3); overflow: hidden;">
        <div class="settings-tab-header" style="padding: 24px 30px; border-bottom: 1px solid var(--border-color); background: rgba(0, 0, 0, 0.15);">
          <h2 style="font-size: 1.25rem; color: #fff; display: flex; align-items: center; gap: 10px; margin: 0;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            Application Settings
          </h2>
          <p style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 6px; margin-bottom: 0;">Configure terminal visual styles, layout zoom scaling, and connection defaults.</p>
        </div>
        <div class="settings-tab-body" style="padding: 30px; display: flex; flex-direction: column; gap: 20px;">
          <div class="form-group">
            <label>Terminal Font Size (px)</label>
            <input type="number" id="setting-font-size" min="10" max="30" value="${appSettings.fontSize}" required />
          </div>
          <div class="form-group">
            <label>Window Zoom Level</label>
            <select id="setting-zoom-level" style="background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 12px; color: #fff; font-family: var(--font-sans); font-size: 0.85rem; width: 100%;">
              <option value="0.5">50%</option>
              <option value="0.6">60%</option>
              <option value="0.7">70%</option>
              <option value="0.8">80%</option>
              <option value="0.9">90%</option>
              <option value="1.0">100%</option>
              <option value="1.1">110%</option>
              <option value="1.2">120%</option>
              <option value="1.3">130%</option>
              <option value="1.4">140%</option>
              <option value="1.5">150%</option>
              <option value="1.75">175%</option>
              <option value="2.0">200%</option>
            </select>
          </div>
          <div class="form-group">
            <label>Default SSH Username</label>
            <input type="text" id="setting-default-user" value="${appSettings.defaultUser}" placeholder="root" />
          </div>
          <div class="form-group">
            <label>Default SSH Port</label>
            <input type="number" id="setting-default-port" value="${appSettings.defaultPort}" />
          </div>
          <div class="switch-group">
            <div class="switch-label-wrapper">
              <span class="switch-title">Enable VPN Switcher Tab</span>
              <span class="switch-description">Show or hide the Cisco AnyConnect VPN integration tab in the sidebar.</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="setting-show-vpn" ${appSettings.showVpnTab ? "checked" : ""} />
              <span class="slider"></span>
            </label>
          </div>
          <p class="helper-text" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 5px; margin-bottom: 0;">Settings are automatically saved and applied instantly.</p>
        </div>
      </div>
    </div>
  `;
  workspaceViewport.appendChild(settingsContainer);
  
  // Set current selected values
  settingsContainer.querySelector("#setting-zoom-level").value = appSettings.zoomLevel.toFixed(1);
  
  // Bind input listeners
  settingsContainer.querySelector("#setting-font-size").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-zoom-level").addEventListener("change", saveSettings);
  settingsContainer.querySelector("#setting-default-user").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-default-port").addEventListener("input", saveSettings);
  settingsContainer.querySelector("#setting-show-vpn").addEventListener("change", saveSettings);

  activeSessions[settingsTabId] = {
    id: settingsTabId,
    name: "Settings",
    container: settingsContainer,
    isClosed: false
  };

  switchTab(settingsTabId);
}
