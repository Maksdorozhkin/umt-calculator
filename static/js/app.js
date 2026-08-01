// UMT Калькулятор формовки
let currentMachine = 1;
let productCache = [];

//  (PWA) Реализация работы как приложения
const OFFLINE_QUEUE_KEY = "umt_offline_queue";

// === localStorage кэш для офлайн-работы ===
const CACHE_PRODUCTS_KEY = "umt_products_cache";
const CACHE_MACHINE_PRODUCT_KEY = "umt_machine_product_cache";
const CACHE_DOWNTIME_KEY = "umt_downtime_cache";
const CACHE_BALANCE_KEY = "umt_balance_cache"; // { "1": 100, "3": 250 }

/**
 * customFetch — wrapper around fetch().
 *  - GET  → обычный fetch (SW сделает network-first с кэшем).
 *  - POST/DELETE → при офлайн-ошибке:
 *      1. Ставит запрос в localStorage-очередь (FIFO)
 *      2. Возвращает { success:true, offline:true }
 *  - При появлении сети — автоматически проигрывает очередь (FIFO),
 *    а также проверяет очередь каждые 30 секунд.
 */
async function customFetch(url, options = {}) {
  const method = options.method || "GET";
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  try {
    const response = await fetch(url, options);
    // Если ответ OK — при WRITE-запросе удаляем дубликаты из очереди
    if (isWrite && response.ok) {
      await replayOfflineQueue();
    }
    return response;
  } catch (err) {
    if (!isWrite) throw err; // GET — пробрасываем ошибку (SW справится)

    // Офлайн при POST/DELETE — сохраняем в очередь
    const entry = {
      url,
      method: method,
      body: options.body ? JSON.parse(options.body) : undefined,
      headers: options.headers || { "Content-Type": "application/json" },
      timestamp: Date.now(),
    };
    const queue = getOfflineQueue();
    queue.push(entry);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));

    // Запускаем периодическую попытку синхронизации
    ensureSyncTimer();

    // Возвращаем «успех офлайн» чтобы UI не ломался
    console.warn("[offline] queued request:", url, entry);
    return new Response(JSON.stringify({ success: true, offline: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)) || [];
  } catch {
    return [];
  }
}

/** Проиграть очередь FIFO — при успехе удаляем, при ошибке оставляем */
async function replayOfflineQueue() {
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  let anySuccess = false;
  for (const entry of queue) {
    try {
      await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body ? JSON.stringify(entry.body) : undefined,
      });
      // Успех — удаляем
      const idx = queue.indexOf(entry);
      if (idx > -1) queue.splice(idx, 1);
      anySuccess = true;
    } catch {
      // Ошибка — оставляем в очереди для следующей попытки
      break;
    }
  }
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));

  // После успешной синхронизации обновляем кэши с сервера
  if (anySuccess) {
    await reloadCachesAfterSync();
  }
}

/** Перезагрузка всех кэшей с сервера после синхронизации */
async function reloadCachesAfterSync() {
  try {
    await loadProductCache();
  } catch {
    // products не критичны
  }
  for (let i = 1; i <= 7; i++) {
    try {
      await loadDowntimeLog(i);
    } catch {
      // downtime не критичен
    }
  }
}

let _syncTimer = null;
function ensureSyncTimer() {
  if (_syncTimer) return;
  _syncTimer = setInterval(async () => {
    if (navigator.onLine) {
      await replayOfflineQueue();
      if (getOfflineQueue().length === 0) {
        clearInterval(_syncTimer);
        _syncTimer = null;
      }
    }
  }, 30000); // каждые 30 секунд
}

// При восстановлении сети — мгновенная попытка синхронизации
window.addEventListener("online", () => {
  console.log("[offline] back online, syncing...");
  replayOfflineQueue();
  ensureSyncTimer();
});

// Service Worker → message: sync queue
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SYNC_OFFLINE_QUEUE") {
      replayOfflineQueue();
    }
  });
}

// ==================== LOCALSTORAGE CACHE HELPERS ====================

/** Загрузить справочник из localStorage или вернуть [] */
function getCachedProducts() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_PRODUCTS_KEY)) || [];
  } catch {
    return [];
  }
}

/** Сохранить справочник в localStorage */
function setCachedProducts(products) {
  localStorage.setItem(CACHE_PRODUCTS_KEY, JSON.stringify(products));
}

/** Получить кэш machine→product (объект { "1": {...}, "2": {...} }) */
function getCachedMachineProducts() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_MACHINE_PRODUCT_KEY)) || {};
  } catch {
    return {};
  }
}

/** Сохранить mapping machine→product в localStorage */
function setCachedMachineProducts(cache) {
  localStorage.setItem(CACHE_MACHINE_PRODUCT_KEY, JSON.stringify(cache));
}

/** Получить кэш отчетов простоев для машины (объект { "1": [...], "2": [...] }) */
function getCachedDowntimes() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_DOWNTIME_KEY)) || {};
  } catch {
    return {};
  }
}

/** Сохранить отчеты простоев в localStorage */
function setCachedDowntimes(cache) {
  localStorage.setItem(CACHE_DOWNTIME_KEY, JSON.stringify(cache));
}

//  INIT
document.addEventListener("DOMContentLoaded", function () {
  loadProductCache().then(() => {
    setupTabs();
    setupDowntimeSelectors();
    setupShiftBalance();
    setupProductForms();
    setupTapeForm();
    setupAutocomplete();
    setupReferencePanel();
    setupItemsCalculator();
    updateShiftDisplay();
    setInterval(updateShiftDisplay, 60000);
    loadInitialData();
  });
});

// Определение смены (новая функция до 8:00)
function updateShiftDisplay() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  let isDayShift;
  // 480 мин = 08:00, 1200 мин = 20:00
  if (totalMinutes >= 480 && totalMinutes < 1200) {
    isDayShift = true; // Дневная смена
  } else {
    isDayShift = false; // Ночная смена
  }

  document.documentElement.setAttribute(
    "data-theme",
    isDayShift ? "light" : "dark",
  );

  const icon = document.getElementById("shiftIcon");
  const label = document.getElementById("shiftLabel");
  const time = document.getElementById("shiftTime"); // Этот элемент есть в коде, но пока не используется

  if (isDayShift) {
    icon.textContent = "☀️";
    label.textContent = "Дневная смена";
  } else {
    icon.textContent = "🌙";
    label.textContent = "Ночная смена";
  }

  // Расчет времени
  const remaining = getRemainingMinutes();
  time.textContent = `До конца: ${formatTimeShort(remaining)}`;

  // Обновление оставшегося времени и баланса для всех машин
  for (let i = 1; i <= 7; i++) {
    calculateShiftBalance(i);
    renderTimeline(i);
  }
}

//  ОПРЕДЕЛЯЕМ КОНЕЦ СМЕНЫ
function getShiftEndMinutes() {
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();

  // Дневная смена (с 8:00 до 20:00) -> закончится в 20:00 (1200 мин)
  if (totalMinutes >= 480 && totalMinutes < 1200) {
    return 1200;
  }

  // Ночная смена ДО полуночи (с 20:00 до 00:00) -> закончится в 8 утра следующего дня (1440 + 480 = 1920 мин)
  if (totalMinutes >= 1200) {
    return 1920;
  }

  // Ночная смена ПОСЛЕ полуночи ( Ground zero, с 00:00 до 8:00) -> закончится в 8 утра текущего дня (480 мин)
  return 480;
}

// 2. СЧИТАЕМ ОСТАТОК ВРЕМЕНИ (-10 минут)
function getRemainingMinutes() {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const end = getShiftEndMinutes();
  const totalRemaining = end - nowMinutes;

  // Math.max не даст счетчику уйти в минус во время пересменки
  return Math.max(0, totalRemaining - 10);
}

