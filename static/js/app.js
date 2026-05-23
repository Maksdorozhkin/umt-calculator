// ===== UMT Production Calculator =====
let currentMachine = 1;
let productCache = [];

// ==================== INIT ====================
document.addEventListener("DOMContentLoaded", function () {
    loadProductCache().then(() => {
        setupTabs();
        setupDowntimeSelectors();
        setupProductForms();
        setupTapeForm();
        setupAutocomplete();
        setupReferencePanel();
        updateShiftDisplay();
        setInterval(updateShiftDisplay, 60000);
        loadInitialData();
    });
});

// // ==================== Определение смены (старая функция до 7/50) ====================
// function updateShiftDisplay() {
//     const now = new Date();
//     const hours = now.getHours();
//     const minutes = now.getMinutes();
//     const totalMinutes = hours * 60 + minutes;

//     let isDayShift;
//     if (totalMinutes >= 480 && totalMinutes < 1190) {
//         isDayShift = true; // 08:00 - 19:50
//     } else if (totalMinutes >= 1200 || totalMinutes < 470) {
//         isDayShift = false; // 20:00 - 07:50
//     } else {
//         isDayShift = true; // transition
//     }

//     document.documentElement.setAttribute('data-theme', isDayShift ? 'light' : 'dark');

//     const icon = document.getElementById('shiftIcon');
//     const label = document.getElementById('shiftLabel');
//     const time = document.getElementById('shiftTime');

//     if (isDayShift) {
//         icon.textContent = '☀️';
//         label.textContent = 'Дневная смена';
//     } else {
//         icon.textContent = '🌙';
//         label.textContent = 'Ночная смена';
//     }

// // Определение смены (новая функция до 8:00)
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

    // Calculate remaining time
    const remaining = getRemainingMinutes();
    time.textContent = `До конца: ${formatTimeShort(remaining)}`;

    // Update available time for current machine
    updateAvailableTime(currentMachine);
}

// старая функция которая считала время до 7:50
// function getShiftEndMinutes() {
//     const now = new Date();
//     const totalMinutes = now.getHours() * 60 + now.getMinutes();

//     if (totalMinutes >= 480 && totalMinutes < 1190) {
//         return 1190; // Day shift ends at 19:50
//     } else {
//         // Night shift: if after 20:00, ends at 07:50 next day
//         if (totalMinutes >= 1200) return 1910; // 24*60 + 7*60 + 50 = 1910
//         return 470; // 07:50
//     }
// }
// Новая функция считает до 8:00
//
function getShiftEndMinutes() {
    const now = new Date();
    const totalMinutes = now.getHours() * 60 + now.getMinutes();

    // Строгие границы: День с 08:00 (480) до 20:00 (1200)
    if (totalMinutes >= 480 && totalMinutes < 1200) {
        return 1200; // Конец дня ровно в 20:00
    } else {
        // Конец ночи ровно в 08:00 следующего дня (24ч * 60 + 8ч * 60 = 1920)
        if (totalMinutes >= 1200) return 1920;
        return 480; // Конец ночи ровно в 08:00 текущего дня
    }
}
// Отнимаем 10 минут пересменки
function getRemainingMinutes() {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Получаем чистое время до конца смены (до 20:00 или 08:00)
    const end = getShiftEndMinutes();
    const totalRemaining = end - nowMinutes;

    // Отнимаем 10 минут пересменки.
    // Math.max(0, ...) гарантирует, что во время самой пересменки на экране останется "0 мин", а не минус.
    return Math.max(0, totalRemaining - 10);
}

function getRemainingMinutes() {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const end = getShiftEndMinutes();
    return Math.max(0, end - nowMinutes);
}

function formatTimeShort(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h === 0) return `${m} мин`;
    if (m === 0) return `${h} ч`;
    return `${h}ч ${m}мин`;
}

function updateAvailableTime(machineId) {
    const availEl = document.getElementById(`availTime${machineId}`);
    const totalEl = document.getElementById(`totalDowntime${machineId}`);
    if (!availEl) return;

    const remaining = getRemainingMinutes();
    const totalDowntime = getTotalDowntimeForMachine(machineId);
    const effective = Math.max(0, remaining - totalDowntime);

    availEl.textContent = formatTimeShort(effective);
    totalEl.textContent = totalDowntime > 0 ? `${totalDowntime} мин` : "0 мин";
}

// ==================== TABS ====================
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

            if (target !== "tape" && target !== "reference") {
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

// ==================== PRODUCT CACHE ====================
async function loadProductCache() {
    try {
        const response = await fetch("/api/products");
        productCache = await response.json();
    } catch (error) {
        console.error("Ошибка загрузки кэша продуктов:", error);
        productCache = [];
    }
}

// ==================== AUTOCOMPLETE ====================
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
                showNotification(
                    `Загружены данные для "${product.name}"`,
                    "success",
                );
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

        // Calc button
        const calcBtn = document.querySelector(
            `.calc-btn[data-machine="${i}"]`,
        );
        if (calcBtn)
            calcBtn.addEventListener("click", () => calculateProduction(i));

        // Reset button
        const resetBtn = document.querySelector(
            `.reset-btn[data-machine="${i}"]`,
        );
        if (resetBtn)
            resetBtn.addEventListener("click", () => resetCalculator(i));

        // Add downtime button
        const addBtn = document.querySelector(
            `.add-downtime-btn[data-machine="${i}"]`,
        );
        if (addBtn) addBtn.addEventListener("click", () => logDowntime(i));
    }
}

