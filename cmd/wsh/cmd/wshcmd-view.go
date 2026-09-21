// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var viewCmd = &cobra.Command{
	Use:     "view {file|directory|URL}",
	Aliases: []string{"preview", "open"},
	Short:   "preview/edit a file or directory",
	RunE:    viewRun,
	PreRunE: preRunSetupRpcClient,
}

var editCmd = &cobra.Command{
	Use:     "edit {file}",
	Short:   "edit a file",
	RunE:    viewRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	rootCmd.AddCommand(viewCmd)
	rootCmd.AddCommand(editCmd)
}

func openExternalTarget(tabId string, target string) error {
	_, err := wshclient.PathCommand(RpcClient, wshrpc.PathCommandData{
		Path:         target,
		OpenExternal: true,
		TabId:        tabId,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("opening target externally: %w", err)
	}
	return nil
}

func viewRun(cmd *cobra.Command, args []string) (rtnErr error) {
	cmdName := cmd.Name()
	defer func() {
		sendActivity(cmdName, rtnErr == nil)
	}()
	if len(args) == 0 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("no arguments.  wsh %s requires a file or URL as an argument argument", cmdName)
	}
	if len(args) > 1 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("too many arguments.  wsh %s requires exactly one argument", cmdName)
	}
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	fileArg := args[0]
	var resolved editTarget
	var err error
	if cmdName == "edit" {
		resolved, err = resolveEditTarget(RpcContext.Conn, fileArg)
	} else {
		resolved, err = resolveViewTarget(RpcContext.Conn, fileArg)
	}
	if err != nil {
		return err
	}
	if resolved.kind != editTargetExternal {
		if cmdName != "edit" {
			return fmt.Errorf("%s target cannot use the Terminal editor route", cmdName)
		}
		return createRemoteEditorTerminal(tabId, resolved.connection, resolved.target, false)
	}
	if isExternalURL(fileArg) || !conncontroller.IsLocalConnName(resolved.connection) {
		return openExternalTarget(tabId, resolved.target)
	}
	absFile, err := filepath.Abs(resolved.target)
	if err != nil {
		return fmt.Errorf("getting absolute path: %w", err)
	}
	absParent, err := filepath.Abs(filepath.Dir(resolved.target))
	if err != nil {
		return fmt.Errorf("getting absolute path of parent dir: %w", err)
	}
	_, err = os.Stat(absParent)
	if err == fs.ErrNotExist {
		return fmt.Errorf("parent directory does not exist: %q", absParent)
	}
	if err != nil {
		return fmt.Errorf("getting file info: %w", err)
	}
	return openExternalTarget(tabId, absFile)
}
