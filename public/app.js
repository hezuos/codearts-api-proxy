// CodeArts Agent Proxy - Shared JavaScript Utilities

/**
 * Mask an API key for display
 * @param {string} apiKey - The API key to mask
 * @returns {string} Masked API key (e.g., "sk-xxxx...xxxx")
 */
function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length <= 8) {
    return apiKey || "";
  }
  return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

/**
 * Toggle API key visibility
 * @param {HTMLElement} element - The element containing the API key
 * @param {string} fullKey - The full API key
 * @param {boolean} isMasked - Current masked state
 */
function toggleApiKeyVisibility(element, fullKey, isMasked) {
  if (isMasked) {
    element.textContent = fullKey;
    element.dataset.masked = "false";
  } else {
    element.textContent = maskApiKey(fullKey);
    element.dataset.masked = "true";
  }
}

/**
 * Copy text to clipboard with user feedback
 * @param {string} text - Text to copy
 * @param {HTMLElement} button - The button that triggered the copy
 */
async function copyToClipboard(text, button) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts (HTTP, non-localhost)
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    const originalText = button.textContent;
    button.textContent = "Copied!";
    button.disabled = true;
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 2000);
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    alert("Failed to copy to clipboard");
  }
}

/**
 * Fetch wrapper with error handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response data
 */
async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: "Unknown error" }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error("Fetch error:", error);
    throw error;
  }
}

/**
 * Show a confirmation dialog
 * @param {string} message - Confirmation message
 * @returns {boolean} User's choice
 */
function confirmAction(message) {
  return confirm(message);
}

/**
 * Show error message on page
 * @param {string} message - Error message
 * @param {HTMLElement} container - Container element (optional)
 */
function showError(message, container = null) {
  const errorDiv = document.createElement("div");
  errorDiv.className = "error-message";
  errorDiv.textContent = message;

  if (container) {
    container.insertBefore(errorDiv, container.firstChild);
  } else {
    const mainContainer = document.querySelector(".container");
    if (mainContainer) {
      mainContainer.insertBefore(errorDiv, mainContainer.firstChild);
    }
  }

  // Auto-remove after 5 seconds
  setTimeout(() => {
    errorDiv.remove();
  }, 5000);
}

/**
 * Show success message on page
 * @param {string} message - Success message
 * @param {HTMLElement} container - Container element (optional)
 */
function showSuccess(message, container = null) {
  const successDiv = document.createElement("div");
  successDiv.className = "success-message";
  successDiv.textContent = message;

  if (container) {
    container.insertBefore(successDiv, container.firstChild);
  } else {
    const mainContainer = document.querySelector(".container");
    if (mainContainer) {
      mainContainer.insertBefore(successDiv, mainContainer.firstChild);
    }
  }

  // Auto-remove after 3 seconds
  setTimeout(() => {
    successDiv.remove();
  }, 3000);
}

/**
 * Calculate account status based on expiration time
 * @param {string} expiresAt - ISO timestamp of expiration
 * @returns {Object} Status object with class and label
 */
function calculateAccountStatus(expiresAt) {
  if (!expiresAt) {
    return { class: "status-pending", label: "Pending" };
  }

  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const twoHours = 2 * 60 * 60 * 1000;

  if (now > expires) {
    return { class: "status-expired", label: "Expired" };
  }

  if (now > expires - twoHours) {
    return { class: "status-expiring", label: "Expiring Soon" };
  }

  return { class: "status-valid", label: "Valid" };
}

/**
 * Format timestamp for display
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted date string
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return "N/A";
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Format relative time
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Relative time string
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return "N/A";

  const now = Date.now();
  const time = new Date(timestamp).getTime();
  const diff = time - now;

  if (diff < 0) {
    return "Expired";
  }

  const hours = Math.floor(diff / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""}`;
  }

  if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""}`;
  }

  const minutes = Math.floor(diff / (60 * 1000));
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}

/**
 * Set loading state on an element
 * @param {HTMLElement} element - Element to set loading state on
 * @param {boolean} isLoading - Loading state
 * @param {string} originalText - Original button text
 */
function setLoading(element, isLoading, originalText = null) {
  if (isLoading) {
    element.disabled = true;
    element.dataset.originalText = element.textContent;
    element.textContent = "Loading...";
  } else {
    element.disabled = false;
    element.textContent =
      originalText || element.dataset.originalText || element.textContent;
  }
}

/**
 * Manages a single named popup window, ensuring all opens reuse the same
 * window instance. Prevents duplicate windows when multiple calls target
 * the same logical window (e.g. login popup + callback redirect).
 */
