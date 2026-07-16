export function createHomeView({ onSetUiMode, onEnterLiveMode, onUpdateSettings }) {
    const elements = {
        viewHome: document.getElementById("view-home"),
        goToLiveBtn: document.getElementById("goToLiveBtn"),
        goHomeBtns: [...document.querySelectorAll(".go-home-btn")],
        homeProfileCard: document.getElementById("homeProfileCard"),
        homeHistoryCard: document.getElementById("homeHistoryCard"),
        historyContainer: document.getElementById("historyContainer"),
        homeTotalDistanceChip: document.getElementById("homeTotalDistanceChip"),
        homeTotalAscentChip: document.getElementById("homeTotalAscentChip"),
        postRideReportCard: document.getElementById("postRideReportCard"),
        postRideHistoryContainer: document.getElementById("postRideHistoryContainer"),
        personalSettingsForm: document.getElementById("personalSettingsForm")
    };

    bind(elements.goToLiveBtn, "click", onEnterLiveMode);
    elements.goHomeBtns.forEach((button) => bind(button, "click", () => onSetUiMode("home")));

    if (elements.personalSettingsForm) {
        elements.personalSettingsForm.addEventListener("input", () => {
            onUpdateSettings(readSettingsFromForm(elements.personalSettingsForm));
        });
    }

    return {
        elements,
        renderSettings(state) {
            renderSettingsForm(elements.personalSettingsForm, state.settings);
        },
        renderActivitySummary(summary) {
            renderActivitySummary(elements, summary);
        }
    };
}

export function readSettingsFromForm(form) {
    const formData = new FormData(form);
    const result = {};

    ["power", "mass", "ftp", "restingHr", "maxHr", "cda", "crr", "windSpeed"].forEach((key) => {
        if (form.elements.namedItem(key)) {
            result[key] = Number(formData.get(key));
        }
    });

    return result;
}

export function renderSettingsForm(form, settings) {
    if (!form) return;

    Object.entries(settings).forEach(([key, value]) => {
        const field = form.elements.namedItem(key);
        if (field && document.activeElement !== field) {
            field.value = value;
        }
    });
}

function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}

function renderActivitySummary(elements, summary = {}) {
    const totalDistanceKm = Number(summary.totalDistanceKm ?? 0);
    const totalAscentMeters = Number(summary.totalAscentMeters ?? 0);

    if (elements.homeTotalDistanceChip) {
        elements.homeTotalDistanceChip.textContent = `${formatNumber(totalDistanceKm, 2)} km`;
    }
    if (elements.homeTotalAscentChip) {
        elements.homeTotalAscentChip.textContent = `${Math.round(totalAscentMeters)} m`;
    }
}

function formatNumber(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : (0).toFixed(digits);
}
