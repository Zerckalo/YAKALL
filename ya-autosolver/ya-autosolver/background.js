const DEFAULT_CONFIG = {
  apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  model: "gemini-3.5-flash-lite",
  apiKey: ""
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SOLVE_UNIFIED_TASK") {
    solveUnifiedTask(msg.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "jpeg", quality: 85 })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

async function getConfig() {
  const cfg = await chrome.storage.local.get(DEFAULT_CONFIG);
  if (!cfg.apiKey) {
    throw new Error("Не задан API key в настройках расширения (popup).");
  }
  return cfg;
}

function parseJsonResponse(content) {
  let stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    stripped = stripped.slice(start, end + 1);
  }

  try {
    return JSON.parse(stripped);
  } catch {
    const repaired = stripped.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(repaired);
    } catch {
      throw new Error("Модель вернула невалидный JSON: " + stripped.slice(0, 300));
    }
  }
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

async function solveUnifiedTask({ promptText, images, previousWrongAnswers }) {
  const cfg = await getConfig();

  const systemPrompt = [
    "Ты решаешь школьные задания с платформы Яндекс Учебник с максимальной точностью.",
    "На одной странице может быть сразу несколько разных заданий и виджетов.",
    "Внимательно изучи текст, таблицы, степени, основания систем счисления и все приложенные изображения (IMG_*, DRAG_*, POLY_*).",
    "ПРАВИЛА ПО ТИПАМ ЗАДАНИЙ:",
    "- Для сложения и вычитания в двоичной/восьмеричной/шестнадцатеричной системах ОБЯЗАТЕЛЬНО переведи оба числа в десятичную систему, выполни действие в десятичной, переведи результат обратно и проверь обратным действием (разность + вычитаемое = уменьшаемое).",
    "- На изображениях DRAG_* красными рамками и метками F0, F1... отмечены слоты, куда класть плитки, а синими метками C0, C1... — плитки в лотке. Одну плитку можно перетаскивать в несколько слотов.",
    "- На изображениях POLY_* красными пунктирными прямоугольниками с подписями i1, i2... отмечены кликабельные области вершин/пинов. Если у блока две области (верхняя и нижняя), соединяй верхнюю с родителем, а нижнюю — с потомками.",
    "ЕСЛИ ЭТО ПОВТОРНАЯ ПОПЫТКА ПОСЛЕ ОШИБКИ:",
    "- Поля с пометкой [УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО] проверены системой и гарантированно правильные — опирайся на них как на верные промежуточные результаты и не меняй.",
    "- Поля с пометкой [БЫЛО ВВЕДЕНО: ... — ОШИБКА, ИСПРАВЬ] содержали неверный ответ — найди причину ошибки и исправь.",
    "ОБЯЗАТЕЛЬНЫЙ ПРОТОКОЛ ПРОВЕРКИ:",
    "1) В поле \"reasoning\" пошагово реши каждое задание (выпиши все вычисления и логику). НЕ ИСПОЛЬЗУЙ LaTeX и обратные слэши (\\) — пиши обычным текстом (*, ^, /).",
    "2) В поле \"verification\" ТРИЖДЫ перепроверь каждый ответ: сверь порядок полей IN_0, IN_1..., индексы SEL/CHOICE/MAC, пары C->F на DRAG_* и пары [\"i1\", \"i2\"] на POLY_*.",
    "3) Только после этого заполни итоговые поля ответа.",
    "Верни СТРОГО один валидный JSON-объект (json) без markdown-обёртки следующей структуры (из полей ответов включай только те, которые есть на странице):",
    "{",
    '  "reasoning": "пошаговое решение...",',
    '  "verification": "1) проверка вычислений... 2) проверка индексов... 3) финальная сверка...",',
    '  "inputs": { "0": "строка_ответа_для_IN_0", "1": "..." },',
    '  "selects": { "0": 2 },',
    '  "choices": { "0": [2] },',
    '  "macaroni": { "0": [[0, 1], [1, 2]] },',
    '  "drags": { "0": [{"choice": 0, "field": 0}] },',
    '  "polylines": { "0": [["i1", "i2"], ["i1", "i4"]] }',
    "}",
    "Пояснение по полям:",
    "- inputs: словарь «номер IN_k (строкой)» -> точный ответ для ввода в поле.",
    "- selects: словарь «номер SEL_k» -> индекс правильного варианта (целое число).",
    "- choices: словарь «номер CHOICE_k» -> массив индексов правильных вариантов.",
    "- macaroni: словарь «номер MAC_k» -> массив пар [индекс_слева, индекс_справа].",
    "- drags: словарь «номер DRAG_k» -> массив ходов {\"choice\": индекс_C, \"field\": индекс_F}.",
    "- polylines: словарь «номер POLY_k» -> массив пар [\"id_области_1\", \"id_области_2\"]."
  ].join("\n");

  const userContent = [{ type: "text", text: promptText }];

  if (Array.isArray(previousWrongAnswers) && previousWrongAnswers.length > 0) {
    userContent.push({
      type: "text",
      text: [
        "Сводка прошлых неверных ответов по этой странице (не повторяй их):",
        JSON.stringify(previousWrongAnswers, null, 2)
      ].join("\n")
    });
  }

  for (const img of images) {
    userContent.push({ type: "text", text: `Изображение ${img.label}:` });
    userContent.push({
      type: "image_url",
      image_url: { url: img.dataUrl }
    });
  }

  return callLLM(cfg, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ]);
}