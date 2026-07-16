const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State management
let savedProfiles = [];
let savedVpnProfiles = [];
let activeSessions = {}; // sessionId -> { id, name, host, term, fitAddon, container, isClosed }
let activeTabId = null;
let vpnOperationCancelRequested = false;
let vpnConnectionActive = false;
let vpnControlsBusy = false;
let pendingVpnCredentialResolver = null;
let pendingVpnCredentialProfile = null;
let pendingVpnCertificateProfile = null;
let quickConnectModalTrigger = null;
let notificationElement = null;
let notificationTimeoutId = null;
const NAMESPACE_SEPARATOR = "/";
const NOTIFICATION_DURATION_MS = 3500;
const SFTP_EXPLORER_STATE_STORAGE_KEY = "sleekssh_sftp_explorer_state";
const REMOTE_HOME_DIRECTORY = ".";
const ROOT_REMOTE_DIRECTORY = "/";
const SFTP_PANEL_TRANSITION_MS = 260;
const TERMINAL_DIRECTORY_SYNC_DELAY_MS = 50;
const TERMINAL_SCROLLBAR_WIDTH = 6;
const TERMINAL_SEARCH_REFRESH_DELAY_MS = 100;
const TERMINAL_SEARCH_MATCH_COLOR = "#4c3d0a";
const TERMINAL_SEARCH_ACTIVE_MATCH_COLOR = "#0f766e";
const TERMINAL_SEARCH_MATCH_RULER_COLOR = "#facc15";
const TERMINAL_SEARCH_ACTIVE_MATCH_RULER_COLOR = "#2dd4bf";

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
const vpnConnectionState = document.getElementById("vpn-connection-state");
const vpnConnectionSummary = document.getElementById("vpn-connection-summary");
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
const vpnCertificateModal = document.getElementById("vpn-certificate-modal");
const vpnCertificateServer = document.getElementById("vpn-certificate-server");
const btnCloseVpnCertificateModal = document.getElementById("btn-close-vpn-certificate-modal");
const btnCancelVpnCertificateModal = document.getElementById("btn-cancel-vpn-certificate-modal");
const btnAcceptVpnCertificateModal = document.getElementById("btn-accept-vpn-certificate-modal");

// Quick Connect Form
const quickConnectForm = document.getElementById("quick-connect-form");
const quickConnectModal = document.getElementById("quick-connect-modal");
const btnCloseQuickConnectModal = document.getElementById("btn-close-quick-connect-modal");
const btnCancelQuickConnectModal = document.getElementById("btn-cancel-quick-connect-modal");
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

function initNotification() {
  notificationElement = document.createElement("div");
  notificationElement.className = "app-notification";
  notificationElement.setAttribute("role", "status");
  notificationElement.setAttribute("aria-live", "polite");
  document.body.appendChild(notificationElement);
}

function showNotification(message) {
  notificationElement.textContent = message;
  notificationElement.classList.add("visible");
  window.clearTimeout(notificationTimeoutId);
  notificationTimeoutId = window.setTimeout(() => {
    notificationElement.classList.remove("visible");
  }, NOTIFICATION_DURATION_MS);
}

function copyTerminalSelection(term) {
  const selection = term.getSelection();
  if (!selection) return false;

  navigator.clipboard.writeText(selection).catch(error => {
    console.error("Failed to copy terminal selection:", error);
  });
  return true;
}

function pasteTerminalClipboard(session) {
  navigator.clipboard.readText().then(text => {
    if (text && !session.isClosed) session.term.paste(text);
  }).catch(error => {
    console.error("Failed to paste terminal clipboard:", error);
  });
}

function markSessionTabAsDisconnected(sessionId) {
  document.querySelector(`.terminal-tab[data-id="${sessionId}"]`)?.classList.add("connection-terminated");
}

function getSavedSftpExplorerStates() {
  const saved = localStorage.getItem(SFTP_EXPLORER_STATE_STORAGE_KEY);
  if (!saved) return {};

  try {
    const states = JSON.parse(saved);
    return states && typeof states === "object" && !Array.isArray(states) ? states : {};
  } catch (error) {
    console.error("Failed to parse saved SFTP explorer state:", error);
    return {};
  }
}

function getSavedSftpExplorerState(profileId) {
  const savedState = getSavedSftpExplorerStates()[profileId];
  if (!savedState || typeof savedState !== "object") return null;

  return {
    currentPath: typeof savedState.currentPath === "string" && savedState.currentPath
      ? savedState.currentPath
      : null,
    sftpPanelOpen: savedState.sftpPanelOpen !== false
  };
}