function formatTimeShort(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h}ч ${m}мин`;
}

function updateAvailableTime(machineId) {
  // Обновляем ВСЕ машины, а не только одну
  for (let i = 1; i <= 7; i++) {
    const totalEl = document.getElementById(`totalDowntime${i}`);
    if (!totalEl) continue;

    const remaining = getRemainingMinutes();

    // Общий простой = ВСЕ простои за смену (и прошедшие, и будущие)
    const allDowntime = getTotalDowntimeAllForMachine(i);
    totalEl.textContent = allDowntime > 0 ? `${allDowntime} мин` : "0 мин";

    // Обновить выпуск за смену (паллеты + коробки)
    updateShiftOutput(i);

    // Обновить производительность в час
    updateHourlyRate(i);
  }
}

// Выпуск за смену целиком (710 мин = 11ч50м): паллеты + коробки
function updateShiftOutput(machineId) {
  const el = document.getElementById(`shiftOutput${machineId}`);
  if (!el) return;

  const cavitations =
    parseInt(document.getElementById(`cavitations${machineId}`)?.value) || 0;
  const cycles =
    parseFloat(document.getElementById(`cycles${machineId}`)?.value) || 0;
  const piecesPerBox =
    parseInt(document.getElementById(`piecesPerBox${machineId}`)?.value) || 1;
  const boxesPerPallet =
    parseInt(document.getElementById(`boxesPerPallet${machineId}`)?.value) || 1;

  if (cavitations === 0 || cycles === 0) {
    el.textContent = "--";
    return;
  }

  // Вся смена = 710 минут (11ч50м)
  const SHIFT_MINUTES = 710;
  const totalPieces = SHIFT_MINUTES * cycles * cavitations;
  const totalBoxes = Math.floor(totalPieces / piecesPerBox);
  const fullPallets = Math.floor(totalBoxes / boxesPerPallet);
  const leftoverBoxes = totalBoxes - fullPallets * boxesPerPallet;

  if (fullPallets > 0) {
    el.textContent = `${fullPallets}п. ${leftoverBoxes}кор.`;
  } else if (totalBoxes > 0) {
    el.textContent = `${totalBoxes}кор.`;
  } else {
    el.textContent = `${Math.floor(totalPieces)}шт.`;
  }
}

// Производительность в час: кавитации × такты/мин × 60 = шт/час
// Формат: "2п. 4кор." / "14кор." / "38шт."
function updateHourlyRate(machineId) {
  const el = document.getElementById(`hourlyRate${machineId}`);
  if (!el) return;

  const cavitations =
    parseInt(document.getElementById(`cavitations${machineId}`)?.value) || 0;
  const cycles =
    parseFloat(document.getElementById(`cycles${machineId}`)?.value) || 0;
  const piecesPerBox =
    parseInt(document.getElementById(`piecesPerBox${machineId}`)?.value) || 1;
  const boxesPerPallet =
    parseInt(document.getElementById(`boxesPerPallet${machineId}`)?.value) || 1;

  if (cavitations === 0 || cycles === 0) {
    el.textContent = "--";
    return;
  }

  const piecesPerHour = cavitations * cycles * 60;
  const boxesPerHour = piecesPerHour / piecesPerBox;
  const pallets = Math.floor(boxesPerHour / boxesPerPallet);
  const boxes = Math.floor(boxesPerHour % boxesPerPallet);

  if (pallets > 0) {
    el.textContent = `${pallets}п. ${boxes}кор.`;
  } else if (boxesPerHour >= 1) {
    el.textContent = `${Math.floor(boxesPerHour)}кор.`;
  } else {
    el.textContent = `${Math.floor(piecesPerHour)}шт.`;
  }
}

// Переключение вкладок
function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const contents = document.querySelectorAll(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", function () {
      const target = this.dataset.tab;

      tabs.forEach((t) => t.classList.remove("active"));
      contents.forEach((c) => c.classList.remove("active"));

      this.classList.add("active");
      const targetContent = document.getElementById(target);
      if (targetContent) targetContent.classList.add("active");

      if (
        target !== "tape" &&
        target !== "reference" &&
        target !== "items-calc"
      ) {
        currentMachine = parseInt(target.replace("machine", ""));
        loadMachineProduct(currentMachine);
        loadDowntimeLog(currentMachine);
        updateAvailableTime(currentMachine);
      } else if (target === "reference") {
        loadProductList();
      }
    });
  });
}

// загрузка кэша продуктов (localStorage → сервер)
async function loadProductCache() {
  // Сначала загружаем из localStorage (мгновенно, работает офлайн)
  const cached = getCachedProducts();
  if (cached.length > 0) {
    productCache = cached;
  }

  // Затем пытаемся обновить с сервера
  try {
    const response = await customFetch("/api/products");
    const fresh = await response.json();
    if (fresh.length > 0) {
      productCache = fresh;
      setCachedProducts(fresh);
    }
  } catch (error) {
    console.warn("[offline] Справочник не обновлён, используется кэш:", error.message);
    // productCache уже заполнен из localStorage
  }
}

// Автокомплит, экономит время
function setupAutocomplete() {
  for (let i = 1; i <= 7; i++) {
    const input = document.getElementById(`productName${i}`);
    const list = document.getElementById(`autocomplete${i}`);
    if (!input || !list) continue;

    input.addEventListener("input", function () {
      const query = this.value.toLowerCase().trim();
      if (!query) {
        list.classList.remove("show");
        return;
      }

      const matches = productCache.filter((p) =>
        p.name.toLowerCase().includes(query),
      );

      if (matches.length === 0) {
        list.classList.remove("show");
        return;
      }

      list.innerHTML = matches
        .map(
          (p) =>
            `<div class="autocomplete-item" data-id="${p.id}">${escapeHtml(p.name)}</div>`,
        )
        .join("");
      list.classList.add("show");
    });

    list.addEventListener("click", function (e) {
      const item = e.target.closest(".autocomplete-item");
      if (!item) return;

      const productId = item.dataset.id;
      const product = productCache.find((p) => p.id == productId);
      if (product) {
        input.value = product.name;
        fillProductData(i, product);
        list.classList.remove("show");
        showNotification(`Загружены данные для "${product.name}"`, "success");
      }
    });

    input.addEventListener("blur", function () {
      setTimeout(() => list.classList.remove("show"), 200);
    });

    input.addEventListener("focus", function () {
      if (this.value.trim()) this.dispatchEvent(new Event("input"));
    });
  }
}

function fillProductData(machineId, product) {
  document.getElementById(`cavitations${machineId}`).value =
    product.cavitations;
  document.getElementById(`cycles${machineId}`).value =
    product.cycles_per_minute;
  document.getElementById(`piecesPerBox${machineId}`).value =
    product.pieces_per_box;
  document.getElementById(`boxesPerPallet${machineId}`).value =
    product.boxes_per_pallet;
  updateHourlyRate(machineId);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ==================== PRODUCT FORMS ====================
function setupProductForms() {
  for (let i = 1; i <= 7; i++) {
    const form = document.getElementById(`productForm${i}`);
    if (!form) continue;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      saveProduct(i);
    });

    // Кнопка расчета
    const calcBtn = document.querySelector(`.calc-btn[data-machine="${i}"]`);
    if (calcBtn)
      calcBtn.addEventListener("click", () => calculateProduction(i));

    // Кнопка сброса
    const resetBtn = document.querySelector(`.reset-btn[data-machine="${i}"]`);
    if (resetBtn) resetBtn.addEventListener("click", () => resetCalculator(i));

    // Кнопка добавления простоя
    const addBtn = document.querySelector(
      `.add-downtime-btn[data-machine="${i}"]`,
    );
    if (addBtn) addBtn.addEventListener("click", () => logDowntime(i));

    // Слушатели на поля формы для обновления "За смену" в реальном времени
    const fields = [
      `cavitations${i}`,
      `cycles${i}`,
      `piecesPerBox${i}`,
      `boxesPerPallet${i}`,
    ];
    fields.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", () => updateShiftOutput(i));
        el.addEventListener("change", () => updateShiftOutput(i));
      }
    });
  }
}

// Видимость полей простоя
function setupDowntimeSelectors() {
  for (let i = 1; i <= 7; i++) {
    const select = document.getElementById(`downtimeType${i}`);
    const durationInput = document.getElementById(`downtimeDuration${i}`);
    if (!select || !durationInput) continue;

    // Типы с фиксированной длительностью — скрываем поле ввода
    const fixedTypes = new Set(["roller_7", "roller_15"]);

    select.addEventListener("change", function () {
      if (fixedTypes.has(this.value)) {
        durationInput.style.display = "none";
        durationInput.required = false;
      } else {
        // Все остальные — ручной ввод
        durationInput.style.display = "block";
        durationInput.required = true;
      }
    });
  }
}

// === Хелпер: штуки → паллеты + коробки (округление до целой коробки вниз) ===
function piecesToPalletsBoxes(pieces, piecesPerBox, boxesPerPallet) {
  const totalBoxes = Math.floor(pieces / piecesPerBox);
  const fullPallets = Math.floor(totalBoxes / boxesPerPallet);
  const leftoverBoxes = totalBoxes - fullPallets * boxesPerPallet;
  return { pallets: fullPallets, boxes: leftoverBoxes };
}

// Форматирование "Xп. Yкор." / "Yкор." / "0"
function formatPalletsBoxes(pallets, boxes) {
  if (pallets > 0) return `${pallets} п. ${boxes} кор.`;
  if (boxes > 0) return `${boxes} кор.`;
  return "0";
}

// === Баланс смены: инициализация + обработчики ввода факта выпуска ===
function setupShiftBalance() {
  for (let i = 1; i <= 7; i++) {
    const palletsInput = document.getElementById(`factPallets${i}`);
    const boxesInput = document.getElementById(`factBoxes${i}`);
    if (!palletsInput || !boxesInput) continue;

    // Восстановить из кэша
    const cached = getBalanceCache();
    const saved = cached[String(i)];
    if (saved && (saved.pallets > 0 || saved.boxes > 0)) {
      palletsInput.value = saved.pallets;
      boxesInput.value = saved.boxes;
    }

    // Обработчики ввода для обоих полей
    const onInput = function () {
      const p = parseInt(stripSpaces(palletsInput.value)) || 0;
      const b = parseInt(stripSpaces(boxesInput.value)) || 0;
      setBalanceCache(i, { pallets: p, boxes: b });
      calculateShiftBalance(i);
    };
    palletsInput.addEventListener("input", onInput);
    boxesInput.addEventListener("input", onInput);
  }
}

// localStorage helpers для баланса — теперь хранит { pallets, boxes }
function getBalanceCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_BALANCE_KEY)) || {}; } catch { return {}; }
}
function setBalanceCache(machineId, value) {
  const cache = getBalanceCache();
  if (value.pallets > 0 || value.boxes > 0) {
    cache[String(machineId)] = value;
  } else {
    delete cache[String(machineId)];
  }
  localStorage.setItem(CACHE_BALANCE_KEY, JSON.stringify(cache));
}

// === Расчёт баланса смены (факт, должно быть и разница — в паллетах/коробках) ===
function calculateShiftBalance(machineId) {
  const palletsInput = document.getElementById(`factPallets${machineId}`);
  const boxesInput = document.getElementById(`factBoxes${machineId}`);
  const elapsedEl = document.getElementById(`elapsedTime${machineId}`);
  const expectedEl = document.getElementById(`expectedOutput${machineId}`);
  const diffEl = document.getElementById(`outputDiff${machineId}`);
  const unaccountedEl = document.getElementById(`unaccountedDowntime${machineId}`);
  const warningRow = document.getElementById(`unaccountedRow${machineId}`);
  const progressBar = document.getElementById(`progressBar${machineId}`);
  const progressText = document.getElementById(`progressText${machineId}`);

  if (!palletsInput || !boxesInput || !elapsedEl) return;

  // Прошло времени с начала смены (минуты)
  const elapsedMinutes = getElapsedShiftMinutes();
  const elapsedH = Math.floor(elapsedMinutes / 60);
  const elapsedM = Math.round(elapsedMinutes % 60);
  elapsedEl.textContent = `${elapsedH}ч ${elapsedM}мин`;

  // Параметры продукта
  const cavitations = parseInt(document.getElementById(`cavitations${machineId}`)?.value) || 0;
  const cyclesPerMin = parseFloat(document.getElementById(`cycles${machineId}`)?.value) || 0;
  const piecesPerBox = parseInt(document.getElementById(`piecesPerBox${machineId}`)?.value) || 1;
  const boxesPerPallet = parseInt(document.getElementById(`boxesPerPallet${machineId}`)?.value) || 1;

  if (cavitations === 0 || cyclesPerMin === 0) {
    expectedEl.textContent = "0";
    diffEl.textContent = "—";
    unaccountedEl.textContent = "—";
    progressBar.style.width = "0%";
    progressText.textContent = "0%";
    return;
  }

  // Записанные простои (все)
  const totalDowntime = getTotalDowntimeAllForMachine(machineId);

  // Должно быть: (прошло_времени - простои) × такты × кавитации → штуки → паллеты/коробки
  const effectiveMinutes = Math.max(0, elapsedMinutes - totalDowntime);
  const expectedPieces = Math.floor(effectiveMinutes * cyclesPerMin * cavitations);
  const expectedPB = piecesToPalletsBoxes(expectedPieces, piecesPerBox, boxesPerPallet);
  expectedEl.textContent = formatPalletsBoxes(expectedPB.pallets, expectedPB.boxes);

  // Факт выпуска: паллеты + коробки → штуки (для расчётов)
  const factPallets = parseInt(stripSpaces(palletsInput.value)) || 0;
  const factBoxes = parseInt(stripSpaces(boxesInput.value)) || 0;
  const factPieces = factPallets * boxesPerPallet * piecesPerBox + factBoxes * piecesPerBox;

  // Разница: факт - расчёт (в штуках для точности, выводим в паллетах/коробках)
  const diffPieces = factPieces - expectedPieces;
  const diffPB = piecesToPalletsBoxes(Math.abs(diffPieces), piecesPerBox, boxesPerPallet);
  const diffSign = diffPieces >= 0 ? "+" : "-";
  diffEl.textContent = `${diffSign}${formatPalletsBoxes(diffPB.pallets, diffPB.boxes)}`;

  // Неучтённый простой (минуты)
  const piecesPerMin = cyclesPerMin * cavitations; // штук в минуту при полной работе
  let unaccountedMinutes = 0;
  if (diffPieces < 0 && piecesPerMin > 0) {
    unaccountedMinutes = Math.round(Math.abs(diffPieces) / piecesPerMin);
  }
  unaccountedEl.textContent = `${unaccountedMinutes} мин`;

  // Прогресс-бар: факт / должно_быть (в процентах)
  let percent = 0;
  if (expectedPieces > 0) {
    percent = Math.round((factPieces / expectedPieces) * 100);
  }
  progressBar.style.width = `${Math.min(percent, 100)}%`;
  progressText.textContent = `${percent}%`;

  // Цветовая индикация
  const balanceContainer = document.getElementById(`shiftBalance${machineId}`);
  if (!balanceContainer) return;
  balanceContainer.classList.remove("status-ok", "status-warning", "status-danger");

  if (factPieces === 0) {
    // Не ввели факт — нейтральный
    return;
  }

  const tolerance = Math.max(expectedPieces * 0.05, 1); // ±5%
  if (Math.abs(diffPieces) <= tolerance) {
    balanceContainer.classList.add("status-ok");
    diffEl.textContent += " ✔";
  } else if (diffPieces < -tolerance) {
    balanceContainer.classList.add("status-danger");
    warningRow.style.display = "flex";
  } else {
    balanceContainer.classList.add("status-warning");
    warningRow.style.display = "none";
  }
}

// Прошло времени с начала смены (минуты)
function getElapsedShiftMinutes() {
  const now = new Date();
  const hour = now.getHours();
  let shiftStart;

  if (hour >= 8 && hour < 20) {
    // Дневная: началась сегодня в 08:00
    shiftStart = new Date(now);
    shiftStart.setHours(8, 0, 0, 0);
  } else if (hour >= 20) {
    // Ночная (вечер): началась сегодня в 20:00
    shiftStart = new Date(now);
    shiftStart.setHours(20, 0, 0, 0);
  } else {
    // Ночная (утро): началась вчера в 20:00
    shiftStart = new Date(now);
    shiftStart.setDate(shiftStart.getDate() - 1);
    shiftStart.setHours(20, 0, 0, 0);
  }

  return Math.max(0, (now.getTime() - shiftStart.getTime()) / 60000);
}

// === Таймлайн смены ===
function renderTimeline(machineId) {
  const barEl = document.getElementById(`timelineBar${machineId}`);
  if (!barEl) return;

  // Загружаем простои из DOM (уже отрендерены в логе)
  const logContainer = document.getElementById(`downtimeLog${machineId}`);
  if (!logContainer) return;

  const entries = [];
  logContainer.querySelectorAll(".downtime-entry").forEach((el) => {
    const durationText = el.querySelector(".downtime-duration")?.textContent || "";
    const match = durationText.match(/(\d+)/);
    if (!match) return;

    // Извлекаем время из downtime-detail (первое HH:MM)
    const detailEl = el.querySelector(".downtime-detail");
    const timeMatch = detailEl?.textContent.match(/(\d{2}:\d{2})/);
    if (!timeMatch) return;

    const [h, m] = timeMatch[1].split(":").map(Number);
    entries.push({
      startMinutes: h * 60 + m,
      duration: parseInt(match[1]),
      type: el.querySelector(".downtime-type")?.textContent || "Простой",
    });
  });

  if (entries.length === 0) {
    barEl.innerHTML = `<div class="timeline-segment timeline-work" style="flex:1"></div>`;
    return;
  }

  // Сортируем по времени начала
  entries.sort((a, b) => a.startMinutes - b.startMinutes);

  // Начало и конец смены (минуты от полуночи)
  const elapsed = getElapsedShiftMinutes();
  let shiftStartMin;
  const hour = new Date().getHours();
  if (hour >= 8 && hour < 20) {
    shiftStartMin = 8 * 60; // 480
  } else if (hour >= 20) {
    shiftStartMin = 20 * 60; // 1200
  } else {
    shiftStartMin = 20 * 60 - 24 * 60; // вчера 20:00 → -360 (нормализуем)
    shiftStartMin = -480;
  }

  const currentMinutes = shiftStartMin + elapsed;

  // Строим сегменты: работа → простой → работа → ...
  let segments = [];
  let workStart = shiftStartMin;

  for (const entry of entries) {
    if (entry.startMinutes > currentMinutes) continue; // будущие — пропускаем

    // Сегмент работы до простоя
    const workDuration = entry.startMinutes - workStart;
    if (workDuration > 0) {
      segments.push({ type: "work", start: workStart, duration: workDuration });
    }
    // Сегмент простоя
    segments.push({ type: "downtime", start: entry.startMinutes, duration: entry.duration, label: entry.type });
    workStart = entry.startMinutes + entry.duration;
  }

  // Финальный сегмент работы (до текущего времени)
  const finalWorkDuration = currentMinutes - workStart;
  if (finalWorkDuration > 0) {
    segments.push({ type: "work", start: workStart, duration: finalWorkDuration });
  }

  if (segments.length === 0) return;

  // Рендер таймлайна
  const totalMinutes = currentMinutes - shiftStartMin;
  barEl.innerHTML = segments.map((seg) => {
    const pct = (seg.duration / totalMinutes * 100).toFixed(2);
    if (seg.type === "work") {
      return `<div class="timeline-segment timeline-work" style="flex:${seg.duration}" title="Работа ${seg.duration} мин"></div>`;
    } else {
      const colorClass = getDowntimeColorClass(seg.label);
      return `<div class="timeline-segment timeline-downtime ${colorClass}" style="flex:${seg.duration}" title="${seg.label}: ${seg.duration} мин"></div>`;
    }
  }).join("");

  // Тултипы на сегментах уже содержат всю информацию (длительность, тип)
}

function getDowntimeColorClass(typeName) {
  if (typeName.includes("ролик")) return "color-roller";
  if (typeName.includes("брак") || typeName.includes("дробилка")) return "color-scrap";
  if (typeName.includes("поломка")) return "color-breakdown";
  if (typeName.includes("настройка")) return "color-setup";
  return "color-default";
}

// Аккордеон лога простоев
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".downtime-accordion-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      const machineId = this.dataset.machine;
      const content = document.getElementById(`downtimeAccordion${machineId}`);
      if (content) {
        content.classList.toggle("collapsed");
        this.textContent = content.classList.contains("collapsed") ? "⏱ Простои ▾" : "⏱ Простои ▴";
      }
    });
  });
});

// Форма калькулятора ленты
function setupTapeForm() {
  const form = document.getElementById("tapeForm");
  if (!form) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    calculateTape();
  });

  form.addEventListener("reset", function () {
    setTimeout(() => {
      // Скрыть все результаты
      document.getElementById("tapeResults").style.display = "none";
      document.getElementById("forwardResults").style.display = "none";
      document.getElementById("reverseResults").style.display = "none";
      document.getElementById("droblenkaCard").style.display = "none";
      document.getElementById("rollWeightCard").style.display = "none";
      // Обнулить значения
      document.getElementById("tapeNeeded").textContent = "0";
      document.getElementById("tapePlus10").textContent = "0";
      document.getElementById("piecesPossible").textContent = "0";
      document.getElementById("droblenkaValue").textContent = "0";
      document.getElementById("rollWeightValue").textContent = "0";
    }, 10);
  });

  // Автоформатирование поля «Требуемое количество изделий»
  const requiredPiecesInput = document.getElementById("requiredPieces");
  if (requiredPiecesInput) {
    requiredPiecesInput.addEventListener("input", () => {
      formatInputValue(requiredPiecesInput);
    });
  }
}

// Окно добавления продукта
function setupReferencePanel() {
  const addBtn = document.getElementById("addProductBtn");
  const modal = document.getElementById("addProductModal");
  const closeBtn = document.getElementById("closeModal");
  const cancelBtn = document.getElementById("cancelAdd");
  const form = document.getElementById("addProductForm");

  if (addBtn) {
    addBtn.addEventListener("click", () => (modal.style.display = "flex"));
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => (modal.style.display = "none"));
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      modal.style.display = "none";
      form.reset();
    });
  }

  // Закрытие модального окна при клике на оверлей
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal) {
        modal.style.display = "none";
        form.reset();
      }
    });
  }

  if (form) {
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const name = document.getElementById("newProductName").value.trim();
      if (!name) {
        showNotification("Введите наименование", "error");
        return;
      }

      const productData = {
        name: name,
        cavitations: parseInt(document.getElementById("newCavitations").value),
        cycles_per_minute: parseFloat(
          document.getElementById("newCycles").value,
        ),
        pieces_per_box: parseInt(
          document.getElementById("newPiecesPerBox").value,
        ),
        boxes_per_pallet: parseInt(
          document.getElementById("newBoxesPerPallet").value,
        ),
      };

      try {
        const response = await customFetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(productData),
        });

        const result = await response.json();
        if (result.success) {
          await loadProductCache();
          loadProductList();
          showNotification(`"${name}" добавлен в справочник`, "success");
          modal.style.display = "none";
          form.reset();
        }
      } catch (error) {
        showNotification("Ошибка сохранения", "error");
      }
    });
  }
}

async function loadProductList() {
  const list = document.getElementById("productList");
  if (!list) return;

  try {
    await loadProductCache();
  } catch (e) {
    /* ignore */
  }

  if (productCache.length === 0) {
    list.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📦</div>
                <p>Справочник пуст</p>
                <p style="font-size: 0.8rem; margin-top: 4px;">Добавьте первый продукт</p>
            </div>
        `;
    return;
  }

  list.innerHTML = productCache
    .map(
      (p) => `
        <div class="product-item">
            <div class="product-info">
                <div class="product-name">${escapeHtml(p.name)}</div>
                <div class="product-details">
                    ${p.cavitations} кавит. · ${p.cycles_per_minute} такт/мин · ${p.pieces_per_box} шт/кор · ${p.boxes_per_pallet} кор/палл
                </div>
            </div>
            <button class="btn btn-danger" onclick="deleteProductFromRef(${p.id})" title="Удалить">✕</button>
        </div>
    `,
    )
    .join("");
}

