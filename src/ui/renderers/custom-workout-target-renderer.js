import { formatDuration } from "../../shared/format.js";
import {
    getBlockTypeLabel,
    getWorkoutTargetPresetOptions,
    WORKOUT_TARGET_BLOCK_TYPES
} from "../../domain/workout/custom-workout-target.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";

export function createCustomWorkoutTargetRenderer({
    elements,
    onUpdateCustomWorkoutTargetEnabled,
    onAddCustomWorkoutTargetStep,
    onEditCustomWorkoutTarget,
    onApplyCustomWorkoutTargetPreset,
    onUpdateCustomWorkoutTargetStep,
    onRemoveCustomWorkoutTargetStep
}) {
    let lastSignature = "";
    let lastTableSignature = "";
    let editingField = null;
    let commitTimerId = null;
    let latestState = null;

    bindEvents();

    function bindEvents() {
        if (elements.customWorkoutTargetEnabled) {
            elements.customWorkoutTargetEnabled.addEventListener("change", (event) => {
                onUpdateCustomWorkoutTargetEnabled(event.target.checked);
            });
        }

        if (elements.customWorkoutTargetToggle) {
            elements.customWorkoutTargetToggle.addEventListener("click", (event) => {
                event.preventDefault?.();
                toggleCustomWorkoutTarget();
            });
            elements.customWorkoutTargetToggle.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }
                event.preventDefault?.();
                toggleCustomWorkoutTarget();
            });
        }

        if (elements.addCustomWorkoutTargetStepBtn) {
            elements.addCustomWorkoutTargetStepBtn.addEventListener("click", () => {
                onAddCustomWorkoutTargetStep();
            });
        }

        if (elements.applyCustomWorkoutTargetPresetBtn) {
            elements.applyCustomWorkoutTargetPresetBtn.addEventListener("click", () => {
                const presetKey = elements.customWorkoutTargetPresetSelect?.value;
                if (presetKey) {
                    onApplyCustomWorkoutTargetPreset(presetKey);
                }
            });
        }

        if (elements.editCustomWorkoutTargetBtn) {
            elements.editCustomWorkoutTargetBtn.addEventListener("click", () => {
                onEditCustomWorkoutTarget();
            });
        }

        if (elements.customWorkoutTargetTableBody) {
            elements.customWorkoutTargetTableBody.addEventListener("focusin", (event) => {
                if (!event.target.matches("input[data-field], select[data-field]")) {
                    return;
                }
                const row = event.target.closest("tr");
                editingField = {
                    stepId: row?.dataset.stepId ?? null,
                    field: event.target.dataset.field,
                    value: event.target.value
                };
            });

            elements.customWorkoutTargetTableBody.addEventListener("input", (event) => {
                if (!event.target.matches("input[data-field]")) {
                    return;
                }
                const row = event.target.closest("tr");
                editingField = {
                    stepId: row?.dataset.stepId ?? null,
                    field: event.target.dataset.field,
                    value: event.target.value
                };
                updateRowPowerPreview(row, stateFromRow(row));
                scheduleCommit(event.target);
            });

            elements.customWorkoutTargetTableBody.addEventListener("change", (event) => {
                if (event.target.matches("input[data-field], select[data-field]")) {
                    commitTableField(event.target);
                }
            });

            elements.customWorkoutTargetTableBody.addEventListener("focusout", () => {
                window.setTimeout(() => {
                    if (isTableEditing() || !latestState) {
                        return;
                    }
                    syncTableIfNeeded(
                        latestState.workout.customWorkoutTarget,
                        latestState.settings.ftp,
                        latestState.liveRide.isActive
                    );
                    renderStatus(
                        latestState.workout.runtime,
                        latestState.workout.mode === WORKOUT_MODES.FIXED_POWER
                    );
                }, 0);
            });

            elements.customWorkoutTargetTableBody.addEventListener("keydown", (event) => {
                if (!event.target.matches("input[data-field]")) {
                    return;
                }
                if (event.key === "Enter") {
                    event.preventDefault();
                    commitTableField(event.target);
                    event.target.blur();
                }
            });

            elements.customWorkoutTargetTableBody.addEventListener("click", (event) => {
                const removeButton = event.target.closest("[data-remove-step]");
                if (!removeButton) {
                    return;
                }
                onRemoveCustomWorkoutTargetStep(removeButton.dataset.removeStep);
            });
        }
    }

    function render(state) {
        latestState = state;
        const signature = JSON.stringify({
            ftp: state.settings.ftp,
            isActive: state.liveRide.isActive,
            runtime: {
                enabled: state.workout.runtime.customWorkoutTargetEnabled,
                active: state.workout.runtime.customWorkoutTargetActive,
                completed: state.workout.runtime.customWorkoutTargetCompleted,
                stepLabel: state.workout.runtime.customWorkoutTargetStepLabel,
                blockType: state.workout.runtime.customWorkoutTargetBlockType,
                power: state.workout.runtime.customWorkoutTargetPowerWatts,
                ftpPercent: state.workout.runtime.customWorkoutTargetFtpPercent,
                startFtpPercent: state.workout.runtime.customWorkoutTargetStartFtpPercent,
                endFtpPercent: state.workout.runtime.customWorkoutTargetEndFtpPercent,
                totalSeconds: state.workout.runtime.customWorkoutTargetTotalSeconds,
                remaining: state.workout.runtime.customWorkoutTargetRemainingSeconds
            },
            target: {
                source: state.workout.customWorkoutTarget.source,
                presetKey: state.workout.customWorkoutTarget.presetKey,
                steps: state.workout.customWorkoutTarget.steps
            }
        });

        if (signature === lastSignature) {
            syncTableIfNeeded(state.workout.customWorkoutTarget, state.settings.ftp, state.liveRide.isActive, shouldShowCustomTable(state.workout.customWorkoutTarget));
            return;
        }

        const customWorkoutTarget = state.workout.customWorkoutTarget;
        const isLocked = state.liveRide.isActive;
        const isErgMode = state.workout.mode === WORKOUT_MODES.FIXED_POWER;
        const editorEnabled = isErgMode && customWorkoutTarget.enabled;
        const showCustomTable = shouldShowCustomTable(customWorkoutTarget);

        if (elements.customWorkoutTargetPanel) {
            elements.customWorkoutTargetPanel.hidden = !isErgMode;
        }

        if (elements.customWorkoutTargetEnabled && document.activeElement !== elements.customWorkoutTargetEnabled) {
            elements.customWorkoutTargetEnabled.checked = customWorkoutTarget.enabled;
            elements.customWorkoutTargetEnabled.disabled = isLocked || !isErgMode;
        }
        if (elements.customWorkoutTargetToggle) {
            const disabled = isLocked || !isErgMode;
            elements.customWorkoutTargetToggle.setAttribute("aria-checked", customWorkoutTarget.enabled ? "true" : "false");
            elements.customWorkoutTargetToggle.setAttribute("aria-disabled", disabled ? "true" : "false");
            elements.customWorkoutTargetToggle.classList.toggle("is-disabled", disabled);
            elements.customWorkoutTargetToggle.tabIndex = disabled ? -1 : 0;
        }

        if (elements.addCustomWorkoutTargetStepBtn) {
            elements.addCustomWorkoutTargetStepBtn.disabled = isLocked || !editorEnabled || !showCustomTable;
        }

        if (elements.customWorkoutTargetPresetSelect) {
            elements.customWorkoutTargetPresetSelect.disabled = isLocked || !isErgMode;
            renderPresetOptions(elements.customWorkoutTargetPresetSelect);
        }

        if (elements.applyCustomWorkoutTargetPresetBtn) {
            elements.applyCustomWorkoutTargetPresetBtn.disabled = isLocked || !isErgMode;
        }

        if (elements.editCustomWorkoutTargetBtn) {
            elements.editCustomWorkoutTargetBtn.disabled = isLocked || !isErgMode;
        }

        if (elements.customWorkoutTargetEditor) {
            elements.customWorkoutTargetEditor.hidden = !editorEnabled;
        }

        if (elements.customWorkoutTargetTableShell) {
            elements.customWorkoutTargetTableShell.hidden = !editorEnabled || !showCustomTable;
        }

        renderChart(customWorkoutTarget, state.workout.runtime, state.settings.ftp, editorEnabled);
        syncTableIfNeeded(customWorkoutTarget, state.settings.ftp, isLocked, showCustomTable);
        renderStatus(state.workout.runtime, isErgMode);
        lastSignature = signature;
    }

    function syncTableIfNeeded(customWorkoutTarget, ftp, isLocked, showCustomTable = true) {
        if (!showCustomTable) {
            return;
        }

        const tableSignature = JSON.stringify({
            ftp,
            isLocked,
            steps: customWorkoutTarget.steps
        });

        if (tableSignature === lastTableSignature) {
            return;
        }

        if (isTableEditing()) {
            return;
        }

        renderTable(customWorkoutTarget, ftp, isLocked);
        lastTableSignature = tableSignature;
    }

    function renderChart(customWorkoutTarget, runtime, ftp, editorEnabled) {
        if (!elements.customWorkoutTargetChart) return;

        elements.customWorkoutTargetChart.hidden = !editorEnabled;
        if (!editorEnabled) {
            elements.customWorkoutTargetChart.innerHTML = "";
            return;
        }

        elements.customWorkoutTargetChart.innerHTML = buildWorkoutTargetPlanBarChartSvg({
            customWorkoutTarget,
            runtime,
            ftp
        });
    }

    function renderTable(customWorkoutTarget, ftp, isLocked) {
        if (!elements.customWorkoutTargetTableBody) return;

        elements.customWorkoutTargetTableBody.dataset.ftp = String(ftp ?? 0);

        elements.customWorkoutTargetTableBody.innerHTML = customWorkoutTarget.steps.map((step, index) => {
            const startPower = Math.round((ftp ?? 0) * (step.ftpPercent / 100));
            const endPower = Math.round((ftp ?? 0) * (step.endFtpPercent / 100));
            const isSteadyBlock = step.blockType === WORKOUT_TARGET_BLOCK_TYPES.STEADY;
            const powerPreview = isSteadyBlock
                ? `${startPower} W`
                : `${startPower} -> ${endPower} W`;
            const durationValue = resolveEditingValue(step.id, "durationMinutes", step.durationMinutes);
            const ftpValue = resolveEditingValue(step.id, "ftpPercent", step.ftpPercent);
            const endFtpValue = resolveEditingValue(step.id, "endFtpPercent", step.endFtpPercent);

            return `
                <tr data-step-id="${step.id}">
                    <td>
                        <select class="workout-target-type-select" data-field="blockType" ${isLocked ? "disabled" : ""} aria-label="第 ${index + 1} 段类型">
                            ${renderBlockTypeOption(WORKOUT_TARGET_BLOCK_TYPES.STEADY, step.blockType)}
                            ${renderBlockTypeOption(WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP, step.blockType)}
                            ${renderBlockTypeOption(WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN, step.blockType)}
                        </select>
                    </td>
                    <td><input class="workout-target-input" data-field="durationMinutes" inputmode="numeric" type="text" value="${durationValue}" ${isLocked ? "disabled" : ""}></td>
                    <td><input class="workout-target-input" data-field="ftpPercent" inputmode="numeric" type="text" value="${ftpValue}" ${isLocked ? "disabled" : ""}></td>
                    <td>${isSteadyBlock
                        ? `<span class="muted-table-text">同 FTP %</span>`
                        : `<input class="workout-target-input" data-field="endFtpPercent" inputmode="numeric" type="text" value="${endFtpValue}" ${isLocked ? "disabled" : ""}>`
                    }</td>
                    <td>${powerPreview}</td>
                    <td class="action-cell">
                        <button type="button" class="remove-segment-btn" data-remove-step="${step.id}" ${isLocked || customWorkoutTarget.steps.length <= 1 ? "disabled" : ""}>×</button>
                    </td>
                </tr>
            `;
        }).join("");
    }

    function renderStatus(runtime, isErgMode = true) {
        if (!elements.customWorkoutTargetStatus) return;

        if (!isErgMode) {
            elements.customWorkoutTargetStatus.textContent = "自定义训练目标仅在 ERG 模式下控制骑行台。";
            return;
        }

        if (!runtime.customWorkoutTargetEnabled) {
            elements.customWorkoutTargetStatus.textContent = "当前使用固定 ERG 目标功率。启用分段计划后，将按时间改写 ERG 目标功率。";
            return;
        }

        if (runtime.customWorkoutTargetActive) {
            elements.customWorkoutTargetStatus.textContent = `当前目标：${formatRuntimeFtp(runtime)} / ${runtime.customWorkoutTargetPowerWatts} W，剩余 ${formatDuration(runtime.customWorkoutTargetRemainingSeconds ?? 0)}。`;
            return;
        }

        if (runtime.customWorkoutTargetCompleted) {
            elements.customWorkoutTargetStatus.textContent = "自定义训练目标已完成，后续骑行将仅显示实际功率。";
            return;
        }

        elements.customWorkoutTargetStatus.textContent = `分段 FTP 目标已启用，总时长 ${formatDuration(runtime.customWorkoutTargetTotalSeconds ?? 0)}。开始骑行后按表格顺序控制 ERG。`;
    }

    function resolveEditingValue(stepId, field, fallbackValue) {
        return editingField?.stepId === stepId && editingField?.field === field
            ? editingField.value
            : fallbackValue;
    }

    return {
        render
    };

    function toggleCustomWorkoutTarget() {
        if (!elements.customWorkoutTargetEnabled || elements.customWorkoutTargetEnabled.disabled) {
            return;
        }
        const nextChecked = !elements.customWorkoutTargetEnabled.checked;
        elements.customWorkoutTargetEnabled.checked = nextChecked;
        onUpdateCustomWorkoutTargetEnabled(nextChecked);
    }

    function commitTableField(fieldElement) {
        clearScheduledCommit();
        const row = fieldElement.closest("tr");
        const stepId = row?.dataset.stepId;
        const field = fieldElement.dataset.field;
        if (!stepId || !field) {
            return;
        }

        if (fieldElement.matches("select[data-field]")) {
            onUpdateCustomWorkoutTargetStep(stepId, {
                [field]: fieldElement.value
            });
            editingField = null;
            return;
        }

        const rawValue = fieldElement.value;
        if (rawValue === "") {
            return;
        }

        const normalizedValue = Number(String(rawValue).replace(/[^\d.]/g, ""));
        if (!Number.isFinite(normalizedValue)) {
            return;
        }

        onUpdateCustomWorkoutTargetStep(stepId, {
            [field]: normalizedValue
        });
        if (document.activeElement !== fieldElement) {
            editingField = null;
        }
    }

    function scheduleCommit(fieldElement) {
        clearScheduledCommit();
        commitTimerId = window.setTimeout(() => {
            commitTableField(fieldElement);
        }, 220);
    }

    function clearScheduledCommit() {
        if (commitTimerId) {
            window.clearTimeout(commitTimerId);
            commitTimerId = null;
        }
    }

    function isTableEditing() {
        return Boolean(document.activeElement?.closest?.("#customWorkoutTargetTableBody"));
    }

    function stateFromRow(row) {
        if (!row) {
            return null;
        }

        const durationMinutes = Number(row.querySelector('[data-field="durationMinutes"]')?.value ?? 0);
        const ftpPercent = Number(row.querySelector('[data-field="ftpPercent"]')?.value ?? 0);
        const endFtpPercent = Number(row.querySelector('[data-field="endFtpPercent"]')?.value ?? ftpPercent);
        const blockType = row.querySelector('[data-field="blockType"]')?.value ?? WORKOUT_TARGET_BLOCK_TYPES.STEADY;

        return {
            durationMinutes,
            ftpPercent,
            endFtpPercent,
            blockType
        };
    }

    function updateRowPowerPreview(row, rowState) {
        if (!row || !rowState) {
            return;
        }

        const previewCell = row.children[4];
        if (!previewCell) {
            return;
        }

        const startPower = Math.round((Number(elements.customWorkoutTargetTableBody?.dataset.ftp ?? 0) || 0) * (rowState.ftpPercent / 100));
        const endPower = Math.round((Number(elements.customWorkoutTargetTableBody?.dataset.ftp ?? 0) || 0) * (rowState.endFtpPercent / 100));
        previewCell.textContent = rowState.blockType === WORKOUT_TARGET_BLOCK_TYPES.STEADY
            ? `${startPower} W`
            : `${startPower} -> ${endPower} W`;
    }
}

