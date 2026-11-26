const SITE_CONFIG = {
  buildNote: "Селекторы подтверждены по HTML-дампам education.yandex.ru (2026-11-25..26)",
  problemBlock: ".problem-block",
  kindText: "problem-block_kind_text",
  markerInline: "problem-block_marker-type_inline",
  markerChoice: "problem-block_marker-type_choice",
  markerMacaroni: "problem-block_marker-type_macaroni",
  markerDragImage: "problem-block_marker-type_dragimage",
  inlineField: ".inline-input_type_field",
  inlineSelect: ".inline-input_type_choice .select",
  choiceOption: "label.marker__option",
  macaroniLeft: ".MarkerMacaroni-List_orientation_left label.MarkerMacaroni-ItemOption",
  macaroniRight: ".MarkerMacaroni-List_orientation_right label.MarkerMacaroni-ItemOption",
  macaroniSvg: "svg.MarkerMacaroni-Lines",
  macaroniPin: ".MarkerMacaroni-ItemPin",
  dragWidget: ".marker.marker_type_dragimage",
  dragBg: "img.marker-dragimage__background",
  dragFields: ".marker-dragimage__field",
  dragChoices: "img.marker-dragimage__choice",
  dragUserAnswerClass: "marker-dragimage__user-answer",
  lessonBar: ".lesson-bar__plate",
  retryBtnSpan: "#problemBar\\.tryOnceAgain",
  availableAttemptBadge: ".attempts-counter__badge_status_available"
};

const DRAG_TUNING = {
  steps: 12,
  stepDelayMs: 20,
  afterDownMs: 70,
  beforeUpMs: 90,
  afterUpMs: 240,
  matchTolerancePx: 45
};

const MAX_ERROR_RETRIES = 2;

let lastSolvedSignature = null;
let lastPathname = location.pathname;
let isSolving = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(str) {
  return (str || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function getElementCleanText(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".erd_scroll_detection_container, .A11yHidden").forEach((n) => n.remove());
  return cleanText(clone.textContent);
}

function isElementLockedCorrect(el) {
  if (!el) return false;
  if (el.hasAttribute("readonly") || el.hasAttribute("disabled")) return true;
  if (el.closest(".inline-input_read-only, .inline-input_theme_correct, .marker_readonly, .marker_theme_correct")) {
    return true;
  }
  return false;
}

// --- Кнопки нижней панели ---
function findBarButton(keywords) {
  const bar = document.querySelector(SITE_CONFIG.lessonBar);
  if (!bar) return null;
  const buttons = Array.from(bar.querySelectorAll("button, [role='button']"));
  return buttons.find((btn) => {
    const txt = cleanText(btn.innerText).toLowerCase();
    return keywords.some((kw) => txt.includes(kw));
  }) || null;
}

function findSubmitButton() {
  return findBarButton(["ответить"]);
}

function findNextButton() {
  return findBarButton(["дальше", "далее", "продолжить", "следующ"]);
}

function findRetryButton() {
  const bar = document.querySelector(SITE_CONFIG.lessonBar);
  if (!bar) return null;
  const span = bar.querySelector(SITE_CONFIG.retryBtnSpan);
  if (span) return span.closest("button") || span;
  return findBarButton(["ещё раз", "еще раз", "попробовать"]);
}

function getRemainingAttempts() {
  const bar = document.querySelector(SITE_CONFIG.lessonBar);
  if (!bar) return 0;
  return bar.querySelectorAll(SITE_CONFIG.availableAttemptBadge).length;
}

// --- Уникальные плитки в исходном лотке dragimage ---
function getUniqueTrayChoices(dragWidget) {
  const wRect = dragWidget.getBoundingClientRect();
  const allTray = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragChoices))
    .filter((el) => !el.classList.contains(SITE_CONFIG.dragUserAnswerClass));

  const unique = [];
  for (const el of allTray) {
    const r = el.getBoundingClientRect();
    const left = r.left - wRect.left;
    const top = r.top - wRect.top;
    const alreadyExists = unique.some((u) => Math.hypot(u.left - left, u.top - top) < 8);
    if (!alreadyExists) {
      unique.push({ el, left, top });
    }
  }
  return unique;
}

