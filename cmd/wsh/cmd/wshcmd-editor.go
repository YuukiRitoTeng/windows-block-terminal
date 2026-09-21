// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
)

var editorCmd = &cobra.Command{
	Use:     "editor",
	Short:   "edit a file (blocks until editor is closed)",
	RunE:    editorRun,
	PreRunE: preRunSetupRpcClient,
}

func init() {
	rootCmd.AddCommand(editorCmd)
}

func editorRun(cmd *cobra.Command, args []string) (rtnErr error) {
	defer func() {
		sendActivity("editor", rtnErr == nil)
	}()
	if len(args) == 0 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("no arguments.  wsh editor requires a file or URL as an argument argument")
	}
	if len(args) > 1 {
		OutputHelpMessage(cmd)
		return fmt.Errorf("too many arguments.  wsh editor requires exactly one argument")
	}
	fileArg := args[0]
	resolved, err := resolveEditTarget(RpcContext.Conn, fileArg)
	if err != nil {
		return err
	}
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("no WAVETERM_TABID env var set")
	}
	if resolved.kind == editTargetTerminal {
		return createRemoteEditorTerminal(tabId, resolved.connection, resolved.target, true)
	}
	target := resolved.target
	if !isExternalURL(fileArg) && conncontroller.IsLocalConnName(resolved.connection) {
		absFile, err := filepath.Abs(target)
		if err != nil {
			return fmt.Errorf("getting absolute path: %w", err)
		}
		_, err = os.Stat(absFile)
		if err == fs.ErrNotExist {
			return fmt.Errorf("file does not exist: %q", absFile)
		}
		if err != nil {
			return fmt.Errorf("getting file info: %w", err)
		}
		target = absFile
	}

	_, err = wshclient.PathCommand(RpcClient, wshrpc.PathCommandData{
		Path:         target,
		OpenExternal: true,
		TabId:        tabId,
	}, &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("opening file externally: %w", err)
	}
	return nil
}

func createRemoteEditorTerminal(tabId string, connection string, target string, waitForClose bool) error {
	blockRef, err := wshclient.CreateBlockCommand(RpcClient, buildRemoteEditorBlockData(tabId, connection, target), &wshrpc.RpcOpts{Timeout: 2000})
	if err != nil {
		return fmt.Errorf("creating remote Terminal editor: %w", err)
	}
	if !waitForClose {
		return nil
	}
	doneCh := make(chan struct{})
	var closeOnce sync.Once
	RpcClient.EventListener.On(wps.Event_BlockClose, func(event *wps.WaveEvent) {
		if event.HasScope(blockRef.String()) {
			closeOnce.Do(func() { close(doneCh) })
		}
	})
	if err := wshclient.EventSubCommand(RpcClient, wps.SubscriptionRequest{
		Event:  wps.Event_BlockClose,
		Scopes: []string{blockRef.String()},
	}, &wshrpc.RpcOpts{Timeout: 2000}); err != nil {
		return fmt.Errorf("subscribing to remote Terminal editor close: %w", err)
	}
	<-doneCh
	return nil
}
