# Backend Runtime

Go backend modules provide block/session controllers, shell integration helpers, RPC server handlers, remote helpers and file/persistence services. ShellController is the PTY-facing runtime owner; HandleAppendBlockFile is the output/file boundary; wshserver translates RPC calls to controller and persistence operations.