// --- Растеризация картинок и dragimage в JPEG через <canvas> ---
function waitForImage(img) {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    img.addEventListener("load", () => { clearTimeout(timer); resolve(true); }, { once: true });
    img.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
}

async function rasterizeImgToDataUrl(img) {
  await waitForImage(img);
  const rect = img.getBoundingClientRect();
  const w = Math.round(rect.width || img.naturalWidth || 0);
  const h = Math.round(rect.height || img.naturalHeight || 0);
  if (w < 10 || h < 10) return null;

  const scale = Math.min(2, 1200 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);

  try {
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch (err) {
    console.warn("[YU-AutoSolver] Не удалось растеризовать изображение (CORS):", img.src, err);
    return null;
  }
}

async function renderDragWidgetToDataUrl(dragWidget, fields, trayItems) {
  const bgImg = dragWidget.querySelector(SITE_CONFIG.dragBg);
  if (bgImg) await waitForImage(bgImg);
  for (const item of trayItems) await waitForImage(item.el);

  const wRect = dragWidget.getBoundingClientRect();
  const w = Math.round(wRect.width);
  const h = Math.round(wRect.height);
  if (w < 20 || h < 20) return null;

  const pad = 26;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = (w + pad * 2) * scale;
  canvas.height = (h + pad * 2) * scale;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(pad, pad);

  try {
    if (bgImg) {
      ctx.drawImage(bgImg, 0, 0, w, h);
    }

    const sampleChoiceRect = trayItems[0]?.el.getBoundingClientRect();
    const slotW = sampleChoiceRect ? sampleChoiceRect.width : 36;
    const slotH = sampleChoiceRect ? sampleChoiceRect.height : 36;

    trayItems.forEach((item, idx) => {
      const r = item.el.getBoundingClientRect();
      const x = item.left;
      const y = item.top;
      ctx.drawImage(item.el, x, y, r.width, r.height);

      const label = `C${idx}`;
      ctx.font = "bold 10px monospace";
      const tw = ctx.measureText(label).width + 6;
      const bx = x + r.width - tw;
      const by = y - 12;

      ctx.fillStyle = "#1565c0";
      ctx.fillRect(bx, by, tw, 12);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, bx + 3, by + 9);
    });

    fields.forEach((f, idx) => {
      const r = f.getBoundingClientRect();
      const x = r.left - wRect.left;
      const y = r.top - wRect.top;

      ctx.save();
      ctx.strokeStyle = "rgba(211, 47, 47, 0.85)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x, y, slotW, slotH);
      ctx.restore();

      const label = `F${idx}`;
      ctx.font = "bold 10px monospace";
      const tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = "#c62828";
      ctx.fillRect(x, y - 12, tw, 12);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 3, y - 3);
    });

    return canvas.toDataURL("image/jpeg", 0.92);
  } catch (err) {
    console.warn("[YU-AutoSolver] Canvas fallback для dragimage:", err);
    return captureDragWidgetFallback(dragWidget, fields, trayItems);
  }
}

async function captureDragWidgetFallback(dragWidget, fields, trayItems) {
  dragWidget.scrollIntoView({ behavior: "instant", block: "center" });
  await sleep(150);

  const wRect = dragWidget.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:9999;";

  const addBadge = (left, top, text, bg) => {
    const b = document.createElement("div");
    b.textContent = text;
    b.style.cssText =
      `position:absolute;left:${left}px;top:${top - 12}px;` +
      `background:${bg};color:#fff;font:bold 10px monospace;padding:1px 3px;border-radius:2px;line-height:1;`;
    layer.appendChild(b);
  };

  fields.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    addBadge(r.left - wRect.left, r.top - wRect.top, `F${i}`, "#c62828");
  });
  trayItems.forEach((item, i) => addBadge(item.left, item.top, `C${i}`, "#1565c0"));

  dragWidget.appendChild(layer);
  await sleep(80);
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
    return resp?.ok ? resp.dataUrl : null;
  } finally {
    layer.remove();
  }
}

