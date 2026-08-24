# Frontend Runtime

React workspace/tab/view composition mounts terminal views. rontend/app/view/term/termwrap.ts owns xterm.js setup, input forwarding, resize, reconnect and OSC registration; osc-handlers.ts interprets OSC 52/7/16162. Store/RPC utilities under rontend/app/store/ bridge frontend state to backend handlers. Command History should mount beside, not replace, the active xterm path.