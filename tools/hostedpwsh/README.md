# Hosted PowerShell runtime gate

This opt-in runtime is a production-adjacent feasibility seam for the Wave/ConPTY hosted-runtime gate.

It embeds one PowerShell SDK Runspace in one host process. The host process is launched in the same PTY slot normally used for local PowerShell when `WBT_HOSTED_PWSH=1` and `WBT_HOSTED_PWSH_EXE` points to the published executable.

Structured lifecycle/output events are sent over a loopback TCP sidechannel authenticated by a per-process token. The terminal-visible path remains the host process stdout/stderr and the Wave/xterm PTY path. The backend logs sidechannel metadata and output lengths; it does not re-render sidechannel output.

This is a gate only. It does not replace the default Wave PowerShell path, does not implement Command Cards, and does not freeze the final CommandRecord or RPC schema.
