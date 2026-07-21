export function createHomeView({ onSetUiMode, onEnterLiveMode, onUpdateSettings }) {
    const elements = {
        viewHome: document.getElementById("view-home"),
        goToLiveBtn: document.getElementById("goToLiveBtn"),
        openProfileSettingsBtn: document.getElementById("openProfileSettingsBtn"),
        profileSettingsOverlay: document.getElementById("profileSettingsOverlay"),
        closeProfileSettingsBtn: document.getElementById("closeProfileSettingsBtn"),
        goHomeBtns: [...document.querySelectorAll(".go-home-btn")],
        homeHistoryCard: document.getElementById("homeHistoryCard"),
        historyContainer: document.getElementById("historyContainer"),
        homeActivityCount: document.getElementById("homeActivityCount"),
        homeActivityDistance: document.getElementById("homeActivityDistance"),
        homeActivityDuration: document.getElementById("homeActivityDuration"),
        homeActivityTss: document.getElementById("homeActivityTss"),
        postRideReportCard: document.getElementById("postRideReportCard"),
        postRideHistoryContainer: document.getElementById("postRideHistoryContainer"),
        personalSettingsForm: document.getElementById("personalSettingsForm")
    };

    bind(elements.goToLiveBtn, "click", onEnterLiveMode);
    elements.goHomeBtns.forEach((button) => bind(button, "click", () => onSetUiMode("home")));
    bind(elements.openProfileSettingsBtn, "click", () => setProfileSettingsOpen(elements, true));
    bind(elements.closeProfileSettingsBtn, "click", () => setProfileSettingsOpen(elements, false));
    bind(elements.profileSettingsOverlay, "click", (event) => {
        if (event.target === elements.profileSettingsOverlay) {
            setProfileSettingsOpen(elements, false);
        }
    });

    if (elements.personalSettingsForm) {
        elements.personalSettingsForm.addEventListener("submit", (event) => event.preventDefault());
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
    const activityCount = Number(summary.activityCount ?? 0);
    const totalElapsedSeconds = Number(summary.totalElapsedSeconds ?? 0);
    const totalEstimatedTss = Number(summary.totalEstimatedTss ?? 0);

    if (elements.homeActivityCount) {
        elements.homeActivityCount.textContent = String(Math.max(0, Math.round(activityCount)));
    }
    if (elements.homeActivityDistance) {
        elements.homeActivityDistance.textContent = formatNumber(totalDistanceKm, 1);
    }
    if (elements.homeActivityDuration) {
        elements.homeActivityDuration.textContent = formatTotalDuration(totalElapsedSeconds);
    }
    if (elements.homeActivityTss) {
        elements.homeActivityTss.textContent = Math.max(0, Math.round(totalEstimatedTss)).toLocaleString("zh-CN");
    }
}

function setProfileSettingsOpen(elements, isOpen) {
    elements.profileSettingsOverlay?.classList.toggle("open", isOpen);
    elements.profileSettingsOverlay?.setAttribute("aria-hidden", String(!isOpen));
}

function formatNumber(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : (0).toFixed(digits);
}

function formatTotalDuration(value) {
    const totalMinutes = Math.max(0, Math.round(Number(value) / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}
