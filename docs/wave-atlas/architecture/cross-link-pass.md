# Cross-Link Pass

The second pass links the highest-value runtime nodes without inventing uncertain edges.

```text
PowerShell integration
  -> OSC 16162 C/D and OSC 7
  -> PTY byte stream
  -> ShellController read loop
  -> HandleAppendBlockFile / terminal block file
  -> RPC/event transport and frontend
  -> TermWrap / xterm.js
```

Verified/static relationships:

- `ShellController` calls `HandleAppendBlockFile` for terminal output.
- `WshServer.ControllerAppendOutputCommand` calls the same file append seam.
- `TermWrap` registers the OSC 16162 handler, which dispatches to `handleOsc16162Command`.
- Shell integration emits lifecycle and cwd markers; the current frontend consumes them.
- `TabRpcClient` is the frontend RPC boundary; `wshserver` owns backend handlers.

B2+ implication: observe raw output at the backend append seam and decode lifecycle markers in a backend/domain adapter independent of React/xterm state. Keep the byte stream flowing to xterm.js unchanged.
