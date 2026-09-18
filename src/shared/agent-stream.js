// Shared framing only; planning decisions remain in Python.
export async function readAgentStream(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result;
    let finished = false;
    const consume = (line) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.schema_version !== "route_stream.v1") throw new Error("不支持的路线进度格式。");
        if (event.type === "error") throw new Error(event.message || "路线处理失败。");
        if (event.type === "result") { result = event.result; finished = true; }
        else if (event.type === "progress") onEvent?.(event);
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            let newline;
            while ((newline = pending.indexOf("\n")) >= 0) {
                consume(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
            }
            if (done) break;
        }
        consume(pending);
        if (!finished) throw new Error("路线连接中断，尚未收到最终结果。请刷新检查路线状态。");
        return result;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