// --- Сбор всей страницы в единую структуру ---
function serializeInlineNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/\u00a0/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  if (node.classList.contains("A11yHidden") || node.classList.contains("erd_scroll_detection_container")) {
    return "";
  }

  if (node.matches(SITE_CONFIG.inlineField)) {
    const input = node.querySelector("input, textarea");
    if (input) {
      const id = ctx.inputs.length;
      const locked = isElementLockedCorrect(input);
      const currentVal = input.value || "";
      ctx.inputs.push({ el: input, locked, currentVal });

      if (locked) {
        return `[IN_${id} = "${currentVal}" (УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО, НЕ МЕНЯТЬ)]`;
      }
      const maxLen = input.getAttribute("maxlength");
      const maxStr = maxLen ? ` max=${maxLen}` : "";
      const errStr = (ctx.isRetry && currentVal)
        ? ` (БЫЛО ВВЕДЕНО: "${currentVal}" — ОШИБКА, ИСПРАВЬ)`
        : "";
      return `[IN_${id}${maxStr}${errStr}]`;
    }
    return "";
  }

  if (node.classList.contains("inline-input_type_choice")) {
    const selectEl = node.querySelector(".select");
    if (selectEl) {
      const options = Array.from(selectEl.querySelectorAll("ol.A11yHidden li[role='option']"))
        .map((li) => cleanText(li.textContent));
      const locked = isElementLockedCorrect(selectEl);
      const selectedText = cleanText(selectEl.querySelector(".selected")?.innerText);
      const id = ctx.selects.length;
      ctx.selects.push({ el: selectEl, options, locked });

      if (locked) {
        return `[SEL_${id} = "${selectedText}" (УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО)]`;
      }
      const optsStr = options.map((t, i) => `${i}="${t}"`).join(" | ");
      const errStr = (ctx.isRetry && selectedText && selectedText !== "?")
        ? ` (БЫЛО ВЫБРАНО: "${selectedText}" — ОШИБКА, ИСПРАВЬ)`
        : "";
      return `[SEL_${id}: ${optsStr}${errStr}]`;
    }
    return "";
  }

  if (node.tagName === "TABLE") {
    const rows = Array.from(node.querySelectorAll("tr"));
    const lines = rows
      .map((tr) => {
        const cells = Array.from(tr.children).map((td) => cleanText(serializeChildren(td, ctx)));
        return cells.some(Boolean) ? cells.join(" | ") : "";
      })
      .filter(Boolean);
    return "\n" + lines.join("\n") + "\n";
  }

  if (node.tagName === "IMG") {
    const imgIdx = ctx.pendingImages.length;
    ctx.pendingImages.push({ label: `IMG_${imgIdx}`, el: node });
    return ` [IMG_${imgIdx}] `;
  }

  if (node.tagName === "BR") return "\n";

  const text = serializeChildren(node, ctx);
  if (node.tagName === "P" || node.classList.contains("paragraph") || node.tagName === "LI") {
    return text + "\n";
  }
  return text;
}

function serializeChildren(el, ctx) {
  return Array.from(el.childNodes).map((ch) => serializeInlineNode(ch, ctx)).join("");
}