// Загрузка начальных данных
async function loadInitialData() {
  for (let i = 1; i <= 7; i++) {
    await loadMachineProduct(i);
    await loadDowntimeLog(i);
    updateAvailableTime(i);
  }
}

async function loadMachineProduct(machineId) {
  let product = null;

  // Пытаемся загрузить с сервера
  try {
    const response = await customFetch(`/api/machine/${machineId}/product`);
    product = await response.json();
  } catch (error) {
    console.warn(`[offline] Не удалось загрузить продукт для М-${machineId}, использую кэш`);
  }

  // Если сервер недоступен или ошибка — берём из localStorage
  if (!product || product.error) {
    const cachedMap = getCachedMachineProducts();
    product = cachedMap[String(machineId)] || null;
    if (!product) {
      clearForm(machineId);
      return;
    }
  }

  // Сохраняем в кэш (при успехе с сервера обновляем)
  if (!product.error) {
    const cachedMap = getCachedMachineProducts();
    cachedMap[String(machineId)] = product;
    setCachedMachineProducts(cachedMap);
  }

  document.getElementById(`productName${machineId}`).value = product.name;
  document.getElementById(`cavitations${machineId}`).value =
    product.cavitations;
  document.getElementById(`cycles${machineId}`).value =
    product.cycles_per_minute;
  document.getElementById(`piecesPerBox${machineId}`).value =
    product.pieces_per_box;
  document.getElementById(`boxesPerPallet${machineId}`).value =
    product.boxes_per_pallet;

  updateShiftOutput(machineId);
  updateHourlyRate(machineId);
  calculateShiftBalance(machineId);
  renderTimeline(machineId);
}

