const DEFAULTS = {
  enabled: false,
  autoSubmit: false,
  autoNext: false,
  apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  model: "gemini-3.5-flash-lite",
  apiKey: ""
};

function setStatus(text, isError = false) {
  const el = document.getElementById("status");
  el.style.color = isError ? "#c62828" : "#2e7d32";
  el.textContent = text;
}

chrome.storage.local.get(DEFAULTS, (cfg) => {
  document.getElementById("enabled").checked = cfg.enabled;
  document.getElementById("autoSubmit").checked = cfg.autoSubmit;
  document.getElementById("autoNext").checked = cfg.autoNext;
  document.getElementById("apiUrl").value = cfg.apiUrl;
  document.getElementById("model").value = cfg.model;
  document.getElementById("apiKey").value = cfg.apiKey;
});

function saveSettings(callback) {
  const data = {
    enabled: document.getElementById("enabled").checked,
    autoSubmit: document.getElementById("autoSubmit").checked,
    autoNext: document.getElementById("autoNext").checked,
    apiUrl: document.getElementById("apiUrl").value.trim() || DEFAULTS.apiUrl,
    model: document.getElementById("model").value.trim() || DEFAULTS.model,
    apiKey: document.getElementById("apiKey").value.trim()
  };
  chrome.storage.local.set(data, () => {
    setStatus("Сохранено.");
    if (callback) callback();
  });
}

document.getElementById("save").addEventListener("click", () => {
  saveSettings();
});

document.getElementById("solveNow").addEventListener("click", () => {
  saveSettings(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus("Активная вкладка не найдена.", true);
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "SOLVE_NOW" }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus("Обнови страницу ЯУ (F5) и попробуй снова.", true);
        return;
      }
      setStatus(resp?.ok ? "Готово." : "Запущено.");
    });
  });
});