package commandjournal

import (
	"bytes"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func hostedReady(c *HostedRuntimeConsumer) {
	c.ObserveHostedRuntimeEvent(shellexec.HostedRuntimeEvent{Kind: "hello", HostID: "host-1"})
	c.ObserveHostedRuntimeEvent(shellexec.HostedRuntimeEvent{Kind: "runtime_ready", HostID: "host-1", RunspaceID: "runspace-1"})
}

func hostedStart(id, mode string) shellexec.HostedRuntimeEvent {
	return shellexec.HostedRuntimeEvent{Kind: "command_started", HostID: "host-1", RunspaceID: "runspace-1", CommandID: id, Command: id, Cwd: `C:\tmp`, Mode: mode}
}

func hostedOutput(id, data string) shellexec.HostedRuntimeEvent {
	return shellexec.HostedRuntimeEvent{Kind: "output", HostID: "host-1", RunspaceID: "runspace-1", CommandID: id, Mode: "structured", Stream: "success", Data: data}
}

func hostedFinish(id string, success bool, exitCode int) shellexec.HostedRuntimeEvent {
	return shellexec.HostedRuntimeEvent{Kind: "command_finished", HostID: "host-1", RunspaceID: "runspace-1", CommandID: id, Success: &success, ExitCode: &exitCode}
}

func TestHostedRuntimeConsumerBuildsAuthoritativeRecord(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "hello "))
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "world\r\n"))
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))

	records := j.Snapshot("block-hosted")
	if len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	record := records[0]
	if !bytes.Equal(record.Output, []byte("hello world\r\n")) || record.State != StateFinished || record.OutputState != OutputStateClosed || record.OutputCompleteness != OutputCompletenessComplete || record.OutputAttribution != OutputAttributionExclusive || record.OutputTextSafety != OutputTextSafetyPlain {
		t.Fatalf("unexpected hosted record: %#v", record)
	}
	if record.OutputSource != terminalruntime.OutputSourceHostStructured || record.ExecutionMode != terminalruntime.ExecutionModeStructured || record.Success == nil || !*record.Success || record.ExitCode == nil || *record.ExitCode != 0 {
		t.Fatalf("unexpected hosted metadata: %#v", record)
	}
}

func TestHostedRuntimeConsumerSeparatesConsecutiveCommands(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	for _, item := range []struct{ id, output string }{{"cmd-a", "A"}, {"cmd-b", "B"}} {
		c.ObserveHostedRuntimeEvent(hostedStart(item.id, "structured"))
		c.ObserveHostedRuntimeEvent(hostedOutput(item.id, item.output))
		c.ObserveHostedRuntimeEvent(hostedFinish(item.id, true, 0))
	}
	records := j.Snapshot("block-hosted")
	if len(records) != 2 || string(records[0].Output) != "A" || string(records[1].Output) != "B" || records[0].ID != "cmd-a" || records[1].ID != "cmd-b" {
		t.Fatalf("commands crossed records: %#v", records)
	}
	if records[1].StartHookSequence <= records[0].FinishHookSequence {
		t.Fatalf("lifecycle sequence did not advance: %#v", records)
	}
}

func TestHostedRuntimeConsumerDoesNotDuplicatePTYOutput(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	if j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Source: terminalruntime.OutputSourcePTY, Output: []byte("echo\r\n")}, time.Now()) {
		t.Fatal("PTY bytes became authoritative for hosted command")
	}
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "actual-output\r\n"))
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))
	record := j.Snapshot("block-hosted")[0]
	if string(record.Output) != "actual-output\r\n" {
		t.Fatalf("PTY output duplicated into record: %#v", record)
	}
}