function saveSftpExplorerState(session) {
  if (!session.sftpStateKey || !session.currentPath) return;

  const savedStates = getSavedSftpExplorerStates();
  savedStates[session.sftpStateKey] = {
    currentPath: session.currentPath,
    sftpPanelOpen: session.sftpPanelOpen
  };
  localStorage.setItem(SFTP_EXPLORER_STATE_STORAGE_KEY, JSON.stringify(savedStates));
}

// Initialize Application
window.addEventListener("DOMContentLoaded", () => {
  initNotification();
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
  initSessionShortcuts();
  initPortKiller();
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

  // Re-focus the active terminal when the window gains focus so that
  // external apps sending keystrokes (e.g. password managers, macros)
  // reach the xterm.js terminal rather than being swallowed by WebView2.
  appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused && activeTabId) {
      const session = activeSessions[activeTabId];
      if (session && session.term && !session.isClosed) {
        session.term.focus();
      }
    }
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
  const namespaceTree = createNamespaceTree(savedProfiles);
  appendNamespaceFolders(namespaceTree, profilesList);

  namespaceTree.profiles.forEach(profile => {
    profilesList.appendChild(createProfileItemElement(profile));
  });

  hookProfileActions();
}

function createNamespaceTree(profiles) {
  const root = { profiles: [], children: new Map() };

  profiles.forEach(profile => {
    const namespaceSegments = profile.namespace
      ? profile.namespace.split(NAMESPACE_SEPARATOR).map(segment => segment.trim()).filter(Boolean)
      : [];
    let node = root;

    namespaceSegments.forEach(segment => {
      if (!node.children.has(segment)) {
        node.children.set(segment, { profiles: [], children: new Map() });
      }
      node = node.children.get(segment);
    });

    node.profiles.push(profile);
  });

  return root;
}

function getNamespaceProfileCount(namespaceNode) {
  return namespaceNode.profiles.length + [...namespaceNode.children.values()]
    .reduce((count, childNode) => count + getNamespaceProfileCount(childNode), 0);
}

