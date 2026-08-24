# Keep / Hide / Remove Candidates

## KEEP

PTY and shell lifecycle, ShellController, blockcontroller, xterm/TermWrap, shell integration, RPC/event transport, workspace/session lifecycle, filestore and Windows packaging.

## KEEP + HOOK / WRAP

HandleAppendBlockFile, OSC decoding boundary, terminal stream subscriptions, block metadata and frontend terminal mounting. These are the likely seams for TerminalRuntimeAdapter and Command Journal observation.

## HIDE FIRST

AI/Agent, Browser, Editor, Widgets and Preview UI can be feature-flagged/hidden after dependency tracing. Their shared RPC, workspace, file and startup registrations remain coupled until proven otherwise.

## REMOVE CANDIDATE

Only isolated product-only views or registrations proven not to participate in startup, RPC, block, workspace or shared model paths. No deletion decision is made by this Atlas.