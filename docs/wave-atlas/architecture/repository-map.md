# Repository Map

Wave is a Go backend plus Electron/TypeScript/React frontend. main/ is the Electron-side startup boundary; pkg/ contains backend services, controllers, RPC and persistence; rontend/ contains React views, stores and terminal presentation; db/ and pkg/filestore/ provide persistence; cmd/ contains auxiliary binaries; uild/, workflows and package manifests provide build/release machinery.

Runtime-critical landmarks: pkg/blockcontroller/, pkg/util/shellutil/, pkg/wshrpc/, pkg/wshutil/, rontend/app/view/term/, rontend/app/store/, and main/.