export const AGENT_UNAVAILABLE_CODE = "agent_unavailable";

export function createAgentUnavailableError(message, { cause = null } = {}) {
    const error = new Error(String(message || "Training Agent 当前不可用。"), { cause });
    error.name = "AgentUnavailableError";
    error.statusCode = 503;
    error.code = AGENT_UNAVAILABLE_CODE;
    error.retryable = true;
    return error;
}

export function isAgentUnavailableError(error) {
    return error?.code === AGENT_UNAVAILABLE_CODE || error?.name === "AgentUnavailableError";
}

export function sendAgentUnavailable(res, error, { capability = "training_agent" } = {}) {
    if (!isAgentUnavailableError(error)) return false;
    res.status(503).json({
        ok: false,
        code: AGENT_UNAVAILABLE_CODE,
        capability,
        retryable: error?.retryable !== false,
        error: error?.message || "Training Agent 当前不可用。"
    });
    return true;
}
