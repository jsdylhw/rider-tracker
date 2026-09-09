import { collectElements } from "./view-elements.js";

export function createDeviceSetupView() {
    return {
        elements: collectElements([
            "deviceControlsPanel", "connectHrBtn", "connectPowerBtn", "connectTrainerBtn",
            "hrDeviceStatus", "hrDeviceName", "powerDeviceStatus", "powerDeviceName",
            "trainerDeviceStatus", "trainerDeviceName"
        ])
    };
}
