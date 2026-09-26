package commandjournal

import (
	"bytes"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func oscStart(blockID, epoch, id string, seq uint64) terminalruntime.StreamItem {
	success := true
	exitCode := 0
	_ = success
	_ = exitCode
	return terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventCommandStarted,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: epoch,
		HookSequence: seq,
		CommandID:    id,
		Command:      "Write-Output " + id,
		Cwd:          `C:\tmp`,
	}}
}

func oscFinish(epoch, id string, seq uint64, success bool, exitCode int) terminalruntime.StreamItem {
	return terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventCommandFinished,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: epoch,
		HookSequence: seq,
		CommandID:    id,
		Success:      &success,
		ExitCode:     &exitCode,
	}}
}

// The authority matrix: a native shell session is terminal-osc and nothing else.
func TestAuthorityMatrixTerminalOSC(t *testing.T) {
	j := New()
	blockID := "block-osc"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("terminal-osc start was not recorded")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("out")}, now) {
		t.Fatal("PTY output was not attributed")
	}
	if !j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 2, true, 0), now) {
		t.Fatal("terminal-osc finish was not recorded")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Authority != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("authority=%q want %q", records[0].Authority, terminalruntime.AuthorityTerminalOSC)
	}
	if records[0].OutputSource != terminalruntime.OutputSourcePTY {
		t.Fatalf("output source=%q want pty", records[0].OutputSource)
	}
	if records[0].RuntimeHostID != "" || records[0].RuntimeRunspaceID != "" {
		t.Fatalf("terminal-osc record carries hosted identity: %#v", records[0])
	}
	if got := j.Authority(blockID); got != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("latched authority=%q", got)
	}
}

// The authority matrix: an opted-in hosted session is hosted-sidechannel.
func TestAuthorityMatrixHostedSidechannel(t *testing.T) {
	j := New()
	blockID := "block-hosted-authority"
	c := NewHostedRuntimeConsumer(blockID, j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.ObserveHostedRuntimeEvent(hostedOutput("cmd-1", "hello"))
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))

	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Authority != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("authority=%q", records[0].Authority)
	}
	if records[0].OutputSource != terminalruntime.OutputSourceHostStructured {
		t.Fatalf("output source=%q", records[0].OutputSource)
	}
	if records[0].RuntimeHostID != "host-1" || records[0].RuntimeRunspaceID != "runspace-1" {
		t.Fatalf("hosted record lost its identity: %#v", records[0])
	}
	if got := j.Authority(blockID); got != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("latched authority=%q", got)
	}
}

// One session has exactly one authority: the other producer is refused, and no
// second record appears.
func TestAuthorityIsExclusivePerSession(t *testing.T) {
	j := New()
	blockID := "block-exclusive"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "osc-1", 1), now) {
		t.Fatal("terminal-osc start was not recorded")
	}

	c := NewHostedRuntimeConsumer(blockID, j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("hosted-1", "structured"))
	c.ObserveHostedRuntimeEvent(hostedOutput("hosted-1", "must not be attributed"))
	c.ObserveHostedRuntimeEvent(hostedFinish("hosted-1", true, 0))

	// The hosted producer names its own session epoch (the runspace), so this is
	// a different session: the latch is per session, and the active OSC command
	// keeps the block.
	records := j.Snapshot(blockID)
	if len(records) != 0 {
		t.Fatalf("hosted command took over an active terminal-osc session: %#v", records)
	}
	if _, active := j.Active(blockID); !active {
		t.Fatal("terminal-osc command is no longer active")
	}

	// The same session cannot switch authority either.
	if j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventCommandStarted,
		Authority:    terminalruntime.AuthorityHostedSidechannel,
		SessionEpoch: "shell-epoch-1",
		HookSequence: 2,
		CommandID:    "hosted-forged",
	}}, now) {
		t.Fatal("a second authority was accepted for the same session")
	}

	// A new shell session may use a different authority, once the previous
	// session's command is closed: a live command always owns the block.
	if j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventCommandStarted,
		Authority:    terminalruntime.AuthorityHostedSidechannel,
		SessionEpoch: "runspace-2",
		HookSequence: 1,
		CommandID:    "hosted-2",
	}}, now) {
		t.Fatal("a new authority started while another command was active")
	}
	if !j.AbortActive(blockID, CompletionSessionEnded, now) {
		t.Fatal("active terminal-osc command was not closed")
	}
	if !j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventCommandStarted,
		Authority:    terminalruntime.AuthorityHostedSidechannel,
		SessionEpoch: "runspace-2",
		HookSequence: 1,
		CommandID:    "hosted-2",
	}}, now) {
		t.Fatal("a new session could not latch its own authority")
	}
	if got := j.Authority(blockID); got != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("latched authority=%q", got)
	}
}