function appendNamespaceFolders(namespaceNode, parentElement, namespacePath = []) {
  [...namespaceNode.children.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .forEach(([namespaceName, childNode]) => {
      const childPath = [...namespacePath, namespaceName];
      const namespaceKey = childPath.join(NAMESPACE_SEPARATOR);
      const folderEl = document.createElement("div");
      folderEl.className = "profile-folder";

      if (localStorage.getItem(`folder_collapsed_${namespaceKey}`) === "true") {
        folderEl.classList.add("collapsed");
      }

      folderEl.innerHTML = `
        <div class="folder-header">
          <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span class="folder-name">${escapeHtml(namespaceName)}</span>
          <span class="folder-count">(${getNamespaceProfileCount(childNode)})</span>
          <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="folder-content"></div>
      `;

      const contentElement = folderEl.querySelector(".folder-content");
      childNode.profiles.forEach(profile => {
        contentElement.appendChild(createProfileItemElement(profile));
      });
      appendNamespaceFolders(childNode, contentElement, childPath);

      folderEl.querySelector(".folder-header").addEventListener("click", () => {
        const isCollapsed = folderEl.classList.toggle("collapsed");
        localStorage.setItem(`folder_collapsed_${namespaceKey}`, isCollapsed);
      });

      parentElement.appendChild(folderEl);
    });
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
  btnCloseVpnCertificateModal.addEventListener("click", cancelVpnCertificatePrompt);
  btnCancelVpnCertificateModal.addEventListener("click", cancelVpnCertificatePrompt);
  btnAcceptVpnCertificateModal.addEventListener("click", confirmVpnCertificatePrompt);

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
    setVpnConnectionState(parseVpnConnectionStatus(result.output));
    setVpnStatus(result.output || (result.success ? "VPN command completed." : "VPN status unavailable."));
  } catch (e) {
    setVpnConnectionState({ state: "unknown", server: null, clientAddress: null });
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

    setVpnStatus(result.success ? "VPN disconnected." : (result.output || "Disconnect command did not report success."));
    await refreshVpnStatus(false);
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

  await runVpnSwitch(connectProfile, false);
}

async function runVpnSwitch(profile, allowInvalidCertificate) {
  setVpnControlsBusy(true, true);
  vpnOperationCancelRequested = false;
  setVpnStatus("Switching to " + profile.name + "...");

  try {
    const result = await invoke("switch_vpn_profile", {
      profile,
      allowInvalidCertificate
    });
    if (vpnOperationCancelRequested) {
      setVpnStatus("VPN request canceled.");
      return;
    }

    if (result.requiresCertificateConfirmation) {
      await refreshVpnStatus(false);
      setVpnStatus("Cisco requires certificate confirmation before connecting.");
      showVpnCertificatePrompt(profile);
      return;
    }

    setVpnStatus(result.success
      ? "Connected to " + profile.name + ". Use Disconnect Current VPN to end the tunnel."
      : (result.output || "VPN switch did not report success."));
    await refreshVpnStatus(false);
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

function showVpnCertificatePrompt(profile) {
  pendingVpnCertificateProfile = profile;
  vpnCertificateServer.textContent = profile.server;
  vpnCertificateModal.classList.remove("hidden");
  btnAcceptVpnCertificateModal.focus();
}

function cancelVpnCertificatePrompt() {
  pendingVpnCertificateProfile = null;
  vpnCertificateServer.textContent = "";
  vpnCertificateModal.classList.add("hidden");
}

async function confirmVpnCertificatePrompt() {
  const profile = pendingVpnCertificateProfile;
  cancelVpnCertificatePrompt();

  if (profile) {
    await runVpnSwitch(profile, true);
  }
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

function parseVpnConnectionStatus(output) {
  const connectionState = output.match(/^\s*Connection State:\s*(.+?)\s*$/im)?.[1]?.toLowerCase();
  const server = output.match(/^\s*Server Address:\s*(.+?)\s*$/im)?.[1];
  const clientAddress = output.match(/^\s*Client Address \(IPv4\):\s*(.+?)\s*$/im)?.[1];

  return {
    state: connectionState === "connected" || connectionState === "disconnected"
      ? connectionState
      : "unknown",
    server: normalizeVpnStatusValue(server),
    clientAddress: normalizeVpnStatusValue(clientAddress)
  };
}

function normalizeVpnStatusValue(value) {
  if (!value || /^not available$/i.test(value)) {
    return null;
  }

  return value;
}

function setVpnConnectionState({ state, server, clientAddress }) {
  vpnConnectionActive = state === "connected";
  vpnConnectionState.className = "vpn-connection-state is-" + state;

  if (state === "connected") {
    const details = [server, clientAddress ? "Client " + clientAddress : null]
      .filter(Boolean)
      .join(" · ");
    vpnConnectionSummary.textContent = details ? "VPN connected · " + details : "VPN connected.";
  } else if (state === "disconnected") {
    vpnConnectionSummary.textContent = "VPN disconnected.";
  } else {
    vpnConnectionSummary.textContent = "VPN status unavailable.";
  }

  btnDisconnectVpn.disabled = vpnControlsBusy || !vpnConnectionActive;
}

function setVpnControlsBusy(isBusy, canCancel = false) {
  vpnControlsBusy = isBusy;
  [
    btnAddVpnProfile,
    btnRefreshVpnStatus,
    btnScanCiscoVpnProfiles
  ].forEach(button => {
    button.disabled = isBusy;
  });
  btnDisconnectVpn.disabled = isBusy || !vpnConnectionActive;

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

function showQuickConnectModal() {
  if (quickConnectModal.classList.contains("hidden") && document.activeElement instanceof HTMLElement) {
    quickConnectModalTrigger = document.activeElement;
  }

  quickConnectForm.reset();
  document.getElementById("qc-port").value = appSettings.defaultPort;
  document.querySelector('input[name="qc-auth-mode"][value="key"]').checked = true;
  qcAuthKeyFields.classList.remove("hidden");
  qcAuthPasswordFields.classList.add("hidden");
  loadDefaultKeyForInput(qcKeypathInput);
  quickConnectModal.classList.remove("hidden");
  window.setTimeout(() => document.getElementById("qc-host").focus(), 0);
}

function hideQuickConnectModal() {
  quickConnectModal.classList.add("hidden");

  if (quickConnectModalTrigger?.isConnected) {
    quickConnectModalTrigger.focus();
  }

  quickConnectModalTrigger = null;
}

function duplicateActiveSession() {
  const activeSession = activeTabId ? activeSessions[activeTabId] : null;

  if (!activeSession?.connectionProfile || activeSession.isClosed) {
    showQuickConnectModal();
    return;
  }

  connectProfile({ ...activeSession.connectionProfile });
}

function initSessionShortcuts() {
  window.addEventListener("keydown", async (event) => {
    const isTerminalSearchShortcut = (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.code === "KeyF"
      && !event.repeat;
    const isNewSessionShortcut = (event.ctrlKey || event.metaKey)
      && !event.shiftKey
      && event.code === "KeyN"
      && !event.repeat;
    const isCloseSessionShortcut = (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.code === "KeyW"
      && !event.repeat;

    if (isTerminalSearchShortcut) {
      const activeSession = activeTabId ? activeSessions[activeTabId] : null;
      if (!activeSession?.term || activeSession.search?.isDisposed) return;

      event.preventDefault();
      event.stopPropagation();
      openTerminalSearch(activeSession);
      return;
    }

    if (isCloseSessionShortcut) {
      const sessionId = activeTabId;
      const activeSession = sessionId ? activeSessions[sessionId] : null;
      if (!activeSession) return;

      event.preventDefault();
      event.stopPropagation();
      await closeTab(sessionId);
      showNotification(`${activeSession.name} closed.`);
      return;
    }

    if (!isNewSessionShortcut) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.altKey) {
      showQuickConnectModal();
      return;
    }

    duplicateActiveSession();
  }, { capture: true });
}

// --- WORKSPACE & TAB MANAGEMENT ---
function initWorkspace() {
  btnNewTabPlus.addEventListener("click", () => {
    showQuickConnectModal();
  });

  welcomeBtnNew.addEventListener("click", () => {
    showQuickConnectModal();
  });

  welcomeBtnAdd.addEventListener("click", () => {
    showProfileModal();
  });

  btnCloseQuickConnectModal.addEventListener("click", hideQuickConnectModal);
  btnCancelQuickConnectModal.addEventListener("click", hideQuickConnectModal);
  quickConnectModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideQuickConnectModal();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = quickConnectModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) return;

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
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

    hideQuickConnectModal();
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
    scheduleTerminalSearchRefresh(session);
  } catch (e) {
    console.error("Fit error:", e);
  }
}

function initTerminalSearch(session) {
  const searchForm = session.container.querySelector(".terminal-search");
  const searchInput = searchForm.querySelector(".terminal-search-input");
  const previousButton = searchForm.querySelector(".terminal-search-previous");
  const nextButton = searchForm.querySelector(".terminal-search-next");
  const closeButton = searchForm.querySelector(".terminal-search-close");

  session.search.form = searchForm;
  session.search.input = searchInput;
  session.search.count = searchForm.querySelector(".terminal-search-count");
  session.search.previousButton = previousButton;
  session.search.nextButton = nextButton;

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    moveTerminalSearchMatch(session, 1);
  });

  searchInput.addEventListener("input", () => {
    updateTerminalSearch(session, searchInput.value, { revealActiveMatch: true });
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeTerminalSearch(session);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      moveTerminalSearchMatch(session, event.shiftKey ? -1 : 1);
    }
  });

  previousButton.addEventListener("click", () => moveTerminalSearchMatch(session, -1));
  nextButton.addEventListener("click", () => moveTerminalSearchMatch(session, 1));
  closeButton.addEventListener("click", () => closeTerminalSearch(session));
}

function openTerminalSearch(session) {
  const { form, input } = session.search;
  form.classList.remove("hidden");
  updateTerminalSearch(session, input.value, { revealActiveMatch: false });
  input.focus();
  input.select();
}

function closeTerminalSearch(session) {
  session.search.form.classList.add("hidden");
  clearTerminalSearchHighlights(session);
  session.search.matches = [];
  session.search.activeMatchIndex = -1;
  updateTerminalSearchControls(session);
  session.term.focus();
}

function updateTerminalSearch(session, query, { revealActiveMatch = false } = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const previousActiveLine = session.search.matches[session.search.activeMatchIndex];

  clearTerminalSearchHighlights(session);
  session.search.query = normalizedQuery;
  session.search.matches = getTerminalSearchMatches(session.term, normalizedQuery);
  session.search.activeMatchIndex = session.search.matches.indexOf(previousActiveLine);

  if (session.search.activeMatchIndex === -1 && session.search.matches.length > 0) {
    session.search.activeMatchIndex = 0;
  }

  renderTerminalSearchHighlights(session);
  updateTerminalSearchControls(session);

  if (revealActiveMatch) revealTerminalSearchMatch(session);
}

function getTerminalSearchMatches(term, query) {
  if (!query) return [];

  const buffer = term.buffer.active;
  const matches = [];

  for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    const lineText = line?.translateToString(true).toLocaleLowerCase();

    if (lineText?.includes(query)) matches.push(lineIndex);
  }

  return matches;
}

