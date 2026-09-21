// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestResolveEditTargetPreservesLocalAndURLExternalRoutes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		connection string
		target     string
		wantKind   editTargetKind
		wantTarget string
	}{
		{
			name:       "local file",
			connection: "local",
			target:     `C:\work\notes.txt`,
			wantKind:   editTargetExternal,
			wantTarget: `C:\work\notes.txt`,
		},
		{
			name:       "url from remote shell remains a URL",
			connection: "ssh:user@example.com",
			target:     "https://example.com/docs",
			wantKind:   editTargetExternal,
			wantTarget: "https://example.com/docs",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveEditTarget(tc.connection, tc.target)
			if err != nil {
				t.Fatalf("resolveEditTarget() error = %v", err)
			}
			if got.kind != tc.wantKind || got.target != tc.wantTarget {
				t.Fatalf("resolveEditTarget() = %#v, want kind=%v target=%q", got, tc.wantKind, tc.wantTarget)
			}
		})
	}
}

func TestResolveEditTargetUsesExactWSLDistroInterop(t *testing.T) {
	got, err := resolveEditTarget("wsl://Ubuntu-22.04", "/home/me/notes with spaces.txt")
	if err != nil {
		t.Fatalf("resolveEditTarget() error = %v", err)
	}
	if got.kind != editTargetExternal {
		t.Fatalf("resolveEditTarget() kind = %v, want external", got.kind)
	}
	want := `\\wsl.localhost\Ubuntu-22.04\home\me\notes with spaces.txt`
	if got.target != want {
		t.Fatalf("resolveEditTarget() target = %q, want %q", got.target, want)
	}
	if strings.Contains(got.target, "/home/") {
		t.Fatalf("raw WSL POSIX path leaked to external target: %q", got.target)
	}
}

func TestResolveViewTargetUsesExactWSLDistroInterop(t *testing.T) {
	got, err := resolveViewTarget("wsl://Ubuntu-22.04", "/home/me/readme.md")
	if err != nil {
		t.Fatalf("resolveViewTarget() error = %v", err)
	}
	if got.kind != editTargetExternal {
		t.Fatalf("resolveViewTarget() kind = %v, want external", got.kind)
	}
	want := `\\wsl.localhost\Ubuntu-22.04\home\me\readme.md`
	if got.target != want {
		t.Fatalf("resolveViewTarget() target = %q, want %q", got.target, want)
	}
	if strings.Contains(got.target, "/home/") {
		t.Fatalf("raw WSL POSIX path leaked to external target: %q", got.target)
	}
}

func TestResolveEditTargetRoutesSSHToSameConnectionTerminal(t *testing.T) {
	const connection = "ssh:alice@example.com:2222"
	const target = "/srv/project/notes with spaces.txt"

	got, err := resolveEditTarget(connection, target)
	if err != nil {
		t.Fatalf("resolveEditTarget() error = %v", err)
	}
	if got.kind != editTargetTerminal {
		t.Fatalf("resolveEditTarget() kind = %v, want terminal", got.kind)
	}
	if got.connection != connection {
		t.Fatalf("resolveEditTarget() connection = %q, want %q", got.connection, connection)
	}
	command := buildRemoteEditorCommand(target)
	if !strings.Contains(command, "$VISUAL") || !strings.Contains(command, "$EDITOR") {
		t.Fatalf("remote editor command does not select VISUAL then EDITOR: %q", command)
	}
	if !strings.Contains(command, `'/srv/project/notes with spaces.txt'`) {
		t.Fatalf("remote path is not shell-safe in command: %q", command)
	}
	if strings.Contains(command, "open.Run") || strings.Contains(command, "openExternal") {
		t.Fatalf("remote editor command contains a local opener: %q", command)
	}
}

func TestResolveEditTargetPreservesExplicitRemoteURIConnection(t *testing.T) {
	got, err := resolveEditTarget("local", "wsh://ssh:alice@example.com:2222/srv/project/notes.txt")
	if err != nil {
		t.Fatalf("resolveEditTarget() error = %v", err)
	}
	if got.kind != editTargetTerminal {
		t.Fatalf("resolveEditTarget() kind = %v, want terminal", got.kind)
	}
	if got.connection != "ssh:alice@example.com:2222" {
		t.Fatalf("resolveEditTarget() connection = %q, want exact SSH connection", got.connection)
	}
	if got.target != "/srv/project/notes.txt" {
		t.Fatalf("resolveEditTarget() target = %q, want remote POSIX path", got.target)
	}
}

func TestResolveViewTargetRejectsSSHWithoutLocalReinterpretation(t *testing.T) {
	_, err := resolveViewTarget("ssh:alice@example.com:2222", "/srv/project/notes.txt")
	if err == nil {
		t.Fatal("resolveViewTarget() accepted deferred SSH view")
	}
	if !strings.Contains(err.Error(), "SSH") && !strings.Contains(err.Error(), "remote") {
		t.Fatalf("resolveViewTarget() error = %q, want explicit remote/view error", err)
	}
}

func TestWebOpenAcceptsURLsOnly(t *testing.T) {
	for _, target := range []string{"http://example.com", "https://example.com/path?q=1"} {
		if !isExternalURL(target) {
			t.Fatalf("isExternalURL(%q) = false, want true", target)
		}
	}
	for _, target := range []string{"/tmp/file.txt", `C:\work\file.txt`, "wsh://ssh:host/etc/hosts"} {
		if isExternalURL(target) {
			t.Fatalf("isExternalURL(%q) = true, want false", target)
		}
	}
}

func TestBuildRemoteEditorBlockUsesTerminalAndExactConnection(t *testing.T) {
	data := buildRemoteEditorBlockData("tab-1", "ssh:alice@example.com:2222", "/srv/notes.txt")
	if data.TabId != "tab-1" || data.BlockDef == nil {
		t.Fatalf("unexpected block data: %#v", data)
	}
	meta := data.BlockDef.Meta
	if meta.GetString(waveobj.MetaKey_View, "") != "term" {
		t.Fatalf("view = %q, want term", meta.GetString(waveobj.MetaKey_View, ""))
	}
	if meta.GetString(waveobj.MetaKey_Controller, "") != "shell" {
		t.Fatalf("controller = %q, want shell", meta.GetString(waveobj.MetaKey_Controller, ""))
	}
	if meta.GetString(waveobj.MetaKey_Connection, "") != "ssh:alice@example.com:2222" {
		t.Fatalf("connection = %q", meta.GetString(waveobj.MetaKey_Connection, ""))
	}
	if !meta.GetBool(waveobj.MetaKey_CmdRunOnce, false) || !meta.GetBool(waveobj.MetaKey_CmdRunOnStart, false) {
		t.Fatalf("remote editor block is not configured as a run-once Terminal")
	}
	if !meta.GetBool(waveobj.MetaKey_CmdCloseOnExitForce, false) {
		t.Fatalf("waitable remote editor block must close on exit")
	}
	if data.TargetAction != "" {
		t.Fatalf("remote editor block unexpectedly uses a target action: %q", data.TargetAction)
	}
	if !strings.Contains(meta.GetString(waveobj.MetaKey_Cmd, ""), "$VISUAL") {
		t.Fatalf("editor command missing VISUAL fallback: %q", meta.GetString(waveobj.MetaKey_Cmd, ""))
	}
}