async function parseTaskPage(isRetry = false) {
  const blocks = Array.from(document.querySelectorAll(SITE_CONFIG.problemBlock));
  const ctx = {
    isRetry,
    inputs: [],
    selects: [],
    choices: [],
    macaroni: [],
    drags: [],
    pendingImages: [],
    images: [],
    promptLines: []
  };

  for (const block of blocks) {
    if (block.classList.contains(SITE_CONFIG.kindText)) {
      const txt = getElementCleanText(block);
      if (txt) ctx.promptLines.push(txt);

      const imgs = Array.from(block.querySelectorAll("img"));
      for (const img of imgs) {
        const imgIdx = ctx.pendingImages.length;
        ctx.pendingImages.push({ label: `IMG_${imgIdx}`, el: img });
        ctx.promptLines.push(`[IMG_${imgIdx}]`);
      }
      continue;
    }

    if (block.classList.contains(SITE_CONFIG.markerInline)) {
      const serialized = serializeChildren(block, ctx)
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      if (serialized) ctx.promptLines.push(serialized);
      continue;
    }

    if (block.classList.contains(SITE_CONFIG.markerChoice)) {
      const options = Array.from(block.querySelectorAll(SITE_CONFIG.choiceOption));
      if (options.length === 0) continue;

      const locked = isElementLockedCorrect(block.querySelector(".marker") || block);
      const isMulti = Boolean(block.querySelector('input[type="checkbox"]'));
      const id = ctx.choices.length;
      ctx.choices.push({ options, isMulti, locked });

      if (locked) {
        ctx.promptLines.push(`[CHOICE_${id}] (УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО)`);
        continue;
      }

      const lines = [`[CHOICE_${id}] (${isMulti ? "можно выбрать несколько вариантов" : "выбери один вариант"}):`];
      options.forEach((opt, i) => {
        const optText = getElementCleanText(opt);
        const optImg = opt.querySelector("img");
        if (optImg) {
          const imgIdx = ctx.pendingImages.length;
          ctx.pendingImages.push({ label: `IMG_${imgIdx}`, el: optImg });
          lines.push(`  ${i}: ${optText} [IMG_${imgIdx}]`);
        } else {
          lines.push(`  ${i}: ${optText}`);
        }
      });
      ctx.promptLines.push(lines.join("\n"));
      continue;
    }

    if (block.classList.contains(SITE_CONFIG.markerMacaroni)) {
      const left = Array.from(block.querySelectorAll(SITE_CONFIG.macaroniLeft));
      const right = Array.from(block.querySelectorAll(SITE_CONFIG.macaroniRight));
      if (left.length === 0 || right.length === 0) continue;

      const locked = isElementLockedCorrect(block.querySelector(".marker") || block);
      const id = ctx.macaroni.length;
      ctx.macaroni.push({ root: block, left, right, locked });

      if (locked) {
        ctx.promptLines.push(`[MAC_${id}] (УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО)`);
        continue;
      }

      const lines = [`[MAC_${id}] Установи соответствие [левый_индекс, правый_индекс]:`];
      lines.push("  Левый столбец:");
      left.forEach((el, i) => lines.push(`    ${i}: ${getElementCleanText(el)}`));
      lines.push("  Правый столбец:");
      right.forEach((el, i) => lines.push(`    ${i}: ${getElementCleanText(el)}`));
      ctx.promptLines.push(lines.join("\n"));
      continue;
    }

    if (block.classList.contains(SITE_CONFIG.markerDragImage)) {
      const dragWidget = block.querySelector(SITE_CONFIG.dragWidget);
      if (!dragWidget) continue;

      const locked = isElementLockedCorrect(dragWidget);
      const fields = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragFields));
      const trayItems = getUniqueTrayChoices(dragWidget);
      if (fields.length === 0 || trayItems.length === 0) continue;

      const choiceOrigins = trayItems.map((u) => ({ left: u.left, top: u.top }));

      const id = ctx.drags.length;
      ctx.drags.push({ widget: dragWidget, fields, choiceOrigins, locked });

      if (locked) {
        ctx.promptLines.push(`[DRAG_${id}] (УЖЕ ВЕРНО И ЗАБЛОКИРОВАНО, НЕ МЕНЯТЬ)`);
        continue;
      }

      const dataUrl = await renderDragWidgetToDataUrl(dragWidget, fields, trayItems);
      if (dataUrl) {
        ctx.images.push({ label: `DRAG_${id}`, dataUrl });
      }
      ctx.promptLines.push(
        `[DRAG_${id}] Визуальное перетаскивание (смотри изображение DRAG_${id}; слоты F0..F${fields.length - 1}, плитки C0..C${trayItems.length - 1}).`
      );
    }
  }

  for (const item of ctx.pendingImages) {
    const dataUrl = await rasterizeImgToDataUrl(item.el);
    if (dataUrl) {
      ctx.images.push({ label: item.label, dataUrl });
    }
  }

  const totalWidgets =
    ctx.inputs.length +
    ctx.selects.length +
    ctx.choices.length +
    ctx.macaroni.length +
    ctx.drags.length;

  return {
    ...ctx,
    totalWidgets,
    promptText: ctx.promptLines.join("\n\n")
  };
}