// ==================== DOWNTIME SELECTORS ====================
function setupDowntimeSelectors() {
    for (let i = 1; i <= 7; i++) {
        const select = document.getElementById(`downtimeType${i}`);
        const durationInput = document.getElementById(`downtimeDuration${i}`);
        if (!select || !durationInput) continue;

        select.addEventListener("change", function () {
            if (this.value === "custom") {
                durationInput.style.display = "block";
                durationInput.required = true;
            } else {
                durationInput.style.display = "none";
                durationInput.required = false;
            }
        });
    }
}

// ==================== TAPE FORM ====================
function setupTapeForm() {
    const form = document.getElementById("tapeForm");
    if (!form) return;

    form.addEventListener("submit", function (e) {
        e.preventDefault();
        calculateTape();
    });

    form.addEventListener("reset", function () {
        setTimeout(() => {
            document.getElementById("tapeResults").style.display = "none";
        }, 10);
    });
}

// ==================== REFERENCE PANEL ====================
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
        closeBtn.addEventListener(
            "click",
            () => (modal.style.display = "none"),
        );
    }
    if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
            modal.style.display = "none";
            form.reset();
        });
    }

    // Close modal on overlay click
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
                cavitations: parseInt(
                    document.getElementById("newCavitations").value,
                ),
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
                const response = await fetch("/api/products", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(productData),
                });

                const result = await response.json();
                if (result.success) {
                    await loadProductCache();
                    loadProductList();
                    showNotification(
                        `"${name}" добавлен в справочник`,
                        "success",
                    );
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

// ==================== DATA LOADING ====================
async function loadInitialData() {
    for (let i = 1; i <= 7; i++) {
        await loadMachineProduct(i);
        await loadDowntimeLog(i);
        updateAvailableTime(i);
    }
}

async function loadMachineProduct(machineId) {
    try {
        const response = await fetch(`/api/machine/${machineId}/product`);
        const product = await response.json();

        if (product.error) {
            clearForm(machineId);
            return;
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
    } catch (error) {
        console.error("Ошибка загрузки продукта:", error);
    }
}

function clearForm(machineId) {
    document.getElementById(`productName${machineId}`).value = "";
    document.getElementById(`cavitations${machineId}`).value = "1";
    document.getElementById(`cycles${machineId}`).value = "";
    document.getElementById(`piecesPerBox${machineId}`).value = "1";
    document.getElementById(`boxesPerPallet${machineId}`).value = "1";
}

// ==================== SAVE & CALCULATE ====================
async function saveProduct(machineId) {
    const name = document
        .getElementById(`productName${machineId}`)
        .value.trim();
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
        const response = await fetch("/api/products", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(productData),
        });

        const result = await response.json();
        if (result.success) {
            await fetch(`/api/machine/${machineId}/product`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ product_id: result.id }),
            });

            await loadProductCache();
            const action = result.updated ? "обновлены" : "сохранены";
            showNotification(`Данные "${name}" ${action}`, "success");
        }
    } catch (error) {
        showNotification("Ошибка сохранения данных", "error");
    }
}

async function calculateProduction(machineId) {
    try {
        const response = await fetch(`/api/calculate/${machineId}`);
        const result = await response.json();

        if (result.error) {
            document.getElementById(`pallets${machineId}`).textContent = "0";
            document.getElementById(`boxes${machineId}`).textContent = "0";
            document.getElementById(`pieces${machineId}`).textContent = "0";
            showNotification(result.error, "error");
            return;
        }

        document.getElementById(`pallets${machineId}`).textContent =
            result.pallets;
        document.getElementById(`boxes${machineId}`).textContent = result.boxes;
        document.getElementById(`pieces${machineId}`).textContent =
            result.pieces;

        // Show results panel
        const resultsPanel = document.getElementById(`results${machineId}`);
        if (resultsPanel) resultsPanel.style.display = "grid";

        updateAvailableTime(machineId);
    } catch (error) {
        console.error("Ошибка расчета:", error);
        showNotification("Ошибка расчета", "error");
    }
}

function resetCalculator(machineId) {
    clearForm(machineId);
    document.getElementById(`pallets${machineId}`).textContent = "0";
    document.getElementById(`boxes${machineId}`).textContent = "0";
    document.getElementById(`pieces${machineId}`).textContent = "0";
    const resultsPanel = document.getElementById(`results${machineId}`);
    if (resultsPanel) resultsPanel.style.display = "none";
    showNotification("Калькулятор сброшен", "success");
}