function clearForm(machineId) {
  document.getElementById(`productName${machineId}`).value = "";
  document.getElementById(`cavitations${machineId}`).value = "1";
  document.getElementById(`cycles${machineId}`).value = "";
  document.getElementById(`piecesPerBox${machineId}`).value = "1";
  document.getElementById(`boxesPerPallet${machineId}`).value = "1";
  updateShiftOutput(machineId);
  updateHourlyRate(machineId);
}

// Сохранение продукта
async function saveProduct(machineId) {
  const name = document.getElementById(`productName${machineId}`).value.trim();
  if (!name) {
    showNotification("Введите наименование продукции", "error");
    return;
  }

  const productData = {
    name: name,
    machine_id: machineId,
    cavitations: parseInt(
      document.getElementById(`cavitations${machineId}`).value,
    ),
    cycles_per_minute: parseFloat(
      document.getElementById(`cycles${machineId}`).value,
    ),
    pieces_per_box: parseInt(
      document.getElementById(`piecesPerBox${machineId}`).value,
    ),
    boxes_per_pallet: parseInt(
      document.getElementById(`boxesPerPallet${machineId}`).value,
    ),
  };

  try {
    const response = await customFetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(productData),
    });

    const result = await response.json();
    if (result.success) {
      // Обновляем кэш machine→product
      const cachedMap = getCachedMachineProducts();
      cachedMap[String(machineId)] = productData;
      setCachedMachineProducts(cachedMap);

      try {
        await customFetch(`/api/machine/${machineId}/product`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: result.id }),
        });
      } catch {
        // Офлайн — mapping обновится при синхронизации
      }

      await loadProductCache();
      const action = result.updated ? "обновлены" : "сохранены";
      showNotification(`Данные "${name}" ${action}`, "success");
      updateShiftOutput(machineId);
      updateHourlyRate(machineId);
    }
  } catch (error) {
    // Офлайн-режим: сохраняем в кэш и показываем предупреждение
    console.warn("[offline] Сохранение в очередь, сервер недоступен");
    const cachedMap = getCachedMachineProducts();
    cachedMap[String(machineId)] = productData;
    setCachedMachineProducts(cachedMap);
    showNotification(`"${name}" сохранён офлайн`, "info");
    updateShiftOutput(machineId);
    updateHourlyRate(machineId);
  }
}

