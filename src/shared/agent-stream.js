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
        if (!["route_stream.v1", "agent_stream.v1"].includes(event.schema_version)) throw new Error("不支持的处理进度格式。");
        if (event.type === "error") throw new Error(event.message || "本次处理失败。");
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
        if (!finished) throw new Error("连接中断，尚未收到最终结果。请查看会话确认处理状态。");
        return result;
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