// A start without an explicit authority is refused: authority is never guessed.
func TestAuthorityMustBeExplicit(t *testing.T) {
	j := New()
	now := time.Now()
	item := oscStart("block-no-authority", "shell-epoch-1", "cmd-1", 1)
	item.Event.Authority = terminalruntime.AuthorityUnknown
	if j.Apply("block-no-authority", item, now) {
		t.Fatal("start without authority was accepted")
	}
}

// The in-band authority can never own sidechannel bytes, so it cannot present
// hosted output as its own.
func TestTerminalOSCCannotClaimHostStructuredOutput(t *testing.T) {
	j := New()
	now := time.Now()
	item := oscStart("block-forge", "shell-epoch-1", "cmd-1", 1)
	item.Event.OutputSource = terminalruntime.OutputSourceHostStructured
	if j.Apply("block-forge", item, now) {
		t.Fatal("terminal-osc start claimed hostStructured output")
	}
}

// A record is closed by the authority that opened it.
func TestOnlyOwningAuthorityCanFinish(t *testing.T) {
	j := New()
	blockID := "block-finish-authority"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("start was not recorded")
	}
	forged := oscFinish("shell-epoch-1", "cmd-1", 2, true, 0)
	forged.Event.Authority = terminalruntime.AuthorityHostedSidechannel
	if j.Apply(blockID, forged, now) {
		t.Fatal("a foreign authority closed the record")
	}
	if _, active := j.Active(blockID); !active {
		t.Fatal("record was closed by a foreign authority")
	}
	if !j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 3, true, 0), now) {
		t.Fatal("owning authority could not close the record")
	}
}

// Ctrl+C with no D: the shell returning to its prompt closes the command once.
func TestCtrlCWithoutFinishClosesOnce(t *testing.T) {
	j := New()
	blockID := "block-ctrlc"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("start was not recorded")
	}
	j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("partial")}, now)

	// The prompt is the fence: no D ever arrives for the interrupted command.
	prompt := terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventPromptReady,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "shell-epoch-1",
		HookSequence: 2,
	}}
	if !j.Apply(blockID, prompt, now) {
		t.Fatal("prompt fence did not close the interrupted command")
	}
	if j.Apply(blockID, prompt, now) {
		t.Fatal("the same prompt fence closed twice")
	}

	// A second Ctrl+C-style prompt must not invent another record.
	j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamIntegrationEvent, Event: terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventPromptReady,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "shell-epoch-1",
		HookSequence: 3,
	}}, now)

	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("records=%#v want exactly one finished command", records)
	}
	if records[0].Success != nil || records[0].ExitCode != nil {
		t.Fatalf("interrupted command fabricated a result: %#v", records[0])
	}
	// The bytes that did arrive are kept, but the record never claims they are
	// the complete output of the command.
	if !bytes.Equal(records[0].Output, []byte("partial")) {
		t.Fatalf("interrupted command lost its partial output: %#v", records[0])
	}
	if records[0].OutputCompleteness == OutputCompletenessComplete || records[0].OutputAttribution == OutputAttributionExclusive {
		t.Fatalf("interrupted command claimed complete output: %#v", records[0])
	}
	if records[0].OutputState != OutputStateClosed || records[0].State != StateAborted {
		t.Fatalf("interrupted command was not closed exactly once: %#v", records[0])
	}
	// The next command is accepted: the block is not wedged.
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-2", 4), now) {
		t.Fatal("a new command was refused after an interrupted one")
	}
}

