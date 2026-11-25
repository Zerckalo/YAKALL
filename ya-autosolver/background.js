chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SOLVE_TEXT_TASK") {
    solveTextTask(msg.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "SOLVE_DRAG_TASK") {
    solveDragTask(msg.payload, sender.tab?.windowId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

async function getConfig() {
  const cfg = await chrome.storage.local.get({
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: "",
    model: "google/gemini-2.0-flash-exp:free"
  });
  if (!cfg.apiKey) {
    throw new Error("Не задан API key в popup-меню расширения.");
  }
  return cfg;
}

function parseJsonResponse(content) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

async function callLLM(cfg, messages) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages
      })
    });

    if (res.ok) {
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Пустой ответ от модели.");
      return parseJsonResponse(content);
    }

    const body = await res.text();
    if ((res.status === 503 || res.status === 429) && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, attempt * 2500));
      continue;
    }

    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function solveTextTask({ taskText, inputDescriptions }) {
  const cfg = await getConfig();
  const parsed = await callLLM(cfg, [
    {
      role: "system",
      content:
        'Ты решаешь задания Яндекс Учебника. Верни СТРОГО JSON без пояснений: {"answers": ["ответ_1", ...]}. ' +
        "Длина массива answers должна совпадать с числом полей ввода."
    },
    {
      role: "user",
      content: `Условие:\n${taskText}\n\nПоля:\n${JSON.stringify(inputDescriptions, null, 2)}`
    }
  ]);

  if (!Array.isArray(parsed.answers)) {
    throw new Error("В ответе нет массива answers.");
  }
  return parsed;
}

async function solveDragTask({ taskText, fieldsCount, choicesCount }, windowId) {
  const cfg = await getConfig();
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: 85
  });

  const parsed = await callLLM(cfg, [
    {
      role: "system",
      content:
        "Ты решаешь визуальное задание на перетаскивание плиток (Яндекс Учебник). " +
        "На скриншоте красными метками F0, F1, ... отмечены слоты (куда класть), " +
        "а синими метками C0, C1, ... отмечены плитки (что перетаскивать). " +
        "Одну и ту же плитку можно перетаскивать в несколько слотов, если по условию цифры/блоки повторяются. " +
        'Верни СТРОГО валидный JSON без markdown и пояснений: {"moves": [{"choice": 0, "field": 0}, ...]}.'
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Условие:\n${taskText}\n\nВсего слотов F: ${fieldsCount} (0..${fieldsCount - 1}), плиток C: ${choicesCount} (0..${choicesCount - 1}). Укажи, какую плитку C в какой слот F положить.`
        },
        {
          type: "image_url",
          image_url: { url: screenshotDataUrl }
        }
      ]
    }
  ]);

  if (!Array.isArray(parsed.moves)) {
    throw new Error("В ответе нет массива moves.");
  }
  return parsed;
}