function renderTerminalSearchHighlights(session) {
  const { term, search } = session;
  const buffer = term.buffer.active;

  if (!search.query || buffer.type !== "normal") return;

  const cursorLine = buffer.baseY + buffer.cursorY;

  search.matches.forEach((lineIndex, matchIndex) => {
    const marker = term.registerMarker(lineIndex - cursorLine);
    if (!marker) return;

    const isActiveMatch = matchIndex === search.activeMatchIndex;
    const decoration = term.registerDecoration({
      marker,
      x: 0,
      width: term.cols,
      backgroundColor: isActiveMatch ? TERMINAL_SEARCH_ACTIVE_MATCH_COLOR : TERMINAL_SEARCH_MATCH_COLOR,
      layer: "bottom",
      overviewRulerOptions: {
        color: isActiveMatch ? TERMINAL_SEARCH_ACTIVE_MATCH_RULER_COLOR : TERMINAL_SEARCH_MATCH_RULER_COLOR,
        position: "right"
      }
    });

    if (decoration) search.decorations.push(decoration);
  });
}

function clearTerminalSearchHighlights(session) {
  session.search.decorations.forEach(decoration => decoration.dispose());
  session.search.decorations = [];
}

function moveTerminalSearchMatch(session, direction) {
  const { matches } = session.search;
  if (matches.length === 0) return;

  const nextMatchIndex = (session.search.activeMatchIndex + direction + matches.length) % matches.length;
  session.search.activeMatchIndex = nextMatchIndex;
  clearTerminalSearchHighlights(session);
  renderTerminalSearchHighlights(session);
  updateTerminalSearchControls(session);
  revealTerminalSearchMatch(session);
}

