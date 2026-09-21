// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestPathCommandAcceptsExplicitExternalTarget(t *testing.T) {
	const target = "https://example.com"

	got, err := (&WshServer{}).PathCommand(context.Background(), wshrpc.PathCommandData{Path: target})
	if err != nil {
		t.Fatalf("PathCommand returned error: %v", err)
	}
	if got != target {
		t.Fatalf("PathCommand returned %q, want %q", got, target)
	}
}

func TestPathCommandRejectsMissingTarget(t *testing.T) {
	if _, err := (&WshServer{}).PathCommand(context.Background(), wshrpc.PathCommandData{}); err == nil {
		t.Fatal("PathCommand accepted an empty target")
	}
}