func TestHostedRuntimeConsumerPreservesExitSemantics(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		success  bool
		exitCode int
	}{
		{name: "direct native failure", id: "native", success: false, exitCode: 7},
		{name: "powershell failure", id: "throw", success: false, exitCode: 1},
		{name: "mixed pipeline", id: "mixed", success: false, exitCode: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			j := New()
			c := NewHostedRuntimeConsumer("block-hosted", j)
			hostedReady(c)
			c.ObserveHostedRuntimeEvent(hostedStart(test.id, "structured"))
			c.ObserveHostedRuntimeEvent(hostedFinish(test.id, test.success, test.exitCode))
			record := j.Snapshot("block-hosted")[0]
			if record.Success == nil || *record.Success != test.success || record.ExitCode == nil || *record.ExitCode != test.exitCode {
				t.Fatalf("exit semantics changed: %#v", record)
			}
		})
	}
}

func TestHostedRuntimeConsumerPreservesInterruptedSemantics(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("interrupted", "structured"))
	code := 1
	success := false
	c.ObserveHostedRuntimeEvent(shellexec.HostedRuntimeEvent{
		Kind:        "command_finished",
		HostID:      "host-1",
		RunspaceID:  "runspace-1",
		CommandID:   "interrupted",
		Success:     &success,
		ExitCode:    &code,
		Interrupted: true,
	})
	records := j.Snapshot("block-hosted")
	if len(records) != 1 || records[0].CompletionReason != CompletionInterrupted || records[0].Success == nil || *records[0].Success || records[0].ExitCode == nil || *records[0].ExitCode == 0 || records[0].OutputCompleteness != OutputCompletenessUnknown || records[0].OutputAttribution != OutputAttributionUnknown {
		t.Fatalf("interrupted semantics were not preserved: %#v", records)
	}
}

func TestHostedRuntimeConsumerRejectsStaleIdentity(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	stale := hostedStart("stale", "structured")
	stale.HostID = "old-host"
	c.ObserveHostedRuntimeEvent(stale)
	if len(j.Snapshot("block-hosted")) != 0 {
		t.Fatal("stale host created a record")
	}
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	foreignOutput := hostedOutput("cmd-1", "wrong-session")
	foreignOutput.RunspaceID = "old-runspace"
	c.ObserveHostedRuntimeEvent(foreignOutput)
	foreignFinish := hostedFinish("cmd-1", false, 9)
	foreignFinish.HostID = "old-host"
	c.ObserveHostedRuntimeEvent(foreignFinish)
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "right-session"))
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))
	record := j.Snapshot("block-hosted")[0]
	if string(record.Output) != "right-session" || record.Success == nil || !*record.Success || record.ExitCode == nil || *record.ExitCode != 0 {
		t.Fatalf("stale identity contaminated record: %#v", record)
	}
	c.Close()
	c.ObserveHostedRuntimeEvent(hostedStart("late", "structured"))
	if len(j.Snapshot("block-hosted")) != 1 {
		t.Fatal("late event after consumer close changed journal")
	}
}

func TestHostedRuntimeConsumerAbortsStructuredCommandOnSidechannelDisconnect(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "partial"))
	c.ObserveHostedRuntimeDisconnect()
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "late"))
	finished := true
	exitCode := 0
	c.ObserveHostedRuntimeEvent(shellexec.HostedRuntimeEvent{Kind: "command_finished", HostID: "host-1", RunspaceID: "runspace-1", CommandID: "cmd-1", Success: &finished, ExitCode: &exitCode})
	records := j.Snapshot("block-hosted")
	if len(records) != 1 {
		t.Fatalf("unexpected records: %#v", records)
	}
	record := records[0]
	if record.State != StateAborted || record.CompletionReason != CompletionSidechannelDisconnected || string(record.Output) != "partial" || record.Success != nil || record.ExitCode != nil || record.OutputCompleteness == OutputCompletenessComplete || record.OutputAttribution != OutputAttributionUnknown {
		t.Fatalf("unexpected disconnect semantics: %#v", record)
	}
	c.ObserveHostedRuntimeDisconnect()
	if len(j.Snapshot("block-hosted")) != 1 {
		t.Fatal("disconnect was not idempotent")
	}
}