/**
 * Клиентский расчёт выпуска до конца смены.
 * Дублирует логику серверного calculate_production() из app.py.
 * Работает полностью офлайн.
 */
function calculateProduction(machineId) {
  const cavitations = parseInt(document.getElementById(`cavitations${machineId}`).value) || 0;
  const cyclesPerMin = parseFloat(document.getElementById(`cycles${machineId}`).value) || 0;
  const piecesPerBox = parseInt(document.getElementById(`piecesPerBox${machineId}`).value) || 1;
  const boxesPerPallet = parseInt(document.getElementById(`boxesPerPallet${machineId}`).value) || 1;

  if (cavitations <= 0 || cyclesPerMin <= 0) {
    document.getElementById(`pallets${machineId}`).textContent = "0";
    document.getElementById(`boxes${machineId}`).textContent = "0";
    document.getElementById(`pieces${machineId}`).textContent = "0";
    return;
  }

  // Определяем оставшееся время до конца смены (дублирует get_current_shift из app.py)
  const remainingMinutes = getRemainingShiftMinutes();
  if (remainingMinutes <= 0) {
    document.getElementById(`pallets${machineId}`).textContent = "0";
    document.getElementById(`boxes${machineId}`).textContent = "0";
    document.getElementById(`pieces${machineId}`).textContent = "0";
    return;
  }

  // Вычитаем все простои за смену (и прошедшие, и будущие)
  const totalDowntime = getTotalDowntimeAllForMachine(machineId);
  const effectiveTime = Math.max(0, remainingMinutes - totalDowntime);

  // Формула: pieces = time * cycles_per_min * cavitations
  const totalPieces = effectiveTime * cyclesPerMin * cavitations;
  const totalBoxes = totalPieces / piecesPerBox;
  const totalPallets = totalBoxes / boxesPerPallet;

  const fullPallets = Math.floor(totalPallets);
  const remainingBoxes = Math.floor(totalBoxes) - (fullPallets * boxesPerPallet);

  document.getElementById(`pallets${machineId}`).textContent = fullPallets;
  document.getElementById(`boxes${machineId}`).textContent = Math.max(0, remainingBoxes);
  document.getElementById(`pieces${machineId}`).textContent = Math.floor(totalPieces);

  // Показать результаты
  const resultsPanel = document.getElementById(`results${machineId}`);
  if (resultsPanel) resultsPanel.style.display = "grid";

  updateAvailableTime(machineId);
}

/**
 * Оставшиеся минуты до конца смены (с учётом -10 мин смещения).
 * Дублирует get_current_shift() из app.py.
 * День: 8:00–20:00, Ночь: 20:00–8:00
 */
function getRemainingShiftMinutes() {
  const now = new Date();
  const hour = now.getHours();
  let targetEnd;

  if (hour >= 8 && hour < 20) {
    // Дневная смена → конец сегодня в 20:00
    targetEnd = new Date(now);
    targetEnd.setHours(20, 0, 0, 0);
  } else if (hour >= 20) {
    // Ночная смена (вечер) → конец завтра в 8:00
    targetEnd = new Date(now);
    targetEnd.setDate(targetEnd.getDate() + 1);
    targetEnd.setHours(8, 0, 0, 0);
  } else {
    // Ночная смена (утро) → конец сегодня в 8:00
    targetEnd = new Date(now);
    targetEnd.setHours(8, 0, 0, 0);
  }

  const diffMs = targetEnd.getTime() - now.getTime();
  // -10 минут как в серверном коде
  return Math.max(0, Math.floor(diffMs / 60000) - 10);
}

function resetCalculator(machineId) {
  clearForm(machineId);
  document.getElementById(`pallets${machineId}`).textContent = "0";
  document.getElementById(`boxes${machineId}`).textContent = "0";
  document.getElementById(`pieces${machineId}`).textContent = "0";
  const resultsPanel = document.getElementById(`results${machineId}`);
  if (resultsPanel) resultsPanel.style.display = "none";
  updateAvailableTime(machineId);
  showNotification("Калькулятор сброшен", "success");
}

// Получение общего времени простоя для машины (только БУДУЩИЕ простои)
function getTotalDowntimeForMachine(machineId) {
  const logContainer = document.getElementById(`downtimeLog${machineId}`);
  if (!logContainer) return 0;

  // Считаем только простои с timestamp >= сейчас (будущие)
  const entries = logContainer.querySelectorAll(
    '.downtime-entry[data-future="true"] .downtime-duration',
  );
  let total = 0;
  entries.forEach((el) => {
    const text = el.textContent;
    const match = text.match(/(\d+)/);
    if (match) total += parseInt(match[1]);
  });
  return total;
}

// Получение ВСЕГО времени простоя за смену (и прошедшие, и будущие)
function getTotalDowntimeAllForMachine(machineId) {
  const logContainer = document.getElementById(`downtimeLog${machineId}`);
  if (!logContainer) return 0;

  const entries = logContainer.querySelectorAll(".downtime-duration");
  let total = 0;
  entries.forEach((el) => {
    const text = el.textContent;
    const match = text.match(/(\d+)/);
    if (match) total += parseInt(match[1]);
  });
  return total;
}

async function logDowntime(machineId) {
  const downtimeType = document.getElementById(
    `downtimeType${machineId}`,
  ).value;
  let duration = 0;

  // Фиксированные типы
  const fixedDurations = { roller_7: 7, roller_15: 15 };

  if (fixedDurations[downtimeType] !== undefined) {
    duration = fixedDurations[downtimeType];
  } else {
    // Все остальные — ручной ввод
    duration = parseInt(
      document.getElementById(`downtimeDuration${machineId}`).value,
    );
    if (!duration || duration <= 0) {
      showNotification("Укажите длительность простоя", "error");
      return;
    }
  }

  const note = document.getElementById(`downtimeNote${machineId}`).value;

  const downtimeData = {
    machine_id: machineId,
    downtime_type: downtimeType,
    duration_minutes: duration,
    note: note,
  };

  try {
    const response = await customFetch("/api/downtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(downtimeData),
    });

    const result = await response.json();
    if (result.success) {
      showNotification("Простой добавлен", "success");
      document.getElementById(`downtimeNote${machineId}`).value = "";
      await loadDowntimeLog(machineId);
      updateAvailableTime(machineId);
      calculateShiftBalance(machineId);
      renderTimeline(machineId);
    }
  } catch (error) {
    // Офлайн-режим: добавляем в локальный кэш
    console.warn("[offline] Простой сохранён офлайн");
    const offlineEntry = {
      id: Date.now(),
      downtime_type: downtimeType,
      duration_minutes: duration,
      note: note,
      timestamp: new Date().toISOString(),
      is_future: true,
    };
    const cachedAll = getCachedDowntimes();
    if (!cachedAll[String(machineId)]) {
      cachedAll[String(machineId)] = [];
    }
    cachedAll[String(machineId)].push(offlineEntry);
    setCachedDowntimes(cachedAll);

    document.getElementById(`downtimeNote${machineId}`).value = "";
    renderDowntimeLog(machineId, cachedAll[String(machineId)]);
    updateAvailableTime(machineId);
    calculateShiftBalance(machineId);
    renderTimeline(machineId);
    showNotification("Простой добавлен офлайн", "info");
  }
}