function revealTerminalSearchMatch(session) {
  const activeLine = session.search.matches[session.search.activeMatchIndex];
  if (activeLine !== undefined) session.term.scrollToLine(activeLine);
}

function updateTerminalSearchControls(session) {
  const { query, matches, activeMatchIndex, count, previousButton, nextButton } = session.search;
  const hasMatches = matches.length > 0;

  count.textContent = query ? (hasMatches ? `${activeMatchIndex + 1} of ${matches.length}` : "No matches") : "Type to search";
  previousButton.disabled = !hasMatches;
  nextButton.disabled = !hasMatches;
}

function scheduleTerminalSearchRefresh(session) {
  if (session.search?.isDisposed || !session.search?.query || session.search.form.classList.contains("hidden")) return;

  window.clearTimeout(session.search.refreshTimeoutId);
  session.search.refreshTimeoutId = window.setTimeout(() => {
    updateTerminalSearch(session, session.search.input.value);
  }, TERMINAL_SEARCH_REFRESH_DELAY_MS);
}

function disposeTerminalSearch(session) {
  if (!session.search) return;

  session.search.isDisposed = true;
  window.clearTimeout(session.search.refreshTimeoutId);
  clearTerminalSearchHighlights(session);
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
    disposeTerminalSearch(session);
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
  const savedSftpState = getSavedSftpExplorerState(profile.id);

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
    <div class="terminal-viewport">
      <div class="terminal-connection-loading" role="status" aria-live="polite">
        <span class="terminal-connection-spinner" aria-hidden="true"></span>
        <span>Connecting to ${escapeHtml(profile.name)}...</span>
      </div>
      <form class="terminal-search hidden" role="search" aria-label="Search terminal output">
        <label class="sr-only" for="terminal-search-${sessionId}">Search terminal output</label>
        <input class="terminal-search-input" id="terminal-search-${sessionId}" type="search" placeholder="Find in terminal" autocomplete="off" spellcheck="false" />
        <output class="terminal-search-count" aria-live="polite">Type to search</output>
        <button class="terminal-search-button terminal-search-previous" type="button" aria-label="Previous result" title="Previous result" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <button class="terminal-search-button terminal-search-next" type="button" aria-label="Next result" title="Next result" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <button class="terminal-search-button terminal-search-close" type="button" aria-label="Close terminal search" title="Close search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg>
        </button>
      </form>
    </div>
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
    connectionProfile: { ...profile },
    container: sessionContainer,
    isClosed: false,
    currentPath: savedSftpState?.currentPath ?? null,
    sftpPanelOpen: savedSftpState?.sftpPanelOpen ?? true,
    sftpStateKey: profile.id,
    sftpRequestId: 0,
    terminalInput: "",
    canTrackTerminalInput: true,
    search: {
      activeMatchIndex: -1,
      decorations: [],
      isDisposed: false,
      matches: [],
      query: "",
      refreshTimeoutId: null
    }
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

    if (!activeSessions[sessionId]) {
      try {
        await invoke("disconnect_ssh", { sessionId });
      } catch (error) {
        console.error("Failed to close an abandoned SSH connection:", error);
      }
      return;
    }

    // Update tab title
    tabEl.querySelector(".tab-title").textContent = profile.name;

    // Create Xterm terminal
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: "Fira Code, monospace",
      fontSize: appSettings.fontSize,
      scrollback: 5000,
      overviewRuler: { width: TERMINAL_SCROLLBAR_WIDTH },
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
        brightWhite: "#e6e6e6",
        scrollbarSliderBackground: "rgba(148, 163, 184, 0.32)",
        scrollbarSliderHoverBackground: "rgba(148, 163, 184, 0.52)",
        scrollbarSliderActiveBackground: "rgba(226, 232, 240, 0.64)"
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    sessionContainer.querySelector(".terminal-connection-loading")?.remove();
    term.open(sessionContainer.querySelector(".terminal-viewport"));
    fitAddon.fit();

    // Store objects in state
    activeSessions[sessionId].term = term;
    activeSessions[sessionId].fitAddon = fitAddon;
    initTerminalSearch(activeSessions[sessionId]);

    term.parser.registerOscHandler(7, (uri) => {
      const terminalDirectory = getTerminalDirectoryFromUri(uri);
      if (terminalDirectory) {
        loadSftpDirectory(activeSessions[sessionId], terminalDirectory);
      }
      return true;
    });

    // Initialize SFTP panel for session
    initSftpForSession(activeSessions[sessionId]);

    // xterm handles native paste events; manually pasting on Ctrl+V duplicates that input in WebView2.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      if (e.ctrlKey && e.code === 'KeyC' && copyTerminalSelection(term)) {
        return false;
      }

      return true;
    });

    term.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();

      if (copyTerminalSelection(term)) return;

      term.focus();
      pasteTerminalClipboard(activeSessions[sessionId]);
    });

    // Hook inputs
    term.onData((data) => {
      if (activeSessions[sessionId].isClosed) return;
      const b64 = stringToBase64(data);
      invoke("write_ssh", { sessionId, dataBase64: b64 }).catch(err => {
        console.error("Write error:", err);
      });
      trackTerminalDirectoryChange(activeSessions[sessionId], data);
    });

    // Fit & Resize initial size
    fitTerminal(activeSessions[sessionId]);
    term.focus();

  } catch (err) {
    if (!activeSessions[sessionId]) return;

    // If it fails, print error or clean up
    console.error("SSH Connect failed:", err);
    tabEl.querySelector(".tab-title").textContent = "Failed";
    markSessionTabAsDisconnected(sessionId);
    
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
      session.term.write(bytes, () => scheduleTerminalSearchRefresh(session));
    }
  });

  // Listen for connection close
  listen("ssh-closed", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (session) {
      session.isClosed = true;
      markSessionTabAsDisconnected(payload.session_id);
      if (session.term) {
        session.term.write("\r\n\x1b[31m[Connection closed by remote host]\x1b[0m\r\n", () => scheduleTerminalSearchRefresh(session));
      }
    }
  });

  // Listen for connection errors
  listen("ssh-error", (event) => {
    const payload = event.payload;
    const session = activeSessions[payload.session_id];
    if (session) {
      session.isClosed = true;
      markSessionTabAsDisconnected(payload.session_id);
      if (session.term) {
        session.term.write(`\r\n\x1b[31m[SSH Connection Error: ${escapeHtml(payload.data)}]\x1b[0m\r\n`, () => scheduleTerminalSearchRefresh(session));
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

  applySftpPanelVisibility(session);

  toggleBtn.addEventListener("click", () => {
    session.sftpPanelOpen = !session.sftpPanelOpen;
    applySftpPanelVisibility(session);
    saveSftpExplorerState(session);
    setTimeout(() => fitTerminal(session), SFTP_PANEL_TRANSITION_MS);
  });

  btnUp.addEventListener("click", () => {
    let parts = (session.currentPath || ROOT_REMOTE_DIRECTORY).split("/").filter(Boolean);
    parts.pop();
    let parentPath = ROOT_REMOTE_DIRECTORY + parts.join("/");
    loadSftpDirectory(session, parentPath, { syncTerminal: true });
  });

  btnRefresh.addEventListener("click", () => {
    loadSftpDirectory(session, session.currentPath || REMOTE_HOME_DIRECTORY);
  });

  // Create directory
  btnNewFolder.addEventListener("click", async () => {
    const folderName = prompt("Enter new folder name:");
    if (!folderName || !folderName.trim()) return;
    if (!session.currentPath) return;
    
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
      if (!session.currentPath) return;
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

  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      loadSftpDirectory(session, pathInput.value.trim(), { syncTerminal: true });
    }
  });

  const initialPath = session.currentPath || REMOTE_HOME_DIRECTORY;
  loadSftpDirectory(session, initialPath, { syncTerminal: Boolean(session.currentPath) });
}

function applySftpPanelVisibility(session) {
  session.container.classList.toggle("sftp-collapsed", !session.sftpPanelOpen);
}

function getTerminalDirectoryFromUri(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
  } catch (error) {
    console.warn("Ignoring invalid terminal working-directory URI:", error);
    return null;
  }
}

function quoteRemoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function synchronizeTerminalDirectory(session, path) {
  if (!session.term || session.isClosed || session.terminalInput) return;

  const command = `cd ${quoteRemoteShellArgument(path)}\r`;
  invoke("write_ssh", { sessionId: session.id, dataBase64: stringToBase64(command) }).catch(error => {
    console.error("Failed to synchronize terminal directory:", error);
  });
}

function getTerminalCdPath(session, command) {
  const match = command.match(/^\s*cd(?:\s+(.+?))?\s*$/);
  if (!match || !session.currentPath) return null;

  const rawPath = match[1] ?? "~";
  const quotedPath = rawPath.match(/^'((?:[^']|'\\'')*)'$/) || rawPath.match(/^"([^"$`\\]*)"$/);
  const path = quotedPath ? quotedPath[1].replaceAll("'\\''", "'") : rawPath;
  if (!quotedPath && /[\s;&|<>`$\\]/.test(path)) return null;

  if (path === "~") return REMOTE_HOME_DIRECTORY;
  if (path === "-") return null;
  if (path.startsWith("~/")) return `.${path.slice(1)}`;
  if (path.startsWith(ROOT_REMOTE_DIRECTORY)) return path;
  return `${session.currentPath}/${path}`;
}

