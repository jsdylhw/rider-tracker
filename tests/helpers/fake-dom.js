export function createFakeClassList() {
    const set = new Set();
    return {
        add(name) { set.add(name); },
        remove(name) { set.delete(name); },
        contains(name) { return set.has(name); },
        toggle(name, force) {
            if (force === true) {
                set.add(name);
                return true;
            }
            if (force === false) {
                set.delete(name);
                return false;
            }
            if (set.has(name)) {
                set.delete(name);
                return false;
            }
            set.add(name);
            return true;
        }
    };
}

export function createFakeElement(initial = {}) {
    const listeners = new Map();
    const element = {
        hidden: false,
        disabled: false,
        textContent: "",
        innerHTML: "",
        value: "",
        style: {},
        className: "",
        classList: createFakeClassList(),
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        dispatch(type, payload = {}) {
            const handlers = listeners.get(type) ?? [];
            for (const handler of handlers) {
                handler({ target: element, ...payload });
            }
        },
        querySelectorAll() {
            return [];
        },
        appendChild() {}
    };

    return Object.assign(element, initial);
}
