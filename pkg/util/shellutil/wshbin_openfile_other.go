// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package shellutil

import "os"

// openFileShared opens path for reading. On unix there is no mandatory sharing mode, so a plain
// open already behaves correctly alongside a concurrent replacing rename.
func openFileShared(path string) (*os.File, error) {
	return os.Open(path)
}