// A duplicated D never finalizes a command twice.
func TestDuplicateFinishIsIgnored(t *testing.T) {
	j := New()
	blockID := "block-duplicate-d"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 2, true, 0), now) {
		t.Fatal("finish was not recorded")
	}
	if j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 3, false, 1), now) {
		t.Fatal("a duplicate finish was accepted")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("duplicate finish created records: %#v", records)
	}
	if records[0].Success == nil || !*records[0].Success || records[0].FinishHookSequence != 2 {
		t.Fatalf("duplicate finish changed the result: %#v", records[0])
	}
}

// Shell exit with an active command finalizes it exactly once, and a late D
// cannot rewrite it.
func TestSessionEndClosesActiveCommandOnce(t *testing.T) {
	j := New()
	blockID := "block-session-end"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("start was not recorded")
	}
	if !j.AbortActive(blockID, CompletionSessionEnded, now) {
		t.Fatal("session end did not close the active command")
	}
	if j.AbortActive(blockID, CompletionSessionEnded, now) {
		t.Fatal("session end closed the command twice")
	}
	if j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 2, true, 0), now) {
		t.Fatal("a late finish mutated a closed session")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].State != StateAborted || records[0].CompletionReason != CompletionSessionEnded {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Success != nil || records[0].ExitCode != nil {
		t.Fatalf("session end fabricated a result: %#v", records[0])
	}
}

// The native exit code reported by the shell is preserved for a native
// invocation, including a non-zero one.
func TestNativeExitCodeIsPreserved(t *testing.T) {
	j := New()
	blockID := "block-native-exit"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "shell-epoch-1", "cmd-1", 1), now) {
		t.Fatal("start was not recorded")
	}
	if !j.Apply(blockID, oscFinish("shell-epoch-1", "cmd-1", 2, false, 7), now) {
		t.Fatal("finish was not recorded")
	}
	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].ExitCode == nil || *records[0].ExitCode != 7 || records[0].Success == nil || *records[0].Success {
		t.Fatalf("native exit code lost: %#v", records)
	}
}

// An interactive program handed to the live terminal stays PTY-owned inside the
// hosted authority and is closed by its own D.
func TestInteractiveLifecycleStaysPTYInsideHostedAuthority(t *testing.T) {
	j := New()
	blockID := "block-interactive"
	c := NewHostedRuntimeConsumer(blockID, j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("interactive-1", "interactive"))
	// PTY bytes while the program is on screen.
	j.Apply(blockID, terminalruntime.StreamItem{Kind: terminalruntime.StreamOutputSegment, Output: []byte("tui bytes")}, time.Now())
	c.ObserveHostedRuntimeEvent(hostedFinish("interactive-1", true, 0))

	records := j.Snapshot(blockID)
	if len(records) != 1 {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Authority != terminalruntime.AuthorityHostedSidechannel || records[0].ExecutionMode != terminalruntime.ExecutionModeInteractive {
		t.Fatalf("interactive record lost its authority or mode: %#v", records[0])
	}
	if records[0].OutputSource != terminalruntime.OutputSourcePTY {
		t.Fatalf("interactive output source=%q", records[0].OutputSource)
	}
	if !bytes.Contains(records[0].Output, []byte("tui bytes")) {
		t.Fatalf("interactive PTY output was not kept: %#v", records[0])
	}
}

// A nested shell is a child workload: it cannot become a second authority for
// the block, and it cannot overwrite the outer session's identity.
func TestNestedShellDoesNotCreateSecondAuthority(t *testing.T) {
	j := New()
	blockID := "block-nested"
	decoder := terminalruntime.NewDecoder()
	now := time.Now()

	outer := []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"outer-epoch\",\"seq\":1,\"id\":\"outer-1\"}\aouter-output")
	for _, item := range decoder.FeedOrdered(outer) {
		j.Apply(blockID, item, now)
	}
	active, ok := j.Active(blockID)
	if !ok || active.ID != "outer-1" {
		t.Fatalf("outer command not active: %#v", active)
	}

	// A nested pwsh would emit its own M/C frames with a foreign epoch.
	nested := []byte("\x1b]16162;M;{\"v\":1,\"epoch\":\"nested-epoch\",\"seq\":1,\"shell\":\"pwsh\"}\a")
	nested = append(nested, []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"nested-epoch\",\"seq\":2,\"id\":\"nested-1\"}\a")...)
	for _, item := range decoder.FeedOrdered(nested) {
		j.Apply(blockID, item, now)
	}

	records := j.Snapshot(blockID)
	if len(records) != 0 {
		t.Fatalf("nested shell produced a command record: %#v", records)
	}
	active, ok = j.Active(blockID)
	if !ok || active.ID != "outer-1" {
		t.Fatalf("nested shell took over the block: %#v", active)
	}
	if got := j.Authority(blockID); got != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("latched authority=%q", got)
	}
	if active.Authority != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("active record authority=%q", active.Authority)
	}
}