const LoginWindowManager = {
  _window: null,

  /**
   * Open or reuse the login popup window.
   * If the window already exists and is not closed, its location is updated
   * to the new URL. Otherwise a new window is opened.
   *
   * @param {string} url - URL to open
   * @param {string} [name="huawei-login"] - Window target name
   * @param {string} [features="width=900,height=720"] - Window features string
   * @returns {Window|null} The window reference, or null if blocked
   */
  open(url, name = "huawei-login", features = "width=900,height=720") {
    if (this._window && !this._window.closed) {
      this._window.location.href = url;
      this._window.focus();
      return this._window;
    }
    this._window = window.open(url, name, features);
    return this._window;
  },

  /**
   * Close the login popup window if it is still open.
   */
  close() {
    if (this._window && !this._window.closed) {
      this._window.close();
    }
    this._window = null;
  },

  /**
   * Check whether the login popup window is currently open.
   * @returns {boolean}
   */
  get isOpen() {
    return this._window != null && !this._window.closed;
  },
};

async function startHuaweiBrowserLogin(options = {}) {
  const {
    launchMode = "iframe",
    container = null,
    onStatusChange = null,
    onComplete = null,
    onError = null,
  } = options;

  const result = await fetchJson("/auth/huawei/browser/start", {
    method: "POST",
  });

  if (typeof onStatusChange === "function") {
    onStatusChange(result);
  }

  if (launchMode === "popup" || container) {
    const popup = LoginWindowManager.open(result.login_url);
    if (!popup) {
      throw new Error("Popup was blocked. Please allow popups and try again.");
    }
  } else {
    window.location.href = result.login_url;
    return result;
  }

  const timer = window.setInterval(async () => {
    try {
      const status = await fetchJson(`/auth/huawei/browser/status/${result.ticket_id}`);
      if (typeof onStatusChange === "function") {
        onStatusChange(status);
      }

      if (["completed", "failed", "expired"].includes(status.status)) {
        window.clearInterval(timer);
        LoginWindowManager.close();
        let finalizeResult = null;
        if (status.status === "completed") {
          finalizeResult = await fetchJson(`/auth/huawei/browser/finalize/${result.ticket_id}`, {
            method: "POST",
          });
        }
        if (typeof onComplete === "function") {
          onComplete(status, finalizeResult);
        }
      }
    } catch (error) {
      window.clearInterval(timer);
      LoginWindowManager.close();
      if (typeof onError === "function") {
        onError(error);
      }
    }
  }, 1000);

  return result;
}

/**
 * Paste a Huawei OAuth callback URL and open it with the host rewritten
 * to the current proxy origin. This allows completing authentication when the
 * automatic callback to 127.0.0.1 cannot reach the proxy (e.g. remote proxy).
 *
 * Uses window.open with the same target as the login popup ("huawei-login")
 * so the callback is processed in the login window, not the main page.
 *
 * @param {string} callbackUrl - The full callback URL from the browser address bar
 * @returns {{ success: boolean, error?: string }} Result object
 */
function pasteAndRedirectCallbackUrl(callbackUrl) {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { success: false, error: "Invalid URL format. Please paste the full callback URL from the browser address bar." };
  }

  if (!url.pathname.startsWith("/callback")) {
    return { success: false, error: "URL does not appear to be a callback URL. Expected path starting with /callback." };
  }

  if (!url.searchParams.has("identifier")) {
    return { success: false, error: "Callback URL is missing the 'identifier' parameter. Please copy the full URL from the browser address bar." };
  }

  // Rewrite the origin (schema + host + port) to the current proxy
  url.host = window.location.host;
  url.protocol = window.location.protocol;

  // Open in the login popup window — the existing /callback endpoint will handle the rest
  LoginWindowManager.open(url.toString());
  return { success: true };
}

/**
 * Fetch version from /health and display in all .version-badge placeholders.
 * Shows version, git commit hash, and build time.
 * Silently hides placeholders if fetch fails.
 */
async function loadAndShowVersion() {
  const badges = document.querySelectorAll(".version-badge");
  if (!badges.length) return;
  try {
    const res = await fetch("/health");
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (data.version) {
      const parts = ["v" + data.version];
      if (data.gitCommit && data.gitCommit !== "unknown") parts.push(data.gitCommit);
      if (data.buildTime) parts.push(data.buildTime);
      const text = parts.join(" · ");
      badges.forEach((b) => {
        b.textContent = text;
        b.title = "Version: " + data.version + (data.gitCommit ? "\nCommit: " + data.gitCommit : "") + (data.buildTime ? "\nBuilt: " + data.buildTime : "");
        b.style.display = "";
      });
    }
  } catch {
    badges.forEach((b) => (b.style.display = "none"));
  }
}