/** Рендер списка простоев в DOM */
function renderDowntimeLog(machineId, downtimes) {
  const logContainer = document.getElementById(`downtimeLog${machineId}`);
  if (!logContainer) return;

  if (downtimes.length === 0) {
    logContainer.innerHTML =
      '<div class="empty-state" style="padding: 20px;"><p style="font-size: 0.85rem; color: var(--text-muted);">Нет записей</p></div>';
    updateAvailableTime(machineId);
    return;
  }

  const typeNames = {
    roller_7: "Замена ролика (7 мин)",
    roller_15: "Замена ролика (15 мин)",
    scrap_tape: "Брак ленты / дробилка",
    breakdown: "Поломка",
    setup: "Настройка / дробилка",
    custom: "Произвольный",
  };

  logContainer.innerHTML = downtimes
    .map((d) => {
      const time = new Date(d.timestamp).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const isFuture = d.is_future === true;
      return `
              <div class="downtime-entry" data-future="${isFuture}">
                  <div class="downtime-info">
                      <span class="downtime-type">${typeNames[d.downtime_type] || d.downtime_type}</span>
                      <span class="downtime-detail">${time}${d.note ? " · " + escapeHtml(d.note) : ""}${!isFuture ? " <em class='past-badge'>(прошедший)</em>" : ""}</span>
                  </div>
                  <span class="downtime-duration">${d.duration_minutes} мин</span>
                  <button class="btn btn-danger" onclick="deleteDowntime(${machineId}, ${d.id})" title="Удалить">✕</button>
              </div>
          `;
    })
    .join("");

  updateAvailableTime(machineId);
}

async function loadDowntimeLog(machineId) {
  let downtimes = null;

  // Сначала загружаем из localStorage (мгновенно, работает офлайн)
  const cachedAll = getCachedDowntimes();
  const cached = cachedAll[String(machineId)] || [];
  if (cached.length > 0) {
    renderDowntimeLog(machineId, cached);
  }

  // Затем пытаемся обновить с сервера
  try {
    const response = await customFetch(`/api/downtime/machine/${machineId}`);
    downtimes = await response.json();
    // Всегда обновляем кэш и рендер — даже при пустом ответе (сброс после смены)
    const cachedAll = getCachedDowntimes();
    cachedAll[String(machineId)] = downtimes;
    setCachedDowntimes(cachedAll);
    renderDowntimeLog(machineId, downtimes);
  } catch (error) {
    console.warn(`[offline] Отчет простоев М-${machineId} не обновлён, использую кэш`)
    // Уже отрендерен из localStorage выше
  }
}

// === Расчёт веса рулона ===
// ПП (обычная): заводская Excel-формула, D_шпули = 18 см
//   вес = ((t×2 + 18)² - 324) × w / 1413
// ПП (железная шпуля): D_шпули = 16 см
//   вес = ((t×2 + 16)² - 256) × w / 1413
// ПЭТ (шпуля 17 см):
//   вес = π × ((t + 8.5)² - 72.25) × w × 0.00552
// t — толщина намотки от края втулки до внешнего края рулона (см)

function getSelectedTapeType() {
  const isPet = document.getElementById("isPetTape").checked;
  return isPet ? "pet" : "pp";
}

function getIronSpoolChecked() {
  const ironSpool = document.getElementById("isIronSpool");
  return ironSpool ? ironSpool.checked : false;
}

function calculateRollWeight(thicknessCm, widthCm, tapeType = "pp") {
  if (!thicknessCm || !widthCm || thicknessCm <= 0 || widthCm <= 0) {
    return null;
  }

  let weightKg;
  const ironSpool = getIronSpoolChecked();

  if (tapeType === "pp" && !ironSpool) {
    // Заводская формула из Excel для ПП (D_шпули = 18 см)
    const outerDiameterSquared = Math.pow(thicknessCm * 2 + 18, 2);
    const netVolumeFactor = outerDiameterSquared - 324; // 324 = 18²
    weightKg = (netVolumeFactor * widthCm) / 1413;
  } else if (tapeType === "pp" && ironSpool) {
    // ПП с железной шпулей: D_шпули = 16 см
    const outerDiameterSquared = Math.pow(thicknessCm * 2 + 16, 2);
    const netVolumeFactor = outerDiameterSquared - 256; // 256 = 16²
    weightKg = (netVolumeFactor * widthCm) / 1413;
  } else {
    // ПЭТ (шпуля 17 см)
    // HACK: нужно протестировать расчеты, Максим Б. сказал что плотность ПЭТ лучше считать по 0,00140
    weightKg =
      Math.PI * (Math.pow(thicknessCm + 8.5, 2) - 72.25) * widthCm * 0.00131;
  }

  return parseFloat(weightKg.toFixed(2));
}

