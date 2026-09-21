// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/remote/connparse"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

type editTargetKind string

const (
	editTargetExternal editTargetKind = "external"
	editTargetTerminal editTargetKind = "terminal"
)

type editTarget struct {
	kind       editTargetKind
	connection string
	target     string
}

func isExternalURL(target string) bool {
	return strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://")
}

func resolveEditTarget(connection string, target string) (editTarget, error) {
	connection, target, err := resolveTargetConnection(connection, target)
	if err != nil {
		return editTarget{}, err
	}
	if isExternalURL(target) || conncontroller.IsLocalConnName(connection) {
		return editTarget{kind: editTargetExternal, connection: connection, target: target}, nil
	}
	if conncontroller.IsWslConnName(connection) {
		windowsPath, err := makeWSLInteropPath(connection, target)
		if err == nil {
			return editTarget{kind: editTargetExternal, connection: connection, target: windowsPath}, nil
		}
		return editTarget{kind: editTargetTerminal, connection: connection, target: target}, nil
	}
	return editTarget{kind: editTargetTerminal, connection: connection, target: target}, nil
}

func resolveViewTarget(connection string, target string) (editTarget, error) {
	connection, target, err := resolveTargetConnection(connection, target)
	if err != nil {
		return editTarget{}, err
	}
	if isExternalURL(target) || conncontroller.IsLocalConnName(connection) {
		return editTarget{kind: editTargetExternal, connection: connection, target: target}, nil
	}
	if conncontroller.IsWslConnName(connection) {
		windowsPath, err := makeWSLInteropPath(connection, target)
		if err != nil {
			return editTarget{}, fmt.Errorf("cannot view WSL path without exact distro-aware Windows interop: %w", err)
		}
		return editTarget{kind: editTargetExternal, connection: connection, target: windowsPath}, nil
	}
	return editTarget{}, fmt.Errorf("SSH/remote view is deferred; refusing to reinterpret %q as a local Windows path", target)
}

func resolveTargetConnection(connection string, target string) (string, string, error) {
	if !strings.HasPrefix(target, "wsh://") && !strings.HasPrefix(target, "//") {
		if connection == "" {
			return "local", target, nil
		}
		return connection, target, nil
	}
	parsed, err := connparse.ParseURI(target)
	if err != nil {
		return "", "", fmt.Errorf("parsing target connection: %w", err)
	}
	if parsed.Scheme != connparse.ConnectionTypeWsh {
		return "", "", fmt.Errorf("unsupported target scheme %q", parsed.Scheme)
	}
	if parsed.Host == connparse.ConnHostCurrent {
		parsed.Host = connection
	}
	if parsed.Host == "" {
		parsed.Host = "local"
	}
	return parsed.Host, parsed.Path, nil
}

func makeWSLInteropPath(connection string, target string) (string, error) {
	const prefix = "wsl://"
	distro := strings.TrimPrefix(connection, prefix)
	if distro == "" || strings.ContainsAny(distro, `\/:`) {
		return "", fmt.Errorf("missing exact WSL distro in connection %q", connection)
	}
	if !strings.HasPrefix(target, "/") {
		return "", fmt.Errorf("WSL path must be absolute POSIX path, got %q", target)
	}
	return `\\wsl.localhost\` + distro + strings.ReplaceAll(target, "/", `\`), nil
}

func buildRemoteEditorCommand(target string) string {
	quotedTarget := utilfn.ShellQuote(target, true, -1)
	return fmt.Sprintf(`if [ -n "${VISUAL:-}" ]; then exec "$VISUAL" -- %s; elif [ -n "${EDITOR:-}" ]; then exec "$EDITOR" -- %s; else printf 'neither $VISUAL nor $EDITOR is set\n' >&2; exit 127; fi`, quotedTarget, quotedTarget)
}

func buildRemoteEditorBlockData(tabID string, connection string, target string) wshrpc.CommandCreateBlockData {
	meta := map[string]any{
		waveobj.MetaKey_View:                "term",
		waveobj.MetaKey_Controller:          "shell",
		waveobj.MetaKey_Connection:          connection,
		waveobj.MetaKey_Cmd:                 buildRemoteEditorCommand(target),
		waveobj.MetaKey_CmdShell:            true,
		waveobj.MetaKey_CmdRunOnce:          true,
		waveobj.MetaKey_CmdRunOnStart:       true,
		waveobj.MetaKey_CmdCloseOnExitForce: true,
	}
	return wshrpc.CommandCreateBlockData{
		TabId:    tabID,
		BlockDef: &waveobj.BlockDef{Meta: meta},
		Focused:  true,
	}
}