// --- Применение ответов к DOM ---
function setReactInputValue(el, value) {
  el.scrollIntoView({ behavior: "instant", block: "center" });
  el.focus();
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
}

function dispatchFullClick(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    which: 1
  };
  if (typeof PointerEvent !== "undefined") {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
  }
  el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
}

async function fillInlineSelect(selectItem, optionIndex) {
  if (selectItem.locked) return;
  const { el, options } = selectItem;
  const targetText = options[optionIndex];
  if (targetText === undefined) return;

  el.scrollIntoView({ behavior: "instant", block: "center" });
  await sleep(100);

  const control = el.querySelector(".select__control") || el;
  const controlRect = control.getBoundingClientRect();
  dispatchFullClick(control);
  await sleep(200);

  const candidates = Array.from(document.body.querySelectorAll("li, [role='option'], div, span"))
    .filter((node) => {
      if (node.closest(".A11yHidden") || node.closest(".select__control")) return false;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.height > 90) return false;
      return cleanText(node.innerText) === targetText;
    });

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.contains(b)) return 1;
      if (b.contains(a)) return -1;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return Math.hypot(ra.left - controlRect.left, ra.top - controlRect.bottom) -
             Math.hypot(rb.left - controlRect.left, rb.top - controlRect.bottom);
    });
    dispatchFullClick(candidates[0]);
    await sleep(150);
  }

  const selectedText = cleanText(el.querySelector(".selected")?.innerText);
  if (selectedText !== targetText) {
    const focusTarget = el.querySelector(".select__input") || control;
    focusTarget.focus();
    if (!el.classList.contains("select_opened")) {
      dispatchFullClick(control);
      await sleep(150);
    }
    for (let i = 0; i <= optionIndex; i++) {
      focusTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
      await sleep(40);
    }
    focusTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    await sleep(150);
  }
}

async function fillChoiceBlock(choiceItem, indices) {
  if (choiceItem.locked) return;
  const arr = Array.isArray(indices) ? indices : [indices];
  for (const idx of arr) {
    const label = choiceItem.options[idx];
    if (!label) continue;
    label.scrollIntoView({ behavior: "instant", block: "center" });
    await sleep(80);
    if (label.getAttribute("aria-checked") !== "true") {
      label.click();
      await sleep(120);
    }
  }
}

async function smoothMouseDrag(sx, sy, tx, ty, startEl) {
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

  const pev = (type, x, y, buttons) => {
    if (typeof PointerEvent === "undefined") return null;
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons
    });
  };

  const pDown = pev("pointerdown", sx, sy, 1);
  if (pDown) startEl.dispatchEvent(pDown);
  startEl.dispatchEvent(mev("mousedown", sx, sy, 1));
  await sleep(DRAG_TUNING.afterDownMs);

  for (let i = 1; i <= DRAG_TUNING.steps; i++) {
    const t = i / DRAG_TUNING.steps;
    const ease = t * t * (3 - 2 * t);
    const x = sx + (tx - sx) * ease;
    const y = sy + (ty - sy) * ease;
    const pMove = pev("pointermove", x, y, 1);
    if (pMove) document.dispatchEvent(pMove);
    document.dispatchEvent(mev("mousemove", x, y, 1));
    await sleep(DRAG_TUNING.stepDelayMs);
  }

  const pMoveEnd = pev("pointermove", tx, ty, 1);
  if (pMoveEnd) document.dispatchEvent(pMoveEnd);
  document.dispatchEvent(mev("mousemove", tx, ty, 1));
  await sleep(DRAG_TUNING.beforeUpMs);

  const targetAtEnd = document.elementFromPoint(tx, ty) || document;
  const pUp = pev("pointerup", tx, ty, 0);
  if (pUp) targetAtEnd.dispatchEvent(pUp);
  targetAtEnd.dispatchEvent(mev("mouseup", tx, ty, 0));
  await sleep(DRAG_TUNING.afterUpMs);
}

