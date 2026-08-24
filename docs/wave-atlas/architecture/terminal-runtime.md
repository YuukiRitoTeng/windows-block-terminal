# Terminal Runtime

Terminal creation is centered on pkg/blockcontroller and ShellController. The controller owns shell process/PTy lifecycle, input routing, resize and output reads. Raw bytes are passed to HandleAppendBlockFile and the terminal file path; pkg/wshrpc/wshserver exposes controller operations. The frontend TermWrap owns xterm.js and registers OSC handlers, preserving terminal compatibility.

For B2+, the safest observation seam is before/at HandleAppendBlockFile plus an independent shell-integration decoder; do not rewrite the PTY read loop or treat the rotating terminal file as command-history storage.