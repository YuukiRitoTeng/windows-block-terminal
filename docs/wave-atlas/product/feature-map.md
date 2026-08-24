# Feature Map

| Feature | Frontend | Backend/shared | Candidate |
|---|---|---|---|
| Terminal | rontend/app/view/term | pkg/blockcontroller, PTY, wshrpc | KEEP + HOOK |
| Workspace/tabs | rontend/app/workspace, tab | pkg/wcore, workspace service | KEEP |
| Blocks | terminal/workspace views | blockcontroller, waveobj, filestore | KEEP + HOOK |
| AI/Agent | frontend AI views | AI RPC/services | HIDE FIRST; coupled shared RPC must remain |
| Browser/Editor/Widgets/Preview | feature views | app/file/RPC services | HIDE FIRST |
| Files/Settings/Themes | frontend stores/views | config, filestore, RPC | KEEP or HIDE by product scope |
| Auth/Cloud/Sync/Telemetry/Updates | startup/settings | shared services and release machinery | INVESTIGATE; do not remove by surface label |
| Remote/SSH | connection and terminal views | wshremote/connection services | KEEP for compatibility candidate |
| Window management/navigation | Electron/frontend shell | emain/startup | KEEP |