// Калькулятор ленты
async function calculateTape() {
  const avgWeight = parseFloat(document.getElementById("avgWeight").value);
  const wastePercent = parseFloat(
    document.getElementById("wastePercent").value,
  );
  const requiredPieces = parseInt(stripSpaces(document.getElementById("requiredPieces").value));
  const tapeAvailable = parseFloat(
    document.getElementById("tapeAvailable").value,
  );

  const thicknessCm = parseFloat(document.getElementById("outerRadius").value);
  const widthCm = parseFloat(document.getElementById("tapeWidth").value);

  const hasPieces = requiredPieces && requiredPieces > 0;
  const hasTape = tapeAvailable && tapeAvailable > 0;
  const hasRollDims = thicknessCm && thicknessCm > 0 && widthCm && widthCm > 0;

  // Если заполнены только толщина/ширина — режим расчёта веса рулона
  if (
    !avgWeight &&
    isNaN(wastePercent) &&
    !hasPieces &&
    !hasTape &&
    hasRollDims
  ) {
    const tapeType = getSelectedTapeType();
    const rollWeight = calculateRollWeight(thicknessCm, widthCm, tapeType);
    if (rollWeight !== null) {
      document.getElementById("rollWeightValue").textContent =
        rollWeight.toLocaleString("ru-RU", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      document.getElementById("rollWeightCard").style.display = "block";
    }
    document.getElementById("forwardResults").style.display = "none";
    document.getElementById("reverseResults").style.display = "none";
    document.getElementById("droblenkaCard").style.display = "none";
    document.getElementById("tapeResults").style.display = "grid";
    showNotification("Расчет веса рулона выполнен", "success");
    return;
  }

  // Обычный режим: нужен вес, отходность и одно из (изделия / лента)
  if (!avgWeight || isNaN(wastePercent)) {
    showNotification("Заполните вес и отходность", "error");
    return;
  }
  if (!hasPieces && !hasTape) {
    showNotification("Введите количество изделий или доступную ленту", "error");
    return;
  }
  if (hasPieces && hasTape) {
    showNotification("Заполни что то одно дубина!", "error");
    return;
  }

  try {
    const payload = {
      avg_weight: avgWeight,
      waste_percent: wastePercent,
    };

    if (hasPieces) {
      payload.required_pieces = requiredPieces;
    } else {
      payload.tape_available = tapeAvailable;
    }

    const response = await customFetch("/api/tape-calculation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    const forwardEl = document.getElementById("forwardResults");
    const reverseEl = document.getElementById("reverseResults");

    if (hasPieces) {
      // Прямой расчёт: изделия → лента
      document.getElementById("tapeNeeded").textContent =
        result.tape_needed.toLocaleString("ru-RU");
      document.getElementById("tapePlus10").textContent =
        result.tape_plus_10.toLocaleString("ru-RU");
      forwardEl.style.display = "block";
      reverseEl.style.display = "none";
    } else {
      // Обратный расчёт: лента → изделия
      document.getElementById("piecesPossible").textContent =
        result.pieces_possible.toLocaleString("ru-RU");
      forwardEl.style.display = "none";
      reverseEl.style.display = "block";
    }
    // Общий отход / дроблёнка
    document.getElementById("droblenkaValue").textContent =
      result.droblenka_output.toLocaleString("ru-RU");
    document.getElementById("droblenkaCard").style.display = "block";

    // Вес рулона (если заполнены толщина намотки и ширина)
    const tapeType = getSelectedTapeType();
    const rollWeight = calculateRollWeight(thicknessCm, widthCm, tapeType);
    if (rollWeight !== null) {
      document.getElementById("rollWeightValue").textContent =
        rollWeight.toLocaleString("ru-RU", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      document.getElementById("rollWeightCard").style.display = "block";
    } else {
      document.getElementById("rollWeightCard").style.display = "none";
    }

    document.getElementById("tapeResults").style.display = "grid";
    showNotification("Расчет выполнен", "success");
  } catch (error) {
    showNotification("Ошибка расчета", "error");
  }
}

//
function showNotification(message, type = "info") {
  document.querySelectorAll(".notification").forEach((n) => n.remove());

  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  requestAnimationFrame(() => notification.classList.add("show"));

  setTimeout(() => {
    notification.classList.remove("show");
    setTimeout(() => notification.remove(), 400);
  }, 2500);
}

// ==================== GLOBAL FUNCTIONS ====================
window.deleteDowntime = async function (machineId, downtimeId) {
  if (!confirm("Удалить эту запись о простое?")) return;

  try {
    const response = await customFetch(`/api/downtime/${downtimeId}`, {
      method: "DELETE",
    });
    const result = await response.json();

    if (result.success) {
      showNotification("Запись удалена", "success");
      await loadDowntimeLog(machineId);
      updateAvailableTime(machineId);
    }
  } catch (error) {
    // Офлайн: удаляем из локального кэша
    console.warn("[offline] Удаление простоя офлайн");
    const cachedAll = getCachedDowntimes();
    if (cachedAll[String(machineId)]) {
      cachedAll[String(machineId)] = cachedAll[String(machineId)].filter(
        (d) => d.id !== downtimeId,
      );
      setCachedDowntimes(cachedAll);
      renderDowntimeLog(machineId, cachedAll[String(machineId)]);
      updateAvailableTime(machineId);
    }
    showNotification("Запись удалена офлайн", "info");
  }
};

window.deleteProductFromRef = async function (productId) {
  if (!confirm("Удалить этот продукт из справочника?")) return;

  try {
    const response = await customFetch(`/api/products/${productId}`, {
      method: "DELETE",
    });
    const result = await response.json();

    if (result.success) {
      await loadProductCache();
      loadProductList();
      showNotification("Продукт удалён", "success");
    } else {
      showNotification(result.error || "Ошибка удаления", "error");
    }
  } catch (error) {
    // Офлайн: удаляем из локального кэша
    console.warn("[offline] Удаление продукта офлайн");
    const cached = getCachedProducts();
    productCache = cached.filter((p) => p.id !== productId);
    setCachedProducts(productCache);
    loadProductList();
    showNotification("Продукт удалён офлайн", "info");
  }
};

window.resetDatabase = async function () {
  if (!confirm("ВНИМАНИЕ! Это удалит ВСЕ данные. Продолжить?")) return;
  if (!confirm("Точно удалить все данные? Это действие нельзя отменить."))
    return;

  try {
    const response = await customFetch("/api/reset-database", {
      method: "POST",
    });
    const result = await response.json();

    if (result.success) {
      showNotification("База данных очищена", "success");
      setTimeout(() => location.reload(), 1000);
    } else {
      showNotification(
        "Ошибка: " + (result.error || "Неизвестная ошибка"),
        "error",
      );
    }
  } catch (error) {
    showNotification("Ошибка подключения к серверу", "error");
  }
};

// Убрать пробелы из строки перед парсингом числа
function stripSpaces(str) {
  return str.replace(/\s/g, "");
}

// Форматировать число в поле ввода с сохранением позиции курсора
function formatInputValue(input) {
  const cursorPos = input.selectionStart;
  const raw = stripSpaces(input.value);
  if (!raw || raw === "-") return;

  const num = parseFloat(raw);
  if (isNaN(num)) return;

  const isNegative = raw.startsWith("-");
  const formatted = Math.abs(num).toLocaleString("ru-RU").replace(/\s/g, " ");
  input.value = isNegative ? "-" + formatted : formatted;

  // Восстановить позицию курсора (с учётом добавленных пробелов)
  const digitsBefore = raw.substring(0, cursorPos).replace(/[^0-9]/g, "").length;
  let newPos = 0;
  let digitCount = 0;
  for (let i = 0; i < input.value.length; i++) {
    if (input.value[i] >= "0" && input.value[i] <= "9") {
      digitCount++;
    }
    newPos = i + 1;
    if (digitCount === digitsBefore) break;
  }
  input.setSelectionRange(newPos, newPos);
}

// Калькулятор изделий
function setupItemsCalculator() {
  const totalOrderInput = document.getElementById("totalOrder");
  const remainingInput = document.getElementById("remainingItems");
  const itemsPerBoxInput = document.getElementById("itemsPerBox");
  const boxesPerPalletInput = document.getElementById("boxesPerPallet");

  // Форматирование числа с пробелами-разделителями: 1000000 -> 1 000 000
  function formatNumber(num) {
    return num.toLocaleString("ru-RU").replace(/\s/g, " ");
  }

  // Конвертировать штуки в паллеты + коробки
  function toPalletsBoxes(totalPieces, itemsPerBox, boxesPerPallet) {
    const totalBoxes = Math.floor(totalPieces / itemsPerBox);
    const fullPallets = Math.floor(totalBoxes / boxesPerPallet);
    const leftoverBoxes = totalBoxes - fullPallets * boxesPerPallet;
    return { pallets: fullPallets, boxes: leftoverBoxes };
  }

  function updateItemsCalc() {
    const totalOrder = parseFloat(stripSpaces(totalOrderInput.value)) || 0;
    const remainingRaw = stripSpaces(remainingInput.value.trim());
    const itemsPerBox = parseInt(itemsPerBoxInput.value) || 0;
    const boxesPerPallet = parseInt(boxesPerPalletInput.value) || 0;

    // Если поле «осталось» пустое — считаем от всего заказа
    const remainingIsEmpty = remainingRaw === "";
    const remaining = parseFloat(remainingRaw) || 0;

    const fivePercent = Math.round(totalOrder * 0.05);

    let baseRemaining, remainingPlusFive, remainingMinusFive;

    if (remainingIsEmpty) {
      // Не ввели «осталось» — считаем от всего заказа
      baseRemaining = totalOrder;
      remainingPlusFive = totalOrder + fivePercent;
      remainingMinusFive = Math.max(0, totalOrder - fivePercent);
    } else if (remaining < 0) {
      // Осталось доделать |remaining| штук (например -1000)
      baseRemaining = Math.abs(remaining);
      remainingPlusFive = baseRemaining + fivePercent;
      remainingMinusFive = Math.max(0, baseRemaining - fivePercent);
    } else {
      // Заказ выполнен + сверх (remaining штук сверх заказа)
      baseRemaining = 0;
      remainingPlusFive = Math.max(0, fivePercent - remaining);
      remainingMinusFive = 0;
    }

    document.getElementById("fivePercent").textContent =
      formatNumber(fivePercent);
    document.getElementById("remainingPlusFive").textContent =
      formatNumber(remainingPlusFive);
    document.getElementById("remainingMinusFive").textContent =
      formatNumber(remainingMinusFive);

    // Если заполнены оба поля упаковки — показываем разбивку по паллетам/коробкам
    const hasPackingData = itemsPerBox > 0 && boxesPerPallet > 0;

    const plusSection = document.getElementById("palletResults");
    const minusSection = document.getElementById("palletResultsMinus");
    const baseSection = document.getElementById("palletResultsBase");

    if (hasPackingData) {
      plusSection.style.display = "block";
      minusSection.style.display = "block";
      baseSection.style.display = "block";

      // Базовый остаток
      const baseBreakdown = toPalletsBoxes(
        baseRemaining,
        itemsPerBox,
        boxesPerPallet,
      );
      document.getElementById("basePallets").textContent = formatNumber(
        baseBreakdown.pallets,
      );
      document.getElementById("baseBoxes").textContent = formatNumber(
        baseBreakdown.boxes,
      );

      const plusBreakdown = toPalletsBoxes(
        remainingPlusFive,
        itemsPerBox,
        boxesPerPallet,
      );
      document.getElementById("plusFivePallets").textContent = formatNumber(
        plusBreakdown.pallets,
      );
      document.getElementById("plusFiveBoxes").textContent = formatNumber(
        plusBreakdown.boxes,
      );

      const minusBreakdown = toPalletsBoxes(
        remainingMinusFive,
        itemsPerBox,
        boxesPerPallet,
      );
      document.getElementById("minusFivePallets").textContent = formatNumber(
        minusBreakdown.pallets,
      );
      document.getElementById("minusFiveBoxes").textContent = formatNumber(
        minusBreakdown.boxes,
      );
    } else {
      plusSection.style.display = "none";
      minusSection.style.display = "none";
    }
  }

  if (totalOrderInput) {
    totalOrderInput.addEventListener("input", () => {
      formatInputValue(totalOrderInput);
      updateItemsCalc();
    });
  }
  if (remainingInput) {
    remainingInput.addEventListener("input", () => {
      formatInputValue(remainingInput);
      updateItemsCalc();
    });
  }
  if (itemsPerBoxInput) {
    itemsPerBoxInput.addEventListener("input", updateItemsCalc);
  }
  if (boxesPerPalletInput) {
    boxesPerPalletInput.addEventListener("input", updateItemsCalc);
  }
}

// Pull-to-Refresh
document.addEventListener("DOMContentLoaded", () => {
  // Показываем тост после успешного обновления
  if (sessionStorage.getItem("ptr_refreshed") === "true") {
    sessionStorage.removeItem("ptr_refreshed");
    setTimeout(() => showNotification("✓ Обновлено", "success"), 400);
  }

  const ptrOverlay = document.getElementById("ptrOverlay");
  const pullHint = document.getElementById("pullHint");
  if (!ptrOverlay) return;

  // Текстовый элемент внутри оверлея
  const ptrText = ptrOverlay.querySelector("span");

  let startY = 0;
  let pulling = false;
  let refreshing = false;
  const THRESHOLD = 100;

  document.addEventListener(
    "touchstart",
    (e) => {
      if (window.scrollY > 0 || refreshing) return;
      startY = e.touches[0].clientY;
      pulling = true;
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!pulling || window.scrollY > 0 || refreshing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 20) {
        ptrOverlay.classList.add("active");
        ptrOverlay.style.height = Math.min(dy, 80) + "px";
        if (pullHint) pullHint.classList.add("hidden");

        // Меняем текст в зависимости от прогресса
        if (dy >= THRESHOLD && ptrText) {
          ptrText.textContent = "Отпустите для обновления";
          ptrOverlay.classList.add("ready");
        } else if (ptrText) {
          ptrText.textContent = "Потяните ↓";
          ptrOverlay.classList.remove("ready");
        }
      }
    },
    { passive: true },
  );

  document.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    const currentHeight = parseInt(ptrOverlay.style.height) || 0;
    if (currentHeight >= THRESHOLD) {
      // Фаза обновления: спиннер + текст
      refreshing = true;
      ptrOverlay.classList.add("active");
      ptrOverlay.classList.remove("ready");
      ptrOverlay.style.height = "48px";
      if (ptrText) ptrText.textContent = "Обновление…";

      // Запоминаем и перезагружаем
      sessionStorage.setItem("ptr_refreshed", "true");
      window.location.reload();
    } else {
      // Не дотянули — плавно скрываем
      ptrOverlay.classList.remove("active");
      ptrOverlay.classList.remove("ready");
      ptrOverlay.style.height = "0";
      if (ptrText) ptrText.textContent = "Обновление…";
      if (pullHint) pullHint.classList.remove("hidden");
    }
  });
});

