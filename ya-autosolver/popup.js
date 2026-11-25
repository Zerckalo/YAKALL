chrome.storage.local.get(
  {
    enabled: false,
    autoSubmit: false,
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemini-2.0-flash-exp:free",
    apiKey: ""
  },
  (cfg) => {
    document.getElementById("enabled").checked = cfg.enabled;
    document.getElementById("autoSubmit").checked = cfg.autoSubmit;
    document.getElementById("apiUrl").value = cfg.apiUrl;
    document.getElementById("model").value = cfg.model;
    document.getElementById("apiKey").value = cfg.apiKey;
  }
);

document.getElementById("save").addEventListener("click", () => {
  const data = {
    enabled: document.getElementById("enabled").checked,
    autoSubmit: document.getElementById("autoSubmit").checked,
    apiUrl: document.getElementById("apiUrl").value.trim(),
    model: document.getElementById("model").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim()
  };
  chrome.storage.local.set(data, () => {
    document.getElementById("status").textContent = "Сохранено.";
  });
});