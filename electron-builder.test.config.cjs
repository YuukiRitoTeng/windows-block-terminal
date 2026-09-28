// Test-build packaging config.
//
// This exists so a `--dir` test build can be told apart from a release build at runtime. The base
// configuration is used unchanged for release artifacts, so a release build carries no channel
// marker and therefore never shows the DEV badge; only builds made with this config do.
//
// `extraMetadata` writes the field into the packaged package.json, which is the one manifest that
// actually ships inside app.asar. The value is a literal (not a macro) because electron-builder's
// macro expansion treats `%` sequences as packaging-time macros, which would corrupt a date string.
const base = require("./electron-builder.config.cjs");

module.exports = {
    ...base,
    extraMetadata: {
        ...(base.extraMetadata ?? {}),
        buildChannel: "test",
    },
};
