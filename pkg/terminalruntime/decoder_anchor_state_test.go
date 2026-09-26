package terminalruntime

import "testing"

// anchorFrames writes the streams the shell integration produces, in the order
// it produces them. The session starts with M(seq 1) and P(seq 2); each command
// then takes B(n) + C(n), D(n+1) and P(n+2).
func anchorSession(t *testing.T, frames ...[]byte) []IntegrationEvent {
	t.Helper()
	d := NewDecoder()
	var raw []byte
	for _, frame := range frames {
		raw = append(raw, frame...)
	}
	return d.Feed(raw)
}

func startedEvents(events []IntegrationEvent) []IntegrationEvent {
	out := []IntegrationEvent{}
	for _, event := range events {
		if event.Kind == EventCommandStarted {
			out = append(out, event)
		}
	}
	return out
}

func anchorEvents(events []IntegrationEvent) []IntegrationEvent {
	out := []IntegrationEvent{}
	for _, event := range events {
		if event.Kind == EventVisualAnchor {
			out = append(out, event)
		}
	}
	return out
}

func sessionStart() [][]byte {
	return [][]byte{
		frame("M", `{"v":1,"epoch":"e1","seq":1,"shell":"pwsh"}`),
		frame("P", `{"v":1,"epoch":"e1","seq":2}`),
	}
}

// B and C share the command's sequence; only the matching C consumes the anchor.
func TestAnchorStateMachinePairsBWithItsCommand(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","cmd64":"bHM="}`),
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","success":true,"exitcode":0}`),
		frame("P", `{"v":1,"epoch":"e1","seq":5}`),
	)...)

	anchors := anchorEvents(events)
	starts := startedEvents(events)
	if len(anchors) != 1 || len(starts) != 1 {
		t.Fatalf("anchors=%d starts=%d want 1/1 (%#v)", len(anchors), len(starts), events)
	}
	if starts[0].AnchorNonce != "n1" {
		t.Fatalf("the command did not consume its anchor: %#v", starts[0])
	}
	if starts[0].HookSequence != 3 || anchors[0].HookSequence != 3 {
		t.Fatalf("B and C must share the command sequence: %#v %#v", anchors[0], starts[0])
	}
}

// A second anchor for the same command is refused, and the first one still pairs.
func TestAnchorStateMachineRejectsDuplicateAnchor(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n2","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","cmd64":"bHM="}`),
	)...)

	if anchors := anchorEvents(events); len(anchors) != 1 {
		t.Fatalf("duplicate anchor was accepted: %#v", anchors)
	}
	starts := startedEvents(events)
	if len(starts) != 1 || starts[0].AnchorNonce != "n1" {
		t.Fatalf("the pending anchor did not pair: %#v", starts)
	}
}

// An anchor from an earlier sequence is refused.
func TestAnchorStateMachineRejectsStaleAnchor(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1"}`),
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","success":true,"exitcode":0}`),
		frame("P", `{"v":1,"epoch":"e1","seq":5}`),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"stale","phase":"start"}`),
	)...)

	if anchors := anchorEvents(events); len(anchors) != 1 {
		t.Fatalf("stale anchor was accepted: %#v", anchors)
	}
	if starts := startedEvents(events); len(starts) != 1 || starts[0].AnchorNonce != "n1" {
		t.Fatalf("stale anchor disturbed the session: %#v", starts)
	}
}

// An anchor that skips ahead is refused: the anchor always takes the sequence the
// next command will use.
func TestAnchorStateMachineRejectsFutureAnchor(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":8,"id":"cmd-9","nonce":"future","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"future"}`),
	)...)

	if anchors := anchorEvents(events); len(anchors) != 0 {
		t.Fatalf("future anchor was accepted: %#v", anchors)
	}
	starts := startedEvents(events)
	if len(starts) != 1 || starts[0].AnchorNonce != "" {
		t.Fatalf("a command paired with a future anchor: %#v", starts)
	}
}

