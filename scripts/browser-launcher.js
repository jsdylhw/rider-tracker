import { spawn } from "node:child_process";

export function shouldOpenBrowser(value) {
    const normalized = String(value ?? "true").trim().toLowerCase();
    return !["0", "false", "off", "no", "disabled"].includes(normalized);
}

export function openBrowser(url, {
    platform = process.platform,
    env = process.env,
    spawnImpl = spawn,
} = {}) {
    const target = String(url || "").trim();
    if (!target) return { opened: false, reason: "missing_url" };
    if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
        return { opened: false, reason: "no_desktop_session" };
    }

    const command = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
    const args = platform === "win32"
        ? ["/d", "/s", "/c", "start", "", target]
        : [target];
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once?.("error", (error) => {
        console.warn(`[rider-tracker] unable to open browser automatically: ${error.message}`);
    });
    child.unref?.();
    return { opened: true, command, args };
}