function buildWorkoutTargetPlanBarChartSvg({ customWorkoutTarget, runtime, ftp }) {
    if (!customWorkoutTarget?.steps?.length) {
        return `
            <rect x="0" y="0" width="640" height="220" fill="#ffffff"></rect>
            <text x="320" y="110" text-anchor="middle" fill="#64748b" font-size="14">启用训练目标后显示目标功率课表</text>
        `;
    }

    const width = 640;
    const height = 220;
    const padding = { left: 44, right: 18, top: 22, bottom: 34 };
    const totalSeconds = Math.max(runtime.customWorkoutTargetTotalSeconds ?? sumStepSeconds(customWorkoutTarget.steps), 1);
    const maxPower = Math.max(
        100,
        ...customWorkoutTarget.steps.flatMap((step) => [
            toPower(step.ftpPercent, ftp),
            toPower(step.endFtpPercent ?? step.ftpPercent, ftp)
        ])
    );
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const baseY = height - padding.bottom;
    const toX = (seconds) => padding.left + (seconds / totalSeconds) * innerWidth;
    const toY = (power) => baseY - (power / maxPower) * innerHeight;

    let cumulativeSeconds = 0;
    const bars = customWorkoutTarget.steps.map((step) => {
        const startSeconds = cumulativeSeconds;
        const durationSeconds = Math.round(step.durationMinutes * 60);
        cumulativeSeconds += durationSeconds;
        const startPower = toPower(step.ftpPercent, ftp);
        const endPower = toPower(step.endFtpPercent ?? step.ftpPercent, ftp);
        const avgPower = (startPower + endPower) / 2;
        const x = toX(startSeconds);
        const nextX = toX(cumulativeSeconds);
        const y = toY(avgPower);
        const barWidth = Math.max(1, nextX - x - 1);
        const barHeight = Math.max(1, baseY - y);
        const labelX = x + barWidth / 2;
        const showLabel = barWidth >= 44;

        return `
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${getTargetPowerColor(avgPower, ftp)}" rx="4"></rect>
            ${showLabel ? `<text x="${labelX.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="#334155" font-size="10" font-weight="700">${Math.round(avgPower)}W</text>` : ""}
        `;
    }).join("");

    return `
        <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
        <line x1="${padding.left}" y1="${baseY}" x2="${width - padding.right}" y2="${baseY}" stroke="#cbd5e1" stroke-width="1"></line>
        <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${baseY}" stroke="#cbd5e1" stroke-width="1"></line>
        <text x="${padding.left - 8}" y="${padding.top + 4}" text-anchor="end" fill="#64748b" font-size="11">${Math.round(maxPower)}W</text>
        <text x="${padding.left - 8}" y="${baseY}" text-anchor="end" fill="#64748b" font-size="11">0W</text>
        <text x="${padding.left}" y="${height - 10}" fill="#64748b" font-size="11">0:00</text>
        <text x="${width - padding.right}" y="${height - 10}" text-anchor="end" fill="#64748b" font-size="11">${formatDuration(totalSeconds)}</text>
        ${bars}
        <text x="${padding.left}" y="16" fill="#0f172a" font-size="12" font-weight="800">目标功率</text>
    `;
}

function sumStepSeconds(steps) {
    return steps.reduce((sum, step) => sum + Math.round(Number(step.durationMinutes ?? 0) * 60), 0);
}

function toPower(ftpPercent, ftp) {
    return Math.round((Number(ftp) || 0) * ((Number(ftpPercent) || 0) / 100));
}

function getTargetPowerColor(power, ftp) {
    const ratio = Number(ftp) > 0 ? power / ftp : 0;
    if (ratio < 0.55) return "#93c5fd";
    if (ratio < 0.75) return "#22c55e";
    if (ratio < 0.9) return "#84cc16";
    if (ratio < 1.05) return "#facc15";
    if (ratio < 1.2) return "#fb923c";
    return "#ef4444";
}

function shouldShowCustomTable(customWorkoutTarget) {
    return customWorkoutTarget?.source !== "preset";
}

function renderPresetOptions(selectElement) {
    if (selectElement.dataset.rendered === "true") {
        return;
    }

    selectElement.innerHTML = getWorkoutTargetPresetOptions().map((preset) => (
        `<option value="${preset.key}" title="${preset.description}">${preset.label}</option>`
    )).join("");
    selectElement.dataset.rendered = "true";
}

function renderBlockTypeOption(blockType, currentBlockType) {
    const selected = blockType === currentBlockType ? "selected" : "";
    return `<option value="${blockType}" ${selected}>${getCompactBlockTypeLabel(blockType)}</option>`;
}

function getCompactBlockTypeLabel(blockType) {
    switch (blockType) {
        case WORKOUT_TARGET_BLOCK_TYPES.RAMP_UP:
            return "增加";
        case WORKOUT_TARGET_BLOCK_TYPES.RAMP_DOWN:
            return "减少";
        default:
            return "恒定";
    }
}

function formatRuntimeFtp(runtime) {
    const start = runtime.customWorkoutTargetStartFtpPercent;
    const end = runtime.customWorkoutTargetEndFtpPercent;
    const current = runtime.customWorkoutTargetFtpPercent;

    if (start === null || start === undefined || end === null || end === undefined || start === end) {
        return `${current}% FTP`;
    }

    return `${current}% FTP（${start}% -> ${end}%）`;
}