func TestHostedRuntimeConsumerDisconnectPreservesInteractivePTYAuthority(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("interactive", "interactive"))
	c.ObserveHostedRuntimeDisconnect()
	if !j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Source: terminalruntime.OutputSourcePTY, Output: []byte("pty-output")}, time.Now()) {
		t.Fatal("PTY output was blocked after hosted sidechannel disconnect")
	}
	j.mu.RLock()
	active := j.active["block-hosted"]
	j.mu.RUnlock()
	if active == nil || active.ID != "interactive" {
		t.Fatalf("interactive command was incorrectly aborted: %#v", active)
	}
}

func TestHostedRuntimeConsumerClosePreservesControllerStopReason(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.Close()
	c.ObserveHostedRuntimeDisconnect()
	if !j.AbortActive("block-hosted", CompletionControllerStop, time.Now()) {
		t.Fatal("controller teardown did not abort active command")
	}
	records := j.Snapshot("block-hosted")
	if len(records) != 1 || records[0].CompletionReason != CompletionControllerStop {
		t.Fatalf("controlled teardown reason was changed: %#v", records)
	}
}

func TestHostedRuntimeInteractiveIsNotExactStructuredOutput(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("python", "interactive"))
	c.ObserveHostedRuntimeEvent(hostedOutput("python", "should-not-be-authoritative"))
	c.ObserveHostedRuntimeEvent(hostedFinish("python", true, 0))
	record := j.Snapshot("block-hosted")[0]
	if record.ExecutionMode != terminalruntime.ExecutionModeInteractive || record.OutputState != OutputStatePending || record.OutputCompleteness == OutputCompletenessComplete || record.OutputAttribution != OutputAttributionUnknown || len(record.Output) != 0 {
		t.Fatalf("interactive output was overclaimed: %#v", record)
	}
}

func TestHostedInteractiveFinishRetainsDelayedPTYOutput(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("python", "interactive"))
	c.ObserveHostedRuntimeEvent(hostedFinish("python", true, 0))
	if !j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Source: terminalruntime.OutputSourcePTY, Output: []byte("delayed-output\r\n")}, time.Now()) {
		t.Fatal("delayed interactive PTY output was dropped")
	}
	record := j.Snapshot("block-hosted")[0]
	if record.OutputState != OutputStatePending || string(record.Output) != "delayed-output\r\n" || record.OutputCompleteness == OutputCompletenessComplete || record.OutputAttribution == OutputAttributionExclusive {
		t.Fatalf("interactive output was finalized or overclaimed: %#v", record)
	}
	if !j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{Kind: terminalruntime.EventPromptReady}}, time.Now()) {
		t.Fatal("prompt did not close pending interactive output")
	}
	record = j.Snapshot("block-hosted")[0]
	if record.OutputState != OutputStateClosed || record.OutputCompleteness == OutputCompletenessComplete || record.OutputAttribution != OutputAttributionUnknown || string(record.Output) != "delayed-output\r\n" {
		t.Fatalf("interactive delayed output boundary was incorrect: %#v", record)
	}
}

func TestHostedStructuredFinishIsNotPTYOutputFence(t *testing.T) {
	j := New()
	c := NewHostedRuntimeConsumer("block-hosted", j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "structured-output"))
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))
	if j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{Kind: terminalruntime.EventPromptReady}}, time.Now()) {
		t.Fatal("prompt unexpectedly changed closed hosted output")
	}
	if j.Apply("block-hosted", terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Source: terminalruntime.OutputSourcePTY, Output: []byte("prompt\r\n")}, time.Now()) {
		t.Fatal("post-finish PTY bytes were attributed to hosted command")
	}
	record := j.Snapshot("block-hosted")[0]
	if string(record.Output) != "structured-output" || record.OutputCompleteness != OutputCompletenessComplete || record.OutputState != OutputStateClosed {
		t.Fatalf("host structured finalization changed: %#v", record)
	}
}