// A different command at the anchor's sequence does not inherit the anchor.
func TestAnchorStateMachineWrongCommandDoesNotConsumeAnchor(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-other","nonce":"n2"}`),
		// The next command cannot pick the abandoned anchor up either.
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-other","success":true,"exitcode":0}`),
		frame("P", `{"v":1,"epoch":"e1","seq":5}`),
		frame("C", `{"v":1,"epoch":"e1","seq":6,"id":"cmd-2","nonce":"n1"}`),
	)...)

	starts := startedEvents(events)
	if len(starts) != 2 {
		t.Fatalf("starts=%#v", starts)
	}
	for _, start := range starts {
		if start.AnchorNonce != "" {
			t.Fatalf("a mismatched or later command consumed an anchor: %#v", start)
		}
	}
}

// A command that carries a nonce without an observed anchor does not keep it.
func TestAnchorStateMachineCommandWithoutAnchorKeepsNoNonce(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"unobserved"}`),
	)...)

	starts := startedEvents(events)
	if len(starts) != 1 {
		t.Fatalf("starts=%#v", starts)
	}
	if starts[0].AnchorNonce != "" {
		t.Fatalf("an unobserved nonce reached the journal: %#v", starts[0])
	}
}

// A lifecycle frame that is not the command start ends the anchor's usefulness.
func TestAnchorStateMachineAnchorExpiresAtTheNextLifecycleFrame(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("P", `{"v":1,"epoch":"e1","seq":3}`),
		frame("C", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","nonce":"n1"}`),
	)...)

	starts := startedEvents(events)
	if len(starts) != 1 || starts[0].AnchorNonce != "" {
		t.Fatalf("an expired anchor was consumed later: %#v", starts)
	}
}

// The anchor never advances the lifecycle sequence: the command's own frames keep
// the monotonic order the shell allocated.
func TestAnchorStateMachineDoesNotAdvanceLifecycleSequence(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1"}`),
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","success":true,"exitcode":0}`),
		frame("P", `{"v":1,"epoch":"e1","seq":5}`),
		frame("B", `{"v":1,"epoch":"e1","seq":6,"id":"cmd-2","nonce":"n2","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":6,"id":"cmd-2","nonce":"n2"}`),
		frame("D", `{"v":1,"epoch":"e1","seq":7,"id":"cmd-2","success":true,"exitcode":0}`),
		frame("P", `{"v":1,"epoch":"e1","seq":8}`),
	)...)

	starts := startedEvents(events)
	if len(starts) != 2 {
		t.Fatalf("starts=%#v", starts)
	}
	if starts[0].AnchorNonce != "n1" || starts[1].AnchorNonce != "n2" {
		t.Fatalf("each command must own its anchor: %#v", starts)
	}
	finished := 0
	for _, event := range events {
		if event.Kind == EventCommandFinished {
			finished++
		}
		if event.Kind == EventCommandAborted {
			t.Fatalf("unexpected abort: %#v", event)
		}
	}
	if finished != 2 {
		t.Fatalf("finished=%d want 2", finished)
	}
}

// Lifecycle monotonicity is unchanged: stale C/D/P frames are still refused.
func TestLifecycleMonotonicityUnchangedByAnchors(t *testing.T) {
	events := anchorSession(t, append(sessionStart(),
		frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1","phase":"start"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"cmd-1","nonce":"n1"}`),
		frame("C", `{"v":1,"epoch":"e1","seq":2,"id":"stale-cmd"}`),
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","success":true,"exitcode":0}`),
		frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"cmd-1","success":false,"exitcode":1}`),
		frame("P", `{"v":1,"epoch":"e1","seq":5}`),
		frame("P", `{"v":1,"epoch":"e1","seq":4}`),
	)...)

	starts := startedEvents(events)
	if len(starts) != 1 || starts[0].CommandID != "cmd-1" {
		t.Fatalf("a stale command start was accepted: %#v", starts)
	}
	finished, prompts := 0, 0
	for _, event := range events {
		switch event.Kind {
		case EventCommandFinished:
			finished++
			if event.Success == nil || !*event.Success {
				t.Fatalf("a duplicate finish changed the result: %#v", event)
			}
		case EventPromptReady:
			prompts++
		case EventCommandAborted:
			t.Fatalf("unexpected abort: %#v", event)
		}
	}
	if finished != 1 || prompts != 2 {
		t.Fatalf("finished=%d prompts=%d want 1/2", finished, prompts)
	}
}
