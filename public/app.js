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
    await navigator.clipboard.writeText(text);
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
