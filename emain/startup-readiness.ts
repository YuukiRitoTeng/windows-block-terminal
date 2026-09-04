export type StartupReadinessGate = {
    promise: Promise<boolean>;
    settle: (ready: boolean) => void;
    isReady: () => boolean;
};

export type WaveSrvStartParams = {
    wsEndpoint: string;
    webEndpoint: string;
    version: string;
    buildTime: number;
};

export function parseWaveSrvStartLine(line: string): WaveSrvStartParams | null {
    const startParams = /ws:([a-z0-9.:]+) web:([a-z0-9.:]+) version:([a-z0-9.-]+) buildtime:(\d+)/i.exec(line);
    if (startParams == null) {
        return null;
    }
    return {
        wsEndpoint: startParams[1],
        webEndpoint: startParams[2],
        version: startParams[3],
        buildTime: parseInt(startParams[4]),
    };
}

export function createStartupReadinessGate(): StartupReadinessGate {
    let settled = false;
    let readyState = false;
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
            readyState = ready;
            resolvePromise(ready);
        },
        isReady: () => settled && readyState,
    };
}