async function fillMacaroniBlock(macItem, pairs) {
  if (macItem.locked) return;
  const { root, left, right } = macItem;
  root.scrollIntoView({ behavior: "instant", block: "center" });
  await sleep(150);

  const svg = root.querySelector(SITE_CONFIG.macaroniSvg);
  const countLines = () => (svg ? svg.querySelectorAll("path, line, polyline").length : 0);

  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const lEl = left[pair[0]];
    const rEl = right[pair[1]];
    if (!lEl || !rEl) continue;

    // Если карточка уже соединена — пропускаем
    if (lEl.classList.contains("Option_status_checked") || lEl.classList.contains("Option_status_correct")) {
      continue;
    }

    const lTarget = lEl.querySelector(SITE_CONFIG.macaroniPin) || lEl.querySelector(".Option-Label") || lEl;
    const rTarget = rEl.querySelector(SITE_CONFIG.macaroniPin) || rEl.querySelector(".Option-Label") || rEl;

    const before = countLines();

    // 1. Сначала пробуем клик с полным набором Pointer/Mouse событий по кружочку (Pin)
    dispatchFullClick(lTarget);
    await sleep(160);
    dispatchFullClick(rTarget);
    await sleep(220);

    // 2. Если линия не появилась — тянем линию от левого пина к правому
    if (svg && countLines() === before) {
      const lr = lTarget.getBoundingClientRect();
      const rr = rTarget.getBoundingClientRect();
      await smoothMouseDrag(
        lr.left + lr.width / 2,
        lr.top + lr.height / 2,
        rr.left + rr.width / 2,
        rr.top + rr.height / 2,
        lTarget
      );
      await sleep(150);
    }
  }
}

async function clearDragUserAnswers(dragWidget, choiceOrigins) {
  for (let pass = 0; pass < 15; pass++) {
    const wRect = dragWidget.getBoundingClientRect();
    const placedTiles = Array.from(dragWidget.querySelectorAll(`.${SITE_CONFIG.dragUserAnswerClass}`))
      .filter((el) => {
        if (el.classList.contains("marker-dragimage__choice_disabled")) return false;
        const r = el.getBoundingClientRect();
        const inTray = choiceOrigins.some(
          (o) => Math.hypot((r.left - wRect.left) - o.left, (r.top - wRect.top) - o.top) < 12
        );
        return !inTray;
      });

    if (placedTiles.length === 0) break;

    const tile = placedTiles[0];
    const r = tile.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const tx = wRect.right - 10;
    const ty = wRect.top + 10;
    await smoothMouseDrag(sx, sy, tx, ty, tile);
  }
}

function findFreshChoiceAt(dragWidget, relOrigin) {
  const wRect = dragWidget.getBoundingClientRect();
  const currentChoices = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragChoices))
    .filter((el) => !el.classList.contains(SITE_CONFIG.dragUserAnswerClass));

  let bestEl = null;
  let bestDist = Infinity;

  for (const el of currentChoices) {
    const r = el.getBoundingClientRect();
    const dist = Math.hypot((r.left - wRect.left) - relOrigin.left, (r.top - wRect.top) - relOrigin.top);
    if (dist < bestDist) {
      bestDist = dist;
      bestEl = el;
    }
  }

  return bestDist < 22 ? bestEl : null;
}

