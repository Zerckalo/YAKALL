const SITE_CONFIG = {
  buildNote: "Проверено на education.yandex.ru/classroom/.../run/4/ (2026-11-25)",
  textBlocks: ".problem-block.problem-block_kind_text",
  dragWidget: ".marker.marker_type_dragimage",
  dragFields: ".marker-dragimage__field",
  dragChoices: "img.marker-dragimage__choice",
  lessonBar: ".lesson-bar__plate"
};

let lastSolvedSignature = null;
let isSolving = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findSubmitButton() {
  const bar = document.querySelector(SITE_CONFIG.lessonBar);
  if (!bar) return null;
  const candidates = Array.from(bar.querySelectorAll("button, [role='button']"));
  return candidates.find((el) => el.innerText.trim().toLowerCase().includes("ответить")) || null;
}

function setReactInputValue(el, value) {
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function dragChoiceToField(src, dst) {
  const r1 = src.getBoundingClientRect();
  const r2 = dst.getBoundingClientRect();

  const sx = r1.left + r1.width / 2;
  const sy = r1.top + r1.height / 2;
  const tx = r2.left;
  const ty = r2.top;

  const mev = (type, x, y, buttons) =>
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
      which: 1
    });

  src.dispatchEvent(mev("mousedown", sx, sy, 1));
  for (let i = 1; i <= 5; i++) {
    await sleep(25);
    const x = sx + (tx - sx) * (i / 5);
    const y = sy + (ty - sy) * (i / 5);
    document.dispatchEvent(mev("mousemove", x, y, 1));
  }
  await sleep(40);
  document.dispatchEvent(mev("mouseup", tx, ty, 0));
  await sleep(120);
}

// Находит свежую плитку в нижнем лотке по её исходным координатам
function findFreshChoiceAt(dragWidget, origin) {
  const currentChoices = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragChoices));
  let bestEl = null;
  let bestDist = Infinity;

  for (const el of currentChoices) {
    const r = el.getBoundingClientRect();
    const dist = Math.hypot(r.left - origin.left, r.top - origin.top);
    if (dist < bestDist) {
      bestDist = dist;
      bestEl = el;
    }
  }

  return bestDist < 20 ? bestEl : null;
}

function createMarkersOverlay(fields, choices) {
  const root = document.createElement("div");
  root.id = "yu-autosolver-overlay";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";

  const addBadge = (rect, text, bg) => {
    const b = document.createElement("div");
    b.textContent = text;
    b.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
      `background:${bg};color:#fff;font:bold 11px monospace;` +
      "padding:1px 3px;border-radius:3px;line-height:1;";
    root.appendChild(b);
  };

  fields.forEach((el, i) => addBadge(el.getBoundingClientRect(), `F${i}`, "#d32f2f"));
  choices.forEach((el, i) => addBadge(el.getBoundingClientRect(), `C${i}`, "#1976d2"));

  document.body.appendChild(root);
  return () => root.remove();
}

async function trySolveCurrentTask() {
  if (isSolving) return;
  isSolving = true;

  try {
    const { enabled, autoSubmit } = await chrome.storage.local.get({
      enabled: false,
      autoSubmit: false
    });
    if (!enabled) return;

    const textNodes = Array.from(document.querySelectorAll(SITE_CONFIG.textBlocks));
    const taskText = textNodes.map((n) => n.innerText.trim()).filter(Boolean).join("\n");
    if (!taskText) return;

    const signature = `${location.pathname}::${taskText.slice(0, 120)}`;
    if (signature === lastSolvedSignature) return;

    const dragWidget = document.querySelector(SITE_CONFIG.dragWidget);
    const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea"));
    if (!dragWidget && inputs.length === 0) return;

    if (dragWidget) {
      dragWidget.scrollIntoView({ block: "center" });
      await sleep(150);

      const fields = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragFields));
      const initialChoices = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragChoices));
      if (fields.length === 0 || initialChoices.length === 0) return;

      // Запоминаем исходные позиции плиток в лотке до начала перетаскивания
      const choiceOrigins = initialChoices.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });

      const removeOverlay = createMarkersOverlay(fields, initialChoices);
      await sleep(80);

      let resp;
      try {
        resp = await chrome.runtime.sendMessage({
          type: "SOLVE_DRAG_TASK",
          payload: {
            taskText,
            fieldsCount: fields.length,
            choicesCount: initialChoices.length
          }
        });
      } finally {
        removeOverlay();
      }

      if (!resp?.ok) {
        console.error("[YU-AutoSolver] Ошибка drag-решения:", resp?.error);
        lastSolvedSignature = signature;
        return;
      }

      console.log("[YU-AutoSolver] Ходы:", resp.data.moves);
      for (const move of resp.data.moves) {
        const origin = choiceOrigins[move.choice];
        const dst = fields[move.field];
        if (!origin || !dst) continue;

        const freshSrc = findFreshChoiceAt(dragWidget, origin);
        if (freshSrc) {
          await dragChoiceToField(freshSrc, dst);
        } else {
          console.warn("[YU-AutoSolver] Не найдена свежая плитка для индекса:", move.choice);
        }
      }
    } else {
      const inputDescriptions = inputs.map((el, idx) => ({
        index: idx,
        tag: el.tagName,
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || ""
      }));

      const resp = await chrome.runtime.sendMessage({
        type: "SOLVE_TEXT_TASK",
        payload: { taskText, inputDescriptions }
      });

      if (!resp?.ok) {
        console.error("[YU-AutoSolver] Ошибка text-решения:", resp?.error);
        lastSolvedSignature = signature;
        return;
      }

      resp.data.answers.forEach((ans, idx) => {
        if (inputs[idx]) setReactInputValue(inputs[idx], String(ans));
      });
    }

    lastSolvedSignature = signature;

    if (autoSubmit) {
      await sleep(150);
      const btn = findSubmitButton();
      if (btn && !btn.disabled) btn.click();
    }
  } finally {
    isSolving = false;
  }
}

let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    trySolveCurrentTask();
  }, 700);
});
observer.observe(document.body, { childList: true, subtree: true });

setTimeout(() => trySolveCurrentTask(), 700);