// ==================== DOWNTIME REPORT ====================

// Открыть вкладку отчета
async function openReportTab(machineId) {
  // Переключить на вкладку отчета
  const reportTab = document.getElementById("downtime-report");

  // Убрать active со всех вкладок
  document
    .querySelectorAll(".tab-btn")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelectorAll(".tab-content")
    .forEach((c) => c.classList.remove("active"));

  // Активировать вкладку отчета
  if (reportTab) reportTab.classList.add("active");

  // Загрузить и показать отчет
  await loadReportData(machineId);
}

// Загрузить данные отчета
async function loadReportData(machineId) {
  const reportTitle = document.getElementById("reportTitle");
  const reportSummary = document.getElementById("reportSummaryBadge");
  const reportContent = document.getElementById("reportContent");
  const reportEmpty = document.getElementById("reportEmpty");
  const tableBody = document.getElementById("reportTableBody");

  // Показать заголовок с машиной
  reportTitle.textContent = `📊 Отчет простоев — М-${machineId}`;

  // Показать контент
  reportContent.style.display = "block";

  // Загрузить данные
  try {
    const response = await customFetch(`/api/downtime/machine/${machineId}`);
    const downtimes = await response.json();

    if (!downtimes || downtimes.length === 0) {
      tableBody.innerHTML = "";
      reportEmpty.style.display = "block";
      reportSummary.textContent = "Всего: 0 мин";
      return;
    }

    reportEmpty.style.display = "none";

    // Рассчитать общее время
    const totalMinutes = downtimes.reduce(
      (sum, d) => sum + d.duration_minutes,
      0,
    );
    reportSummary.textContent = `Всего: ${totalMinutes} мин`;

    // Сформировать таблицу
    const typeNames = {
      roller_7: "Замена ролика (7 мин)",
      roller_15: "Замена ролика (15 мин)",
      scrap_tape: "Брак ленты / дробилка",
      breakdown: "Поломка",
      setup: "Настройка / дробилка",
      custom: "Произвольный",
    };

    tableBody.innerHTML = downtimes
      .map((d) => {
        const time = new Date(d.timestamp).toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const typeName = typeNames[d.downtime_type] || d.downtime_type;
        return `
                    <tr>
                        <td>${time}</td>
                        <td>${escapeHtml(typeName)}</td>
                        <td class="duration-cell">${d.duration_minutes} мин</td>
                        <td class="note-cell">${escapeHtml(d.note || "")}</td>
                    </tr>
                `;
      })
      .join("");
  } catch (error) {
    console.error("Ошибка загрузки отчета:", error);
    reportEmpty.style.display = "block";
    reportEmpty.innerHTML = `
            <div class="empty-icon">⚠️</div>
            <p>Ошибка загрузки данных</p>
        `;
  }
}

// ==================== COPY DOWNTIME REPORT ====================

window.copyDowntimeReport = async function (machineId) {
  try {
    const response = await customFetch(`/api/downtime/machine/${machineId}`);
    const downtimes = await response.json();

    if (!downtimes || downtimes.length === 0) {
      showNotification("Нет записей для копирования", "info");
      return;
    }

    // Формируем текстовый отчёт
    const now = new Date();
    const dateStr = now.toLocaleDateString("ru-RU");
    const typeNames = {
      roller_7: "Замена ролика (7 мин)",
      roller_15: "Замена ролика (15 мин)",
      scrap_tape: "Брак ленты / дробилка",
      breakdown: "Поломка",
      setup: "Настройка / дробилка",
      custom: "Произвольный",
    };

    let lines = [];
    lines.push(`Отчет простоев — М-${machineId}`);
    lines.push(`Дата: ${dateStr}`);
    lines.push(`Всего записей: ${downtimes.length}`);

    const totalMinutes = downtimes.reduce(
      (sum, d) => sum + d.duration_minutes,
      0,
    );
    lines.push(`Общий простои: ${totalMinutes} мин`);
    lines.push("");

    downtimes.forEach((d) => {
      const time = new Date(d.timestamp).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const typeName = typeNames[d.downtime_type] || d.downtime_type;
      lines.push(`${time}  ${typeName}`);
      if (d.note) {
        lines.push(`   Примечание: ${d.note}`);
      }
    });

    const text = lines.join("\n");

    // Копируем в буфер (с fallback для старых браузеров)
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: временный textarea
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }

    // Визуальный фидбек
    const btn = document.querySelector(
      `.btn-copy-downtime[data-machine="${machineId}"]`,
    );
    if (btn) {
      btn.classList.add("copied");
      btn.textContent = "✅";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = "📋 Копировать";
      }, 1500);
    }

    showNotification("Отчет простоев скопирован", "success");
  } catch (error) {
    console.error("Ошибка копирования:", error);
    showNotification("Ошибка копирования", "error");
  }
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        console.log("SW зарегистрирован успешно");

        // Проверяем наличие обновлений SW на сервере каждые 5 минут
        setInterval(
          () => {
            reg.update();
          },
          1000 * 60 * 5,
        );

        // Слушаем появление нового сервис-воркера
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            // Если новый SW скачался и установился
            if (
              newWorker.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              if (
                confirm(
                  "Доступно обновление калькулятора! Перезагрузить страницу?",
                )
              ) {
                window.location.reload();
              }
            }
          });
        });
      })
      .catch((err) => console.error("Ошибка регистрации SW:", err));
  });

  // Обработка фонового обновления
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}
