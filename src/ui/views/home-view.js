export function createHomeView({ onSetUiMode, onEnterSimulationMode, onEnterLiveMode, onUpdateSettings }) {
    const elements = {
        viewHome: document.getElementById("view-home"),
        goToSimBtn: document.getElementById("goToSimBtn"),
        goToLiveBtn: document.getElementById("goToLiveBtn"),
        goHomeBtns: [...document.querySelectorAll(".go-home-btn")],
        homeProfileCard: document.getElementById("homeProfileCard"),
        homeHistoryCard: document.getElementById("homeHistoryCard"),
        historyContainer: document.getElementById("historyContainer"),
        postRideReportCard: document.getElementById("postRideReportCard"),
        postRideHistoryContainer: document.getElementById("postRideHistoryContainer"),
        personalSettingsForm: document.getElementById("personalSettingsForm"),
        savedSessionChip: document.getElementById("savedSessionChip")
    };

    bind(elements.goToSimBtn, "click", onEnterSimulationMode);
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