function isTileAtField(dragWidget, dst, choiceOrigins) {
  const wRect = dragWidget.getBoundingClientRect();
  const tRect = dst.getBoundingClientRect();
  const currentChoices = Array.from(dragWidget.querySelectorAll(SITE_CONFIG.dragChoices));

  return currentChoices.some((el) => {
    const r = el.getBoundingClientRect();
    const inTray = choiceOrigins.some(
      (o) => Math.hypot((r.left - wRect.left) - o.left, (r.top - wRect.top) - o.top) < 12
    );
    if (inTray) return false;

    const dTopLeft = Math.hypot(r.left - tRect.left, r.top - tRect.top);
    const dCenter = Math.hypot((r.left + r.width / 2) - tRect.left, (r.top + r.height / 2) - tRect.top);
    return Math.min(dTopLeft, dCenter) <= DRAG_TUNING.matchTolerancePx;
  });
}

async function fillDragWidget(dragItem, moves) {
  if (dragItem.locked) return;
  const { widget, fields, choiceOrigins } = dragItem;
  if (!Array.isArray(moves) || moves.length === 0) return;

  widget.scrollIntoView({ behavior: "instant", block: "center" });
  await sleep(200);

  await clearDragUserAnswers(widget, choiceOrigins);

  for (const move of moves) {
    const relOrigin = choiceOrigins[move.choice];
    const dst = fields[move.field];
    if (!relOrigin || !dst) continue;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const wRect = widget.getBoundingClientRect();
      if (wRect.top < 10 || wRect.bottom > window.innerHeight - 10) {
        widget.scrollIntoView({ behavior: "instant", block: "center" });
        await sleep(150);
      }

      const freshSrc = findFreshChoiceAt(widget, relOrigin);
      if (!freshSrc) {
        console.warn("[YU-AutoSolver] Не найдена плитка C" + move.choice);
        break;
      }

      const r1 = freshSrc.getBoundingClientRect();
      const r2 = dst.getBoundingClientRect();
      const sx = r1.left + r1.width / 2;
      const sy = r1.top + r1.height / 2;
      const tx = attempt === 1 ? r2.left : r2.left + r1.width / 2;
      const ty = attempt === 1 ? r2.top : r2.top + r1.height / 2;

      await smoothMouseDrag(sx, sy, tx, ty, freshSrc);

      if (isTileAtField(widget, dst, choiceOrigins)) {
        break;
      }
      console.warn(`[YU-AutoSolver] Плитка C${move.choice} -> F${move.field} не зафиксировалась, повтор (${attempt}/2)`);
      await sleep(150);
    }
  }
}

async function applyAnswers(parsed, ans) {
  if (ans.inputs && typeof ans.inputs === "object") {
    for (const [k, val] of Object.entries(ans.inputs)) {
      const item = parsed.inputs[Number(k)];
      if (item && !item.locked) {
        setReactInputValue(item.el, String(val));
        await sleep(80);
      }
    }
  }

  if (ans.selects && typeof ans.selects === "object") {
    for (const [k, optIdx] of Object.entries(ans.selects)) {
      const item = parsed.selects[Number(k)];
      if (item && !item.locked) {
        await fillInlineSelect(item, Number(optIdx));
      }
    }
  }

  if (ans.choices && typeof ans.choices === "object") {
    for (const [k, indices] of Object.entries(ans.choices)) {
      const item = parsed.choices[Number(k)];
      if (item && !item.locked) {
        await fillChoiceBlock(item, indices);
      }
    }
  }

  if (ans.macaroni && typeof ans.macaroni === "object") {
    for (const [k, pairs] of Object.entries(ans.macaroni)) {
      const item = parsed.macaroni[Number(k)];
      if (item && !item.locked && Array.isArray(pairs)) {
        await fillMacaroniBlock(item, pairs);
      }
    }
  }

  if (ans.drags && typeof ans.drags === "object") {
    for (const [k, moves] of Object.entries(ans.drags)) {
      const item = parsed.drags[Number(k)];
      if (item && !item.locked && Array.isArray(moves)) {
        await fillDragWidget(item, moves);
      }
    }
  }
}

