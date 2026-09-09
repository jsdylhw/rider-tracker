export function collectElements(ids) {
    return Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
}

export function collectNamedElements(name) {
    return [...document.querySelectorAll(`[name="${name}"]`)];
}
