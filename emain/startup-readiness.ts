export type StartupReadinessGate = {
    promise: Promise<boolean>;
    settle: (ready: boolean) => void;
};

export function createStartupReadinessGate(): StartupReadinessGate {
    let settled = false;
    let resolvePromise: (ready: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        settle: (ready) => {
            if (settled) {
                return;
            }
            settled = true;
            resolvePromise(ready);
        },
    };
}