async function waitForSubmitResult() {
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const retryBtn = findRetryButton();
    if (retryBtn && !retryBtn.disabled) {
      return { status: "retry", btn: retryBtn };
    }
    const nextBtn = findNextButton();
    if (nextBtn && !nextBtn.disabled) {
      return { status: "next", btn: nextBtn };
    }
  }
  return { status: "unknown", btn: null };
}

// --- Главный цикл с работой над ошибками ---
async function trySolveCurrentTask(force = false) {
  if (isSolving) return;
  isSolving = true;

  try {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      lastSolvedSignature = null;
    }

    const { enabled, autoSubmit, autoNext } = await chrome.storage.local.get({
      enabled: false,
      autoSubmit: false,
      autoNext: false
    });
    if (!enabled && !force) return;

    let parsed = await parseTaskPage(false);
    if (!parsed.promptText && parsed.totalWidgets === 0) return;

    const signature = `${location.pathname}::${parsed.totalWidgets}::${parsed.promptText.slice(0, 140)}`;
    if (!force && signature === lastSolvedSignature) return;

    if (parsed.totalWidgets === 0) {
      if (autoNext) {
        const nextBtn = findNextButton();
        if (nextBtn && !nextBtn.disabled) {
          lastSolvedSignature = signature;
          await sleep(800);
          nextBtn.click();
        }
      }
      return;
    }

    const previousWrongAnswers = [];

    for (let attempt = 0; attempt <= MAX_ERROR_RETRIES; attempt++) {
      if (attempt > 0) {
        parsed = await parseTaskPage(true);
        if (parsed.totalWidgets === 0) break;
      }

      console.log(`[YU-AutoSolver] Попытка ${attempt + 1}: отправляем в API`, {
        inputs: parsed.inputs.map((x, i) => ({ i, locked: x.locked, val: x.currentVal })),
        selects: parsed.selects.length,
        choices: parsed.choices.length,
        macaroni: parsed.macaroni.length,
        drags: parsed.drags.map((x, i) => ({ i, locked: x.locked })),
        images: parsed.images.map((i) => i.label)
      });

      const resp = await chrome.runtime.sendMessage({
        type: "SOLVE_UNIFIED_TASK",
        payload: {
          promptText: parsed.promptText,
          images: parsed.images,
          previousWrongAnswers
        }
      });

      if (!resp?.ok) {
        console.error("[YU-AutoSolver] Ошибка API:", resp?.error);
        break;
      }

      const ans = resp.data || {};
      console.log("[YU-AutoSolver] Ответ модели:", ans);

      await applyAnswers(parsed, ans);

      if (!autoSubmit) break;

      await sleep(400);
      const submitBtn = findSubmitButton();
      if (!submitBtn || submitBtn.disabled) break;

      submitBtn.click();
      const result = await waitForSubmitResult();

      if (result.status === "next") {
        if (autoNext && result.btn) {
          await sleep(500);
          result.btn.click();
        }
        break;
      }

      if (result.status === "retry") {
        const remaining = getRemainingAttempts();
        console.warn(`[YU-AutoSolver] Ответ неверный. Осталось попыток: ${remaining}`);

        if (attempt < MAX_ERROR_RETRIES && remaining > 0) {
          previousWrongAnswers.push({
            inputs: ans.inputs,
            selects: ans.selects,
            choices: ans.choices,
            macaroni: ans.macaroni,
            drags: ans.drags
          });
          await sleep(400);
          result.btn.click();
          await sleep(900);
          continue;
        }
        break;
      }

      break;
    }

    lastSolvedSignature = signature;
  } finally {
    isSolving = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SOLVE_NOW") {
    lastSolvedSignature = null;
    trySolveCurrentTask(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    trySolveCurrentTask(false);
  }, 800);
});
observer.observe(document.body, { childList: true, subtree: true });

setTimeout(() => trySolveCurrentTask(false), 900);