// ==================== DOWNTIME ====================
function getTotalDowntimeForMachine(machineId) {
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

    if (downtimeType === "custom") {
        duration = parseInt(
            document.getElementById(`downtimeDuration${machineId}`).value,
        );
        if (!duration || duration <= 0) {
            showNotification("Укажите длительность простоя", "error");
            return;
        }
    } else {
        const durations = { lunch: 30, roller_7: 7, roller_15: 15 };
        duration = durations[downtimeType];
    }

    const note = document.getElementById(`downtimeNote${machineId}`).value;

    try {
        const response = await fetch("/api/downtime", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                machine_id: machineId,
                downtime_type: downtimeType,
                duration_minutes: duration,
                note: note,
            }),
        });

        const result = await response.json();
        if (result.success) {
            showNotification("Простой добавлен", "success");
            document.getElementById(`downtimeNote${machineId}`).value = "";
            await loadDowntimeLog(machineId);
            updateAvailableTime(machineId);
        }
    } catch (error) {
        showNotification("Ошибка добавления простоя", "error");
    }
}

async function loadDowntimeLog(machineId) {
    try {
        const response = await fetch(`/api/downtime/machine/${machineId}`);
        const downtimes = await response.json();

        const logContainer = document.getElementById(`downtimeLog${machineId}`);
        if (!logContainer) return;

        if (downtimes.length === 0) {
            logContainer.innerHTML =
                '<div class="empty-state" style="padding: 20px;"><p style="font-size: 0.85rem; color: var(--text-muted);">Нет записей о простоях</p></div>';
            updateAvailableTime(machineId);
            return;
        }

        const typeNames = {
            lunch: "🍽 Обед",
            roller_7: "🔄 Замена ролика (7 мин)",
            roller_15: "🔄 Замена ролика (15 мин)",
            custom: "⚙️ Произвольный",
        };

        logContainer.innerHTML = downtimes
            .map((d) => {
                const time = new Date(d.timestamp).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                });
                return `
                <div class="downtime-entry">
                    <div class="downtime-info">
                        <span class="downtime-type">${typeNames[d.downtime_type] || d.downtime_type}</span>
                        <span class="downtime-detail">${time}${d.note ? " · " + escapeHtml(d.note) : ""}</span>
                    </div>
                    <span class="downtime-duration">${d.duration_minutes} мин</span>
                    <button class="btn btn-danger" onclick="deleteDowntime(${machineId}, ${d.id})" title="Удалить">✕</button>
                </div>
            `;
            })
            .join("");

        updateAvailableTime(machineId);
    } catch (error) {
        console.error("Ошибка загрузки лога:", error);
    }
}

// ==================== TAPE CALCULATOR ====================
async function calculateTape() {
    const avgWeight = parseFloat(document.getElementById("avgWeight").value);
    const wastePercent = parseFloat(
        document.getElementById("wastePercent").value,
    );
    const requiredPieces = parseInt(
        document.getElementById("requiredPieces").value,
    );

    if (!avgWeight || isNaN(wastePercent) || !requiredPieces) {
        showNotification("Заполните все поля", "error");
        return;
    }

    try {
        const response = await fetch("/api/tape-calculation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                avg_weight: avgWeight,
                waste_percent: wastePercent,
                required_pieces: requiredPieces,
            }),
        });

        const result = await response.json();
        document.getElementById("tapeNeeded").textContent =
            result.tape_needed.toLocaleString("ru-RU");
        document.getElementById("tapePlus10").textContent =
            result.tape_plus_10.toLocaleString("ru-RU");
        document.getElementById("tapeResults").style.display = "grid";
        showNotification("Расчет выполнен", "success");
    } catch (error) {
        showNotification("Ошибка расчета", "error");
    }
}

// ==================== NOTIFICATIONS ====================
function showNotification(message, type = "info") {
    // Remove existing notifications
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
        const response = await fetch(`/api/downtime/${downtimeId}`, {
            method: "DELETE",
        });
        const result = await response.json();

        if (result.success) {
            showNotification("Запись удалена", "success");
            await loadDowntimeLog(machineId);
            updateAvailableTime(machineId);
        }
    } catch (error) {
        showNotification("Ошибка удаления", "error");
    }
};

window.deleteProductFromRef = async function (productId) {
    if (!confirm("Удалить этот продукт из справочника?")) return;

    try {
        const response = await fetch(`/api/products/${productId}`, {
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
        showNotification("Ошибка подключения", "error");
    }
};

window.resetDatabase = async function () {
    if (!confirm("ВНИМАНИЕ! Это удалит ВСЕ данные. Продолжить?")) return;
    if (!confirm("Точно удалить все данные? Это действие нельзя отменить."))
        return;

    try {
        const response = await fetch("/api/reset-database", { method: "POST" });
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
// Кнопка обновления
document.addEventListener("DOMContentLoaded", () => {
    const refreshBtn = document.getElementById("refreshButton");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
            window.location.reload();
        });
    }
});