function trackTerminalDirectoryChange(session, data) {
  for (const character of data) {
    if (character === "\r") {
      const terminalPath = session.canTrackTerminalInput
        ? getTerminalCdPath(session, session.terminalInput)
        : null;
      session.terminalInput = "";
      session.canTrackTerminalInput = true;
      if (terminalPath) {
        setTimeout(() => loadSftpDirectory(session, terminalPath), TERMINAL_DIRECTORY_SYNC_DELAY_MS);
      }
    } else if (character === "\x03" || character === "\x15") {
      session.terminalInput = "";
      session.canTrackTerminalInput = true;
    } else if (character === "\x7f") {
      session.terminalInput = session.terminalInput.slice(0, -1);
    } else if (character >= " ") {
      session.terminalInput += character;
    } else {
      session.canTrackTerminalInput = false;
    }
  }
}

async function loadSftpDirectory(session, path, { syncTerminal = false } = {}) {
  const container = session.container;
  const fileListEl = container.querySelector(".sftp-files-list");
  const pathInput = container.querySelector(".sftp-path-input");

  if (!fileListEl) return;

  const requestId = ++session.sftpRequestId;

  fileListEl.innerHTML = `<div class="sftp-status">Loading files...</div>`;

  if (!path || path.trim() === "") {
    path = REMOTE_HOME_DIRECTORY;
  }

  try {
    const resolvedPath = await invoke("sftp_resolve_path", { sessionId: session.id, path });
    const files = await invoke("sftp_list_directory", { sessionId: session.id, path: resolvedPath });
    if (session.isClosed || requestId !== session.sftpRequestId) return;
    
    session.currentPath = resolvedPath;
    if (pathInput) pathInput.value = resolvedPath;
    saveSftpExplorerState(session);
    if (syncTerminal) synchronizeTerminalDirectory(session, resolvedPath);

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

      item.addEventListener("dblclick", () => {
        if (file.is_dir) {
          loadSftpDirectory(session, file.path, { syncTerminal: true });
        } else {
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
    if (session.isClosed || requestId !== session.sftpRequestId) return;
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

// --- PORT KILLER ---
let allPorts = [];

function initPortKiller() {
  document.getElementById("titlebar-port-killer").addEventListener("click", openPortKillerTab);
}

function openPortKillerTab() {
  const tabId = "port-killer";

  const existing = document.querySelector(`.terminal-tab[data-id="${tabId}"]`);
  if (existing) {
    switchTab(tabId);
    return;
  }

  welcomeScreen.classList.add("hidden");

  const tabEl = document.createElement("div");
  tabEl.className = "terminal-tab active";
  tabEl.dataset.id = tabId;
  tabEl.innerHTML = `
    <span class="tab-title" style="display:flex;align-items:center;gap:6px;">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="22" y1="12" x2="18" y2="12"></line>
        <line x1="6" y1="12" x2="2" y2="12"></line>
        <line x1="12" y1="6" x2="12" y2="2"></line>
        <line x1="12" y1="22" x2="12" y2="18"></line>
      </svg>
      Port Killer
    </span>
    <button class="btn-tab-close">&times;</button>
  `;
  tabsContainer.appendChild(tabEl);

  tabEl.querySelector(".btn-tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tabId);
  });
  tabEl.addEventListener("click", () => switchTab(tabId));

  const container = document.createElement("div");
  container.className = "session-container active";
  container.dataset.id = tabId;
  container.innerHTML = `
    <div class="port-killer-viewport">
      <div class="port-killer-card">
        <div class="port-killer-header">
          <div class="port-killer-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="22" y1="12" x2="18" y2="12"></line>
              <line x1="6" y1="12" x2="2" y2="12"></line>
              <line x1="12" y1="6" x2="12" y2="2"></line>
              <line x1="12" y1="22" x2="12" y2="18"></line>
            </svg>
            Port Killer
          </div>
          <div class="port-killer-controls">
            <input type="text" id="port-filter" placeholder="Filter by port or process..." />
            <button class="btn btn-secondary btn-small" id="btn-refresh-ports">Refresh</button>
          </div>
        </div>
        <div id="port-killer-count" class="port-killer-count"></div>
        <div id="ports-list" class="ports-table"></div>
      </div>
    </div>
  `;
  workspaceViewport.appendChild(container);

  container.querySelector("#btn-refresh-ports").addEventListener("click", loadPorts);
  container.querySelector("#port-filter").addEventListener("input", renderPorts);

  activeSessions[tabId] = { id: tabId, name: "Port Killer", container, isClosed: false };

  switchTab(tabId);
  loadPorts();
}

async function loadPorts() {
  const listEl = document.getElementById("ports-list");
  const countEl = document.getElementById("port-killer-count");
  if (!listEl) return;

  listEl.innerHTML = `<div class="empty-state">Scanning ports...</div>`;
  if (countEl) countEl.textContent = "";

  try {
    allPorts = await invoke("list_listening_ports");
    renderPorts();
  } catch (e) {
    listEl.innerHTML = `<div class="empty-state">Error: ${escapeHtml(String(e))}</div>`;
  }
}

function renderPorts() {
  const listEl = document.getElementById("ports-list");
  const countEl = document.getElementById("port-killer-count");
  if (!listEl) return;

  const filter = (document.getElementById("port-filter")?.value ?? "").trim().toLowerCase();

  const filtered = allPorts.filter(p => {
    if (!filter) return true;
    return String(p.local_port).includes(filter) ||
           p.process_name.toLowerCase().includes(filter) ||
           p.state.toLowerCase().includes(filter);
  });

  if (countEl) {
    countEl.textContent = `${filtered.length} port${filtered.length !== 1 ? "s" : ""} found${filter ? " (filtered)" : ""}`;
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">${filter ? "No matching ports." : "No ports found."}</div>`;
    return;
  }

  listEl.innerHTML = "";
  filtered.forEach(entry => {
    const row = document.createElement("div");
    row.className = "port-row";

    const stateClass = entry.state.toLowerCase() === "listening" ? " listening" : "";

    row.innerHTML = `
      <span class="port-badge ${entry.protocol.toLowerCase()}">${escapeHtml(entry.protocol)}</span>
      <span class="port-number">:${entry.local_port}</span>
      <span class="port-state${stateClass}">${escapeHtml(entry.state) || "—"}</span>
      <span class="port-process" title="${escapeHtml(entry.process_name)}">${escapeHtml(entry.process_name)}</span>
      <span class="port-pid">PID ${entry.pid}</span>
      <button class="btn-kill">Kill</button>
    `;

    row.querySelector(".btn-kill").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!confirm(`Kill "${entry.process_name}" (PID ${entry.pid}) on port ${entry.local_port}?`)) return;

      btn.disabled = true;
      btn.textContent = "Killing...";

      try {
        await invoke("kill_port_process", { pid: entry.pid });
        await loadPorts();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Kill";
        const errEl = document.createElement("div");
        errEl.className = "port-kill-error";
        errEl.textContent = String(err);
        row.appendChild(errEl);
        setTimeout(() => errEl.remove(), 5000);
      }
    });

    listEl.appendChild(row);
  });
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
