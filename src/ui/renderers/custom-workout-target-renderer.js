import { formatDuration } from "../../shared/format.js";
import {
    getBlockTypeLabel,
    WORKOUT_TARGET_BLOCK_TYPES
} from "../../domain/workout/custom-workout-target.js";
import { WORKOUT_MODES } from "../../domain/workout/workout-mode.js";

export function createCustomWorkoutTargetRenderer({
    elements,
    onUpdateCustomWorkoutTargetEnabled,
    onAddCustomWorkoutTargetStep,
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

        if (elements.addCustomWorkoutTargetStepBtn) {
            elements.addCustomWorkoutTargetStepBtn.addEventListener("click", () => {
                onAddCustomWorkoutTargetStep();
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
            }
        });

        if (signature === lastSignature) {
            syncTableIfNeeded(state.workout.customWorkoutTarget, state.settings.ftp, state.liveRide.isActive);
            return;
        }

        const customWorkoutTarget = state.workout.customWorkoutTarget;
        const isLocked = state.liveRide.isActive;
        const isErgMode = state.workout.mode === WORKOUT_MODES.FIXED_POWER;
        const editorEnabled = isErgMode && customWorkoutTarget.enabled;

        if (elements.customWorkoutTargetPanel) {
            elements.customWorkoutTargetPanel.hidden = !isErgMode;
        }

        if (elements.customWorkoutTargetEnabled && document.activeElement !== elements.customWorkoutTargetEnabled) {
            elements.customWorkoutTargetEnabled.checked = customWorkoutTarget.enabled;
            elements.customWorkoutTargetEnabled.disabled = isLocked || !isErgMode;
        }

        if (elements.addCustomWorkoutTargetStepBtn) {
            elements.addCustomWorkoutTargetStepBtn.disabled = isLocked || !editorEnabled;
        }

        if (elements.customWorkoutTargetEditor) {
            elements.customWorkoutTargetEditor.hidden = !editorEnabled;
        }

        syncTableIfNeeded(customWorkoutTarget, state.settings.ftp, isLocked);
        renderStatus(state.workout.runtime, isErgMode);
        lastSignature = signature;
    }

    function syncTableIfNeeded(customWorkoutTarget, ftp, isLocked) {
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