// The anchor bridge no longer infers authority from the execution mode.
func TestAnchorBindingUsesAuthorityNotMode(t *testing.T) {
	registry := NewVisualAnchorRegistry("block-1")
	registry.ObserveAnchor(terminalruntime.IntegrationEvent{
		Kind:         terminalruntime.EventVisualAnchor,
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "epoch-1",
		HookSequence: 1,
		AnchorNonce:  "nonce-1",
		AnchorPhase:  "start",
	})

	// An unknown authority cannot confirm anything, whatever the mode says.
	registry.ObserveConfirmation(VisualAnchorConfirmation{
		BlockID:      "block-1",
		SessionEpoch: "epoch-1",
		HookSequence: 1,
		CommandID:    "command-1",
		AnchorNonce:  "nonce-1",
		Mode:         terminalruntime.ExecutionModeStructured,
	})
	if _, ok := registry.Lookup("nonce-1"); ok {
		t.Fatal("a confirmation without authority bound an anchor")
	}

	// A terminal-osc confirmation binds with any lifecycle mode.
	registry.ObserveConfirmation(VisualAnchorConfirmation{
		BlockID:      "block-1",
		Authority:    terminalruntime.AuthorityTerminalOSC,
		SessionEpoch: "epoch-1",
		HookSequence: 1,
		CommandID:    "command-1",
		AnchorNonce:  "nonce-1",
		Mode:         terminalruntime.ExecutionModeInteractive,
	})
	binding, ok := registry.Lookup("nonce-1")
	if !ok {
		t.Fatal("terminal-osc confirmation did not bind")
	}
	if binding.Authority != terminalruntime.AuthorityTerminalOSC || binding.CommandID != "command-1" {
		t.Fatalf("binding=%#v", binding)
	}
}

// The hosted disconnect path is single-shot and authority-tagged.
func TestHostedDisconnectClosesActiveCommandOnce(t *testing.T) {
	j := New()
	blockID := "block-hosted-disconnect"
	c := NewHostedRuntimeConsumer(blockID, j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("cmd-1", "structured"))
	c.ObserveHostedRuntimeDisconnect()
	c.ObserveHostedRuntimeDisconnect()
	// A late finish from the dead host must not resurrect the record.
	c.ObserveHostedRuntimeEvent(hostedFinish("cmd-1", true, 0))

	records := j.Snapshot(blockID)
	if len(records) != 1 || records[0].State != StateAborted || records[0].CompletionReason != CompletionSidechannelDisconnected {
		t.Fatalf("records=%#v", records)
	}
	if records[0].Authority != terminalruntime.AuthorityHostedSidechannel {
		t.Fatalf("authority=%q", records[0].Authority)
	}
}

// The hosted consumer ignores events for an authority it does not own.
func TestHostedConsumerRefusesAfterTerminalOSCLatch(t *testing.T) {
	j := New()
	blockID := "block-latch"
	now := time.Now()
	if !j.Apply(blockID, oscStart(blockID, "runspace-1", "osc-1", 1), now) {
		t.Fatal("terminal-osc start was not recorded")
	}
	c := NewHostedRuntimeConsumer(blockID, j)
	hostedReady(c)
	c.ObserveHostedRuntimeEvent(hostedStart("hosted-2", "structured"))
	if _, ok := j.Active(blockID); !ok {
		t.Fatal("active record disappeared")
	}
	if got := j.Authority(blockID); got != terminalruntime.AuthorityTerminalOSC {
		t.Fatalf("latched authority=%q", got)
	}
	_ = shellexec.HostedRuntimeEvent{}
}
