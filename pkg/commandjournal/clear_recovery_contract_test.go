// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package commandjournal

import (
	"testing"
	"time"
)

// oscFrames builds the in-band stream one command produces.
func oscFrames(frames ...string) []byte {
	var raw []byte
	for _, frame := range frames {
		raw = append(raw, []byte("\x1b]16162;"+frame+"\a")...)
	}
	return raw
}

// waitFor polls the journal: the runtime observer applies bytes on its own goroutine.
// runningInBlock reports whether the block still holds a running command, read from the
// record itself.
func runningInBlock(j *Journal, blockID string) bool {
	record, ok := j.Active(blockID)
	return ok && record.State == StateRunning
}

func waitFor(t *testing.T, what string, match func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if match() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A prompt after a command whose finish frame was lost closes that command in the journal,
// while a prompt frame the decoder refuses leaves it running. This is the lifecycle fact
// layer that the Rail and the journal rely on; repaint no longer consults it.
func TestRunningAnswerFollowsDecoderRecovery(t *testing.T) {
	blockID := "block-clear-recovery"
	journal := New()
	observer := NewRuntimeObserver(blockID, journal)
	defer observer.Close()

	observer.ObserveOutput(blockID, oscFrames(
		`M;{"v":1,"epoch":"e1","seq":1,"shell":"pwsh"}`,
		`P;{"v":1,"epoch":"e1","seq":2}`,
		`C;{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1"}`,
	))
	waitFor(t, "the command to start", func() bool { return runningInBlock(journal, blockID) })

	// The visibility transaction advances the block's generation.
	before, err := journal.ClearVisualHistory(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if !runningInBlock(journal, blockID) {
		t.Fatal("the clear changed the command lifecycle")
	}

	// Ctrl+C in a real shell: no finish frame, the next prompt arrives instead, and the
	// backend closes the command.
	observer.ObserveOutput(blockID, oscFrames(`P;{"v":1,"epoch":"e1","seq":4}`))
	waitFor(t, "the prompt to close the lost finish", func() bool { return !runningInBlock(journal, blockID) })
	after, err := journal.ClearVisualHistory(blockID)
	if err != nil {
		t.Fatal(err)
	}
	if after <= before {
		t.Fatalf("generation did not advance: %d -> %d", before, after)
	}

	var closed *CommandRecord
	for _, record := range journal.Snapshot(blockID) {
		if record.ID == "cmd-1" {
			candidate := record
			closed = &candidate
		}
	}
	if closed == nil {
		t.Fatal("the recovered command produced no record")
	}
	// The backend closes the command through its abort path: the record is aborted with the
	// missing-finish reason, and nothing is running any more.
	if closed.State == StateRunning || closed.CompletionReason != CompletionMissingFinish {
		t.Fatalf("lost finish was not closed by the prompt: state=%q reason=%q", closed.State, closed.CompletionReason)
	}
}

// A prompt frame the decoder refuses must not change the lifecycle: a stale sequence cannot
// close a running command.
func TestStalePromptKeepsTheCommandRunning(t *testing.T) {
	blockID := "block-clear-stale"
	journal := New()
	observer := NewRuntimeObserver(blockID, journal)
	defer observer.Close()

	observer.ObserveOutput(blockID, oscFrames(
		`M;{"v":1,"epoch":"e1","seq":1,"shell":"pwsh"}`,
		`P;{"v":1,"epoch":"e1","seq":2}`,
		`C;{"v":1,"epoch":"e1","seq":5,"id":"cmd-1","nonce":"n1"}`,
		`P;{"v":1,"epoch":"e1","seq":4}`,
	))
	waitFor(t, "the command to start", func() bool { return runningInBlock(journal, blockID) })

	// Give the refused frame time to be processed: the stream is applied in order, so a
	// still-running command afterwards is the decoder's rejection of it.
	time.Sleep(200 * time.Millisecond)
	if !runningInBlock(journal, blockID) {
		t.Fatal("a stale prompt closed the running command")
	}
	if _, err := journal.ClearVisualHistory(blockID); err != nil {
		t.Fatal(err)
	}
	if !runningInBlock(journal, blockID) {
		t.Fatal("the clear changed the command lifecycle")
	}
}
