package terminalruntime

import "testing"

// A visual anchor shares the sequence of the command it marks, so the decoder
// must accept it without either rejecting it for repeating that sequence or
// letting it advance the lifecycle sequence.
func TestDecoderAnchorSharesCommandSequence(t *testing.T) {
	d := NewDecoder()
	var raw []byte
	raw = append(raw, frame("M", `{"v":1,"epoch":"e1","seq":1,"shell":"pwsh"}`)...)
	// Prompt for the first command, then B and C carrying the same sequence.
	raw = append(raw, frame("P", `{"v":1,"epoch":"e1","seq":2}`)...)
	raw = append(raw, frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"e1-3","nonce":"n1","phase":"start"}`)...)
	raw = append(raw, frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"e1-3","nonce":"n1","cmd64":"bHM="}`)...)
	raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":4,"id":"e1-3","success":true,"exitcode":0}`)...)
	raw = append(raw, frame("P", `{"v":1,"epoch":"e1","seq":5}`)...)

	var anchors, starts, finishes int
	var start IntegrationEvent
	for _, event := range d.Feed(raw) {
		switch event.Kind {
		case EventVisualAnchor:
			anchors++
			if event.AnchorNonce != "n1" || event.HookSequence != 3 || event.Authority != AuthorityTerminalOSC {
				t.Fatalf("anchor=%#v", event)
			}
		case EventCommandStarted:
			starts++
			start = event
		case EventCommandFinished:
			finishes++
		case EventCommandAborted:
			t.Fatalf("unexpected abort: %#v", event)
		}
	}
	if anchors != 1 || starts != 1 || finishes != 1 {
		t.Fatalf("anchors=%d starts=%d finishes=%d want 1/1/1", anchors, starts, finishes)
	}
	if start.HookSequence != 3 || start.CommandID != "e1-3" {
		t.Fatalf("start=%#v", start)
	}
	// The pair shares epoch, sequence and command id - that is what binds them.
	if start.SessionEpoch != "e1" {
		t.Fatalf("start epoch=%q", start.SessionEpoch)
	}
}

// Three consecutive commands each keep their own anchor, and the lifecycle
// sequence keeps moving forward by the shell's own allocation (B(n) C(n) D(n+1)
// P(n+2)), which the anchor does not consume.
func TestDecoderAnchorDoesNotConsumeLifecycleSequence(t *testing.T) {
	d := NewDecoder()
	var raw []byte
	raw = append(raw, frame("M", `{"v":1,"epoch":"e1","seq":1,"shell":"pwsh"}`)...)
	raw = append(raw, frame("P", `{"v":1,"epoch":"e1","seq":2}`)...)
	sequence := uint64(3)
	for i := 0; i < 3; i++ {
		id := "cmd-" + string(rune('a'+i))
		nonce := "n" + itoa(sequence)
		raw = append(raw, frame("B", `{"v":1,"epoch":"e1","seq":`+itoa(sequence)+`,"id":"`+id+`","nonce":"`+nonce+`","phase":"start"}`)...)
		raw = append(raw, frame("C", `{"v":1,"epoch":"e1","seq":`+itoa(sequence)+`,"id":"`+id+`","nonce":"`+nonce+`"}`)...)
		raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":`+itoa(sequence+1)+`,"id":"`+id+`","success":true,"exitcode":0}`)...)
		raw = append(raw, frame("P", `{"v":1,"epoch":"e1","seq":`+itoa(sequence+2)+`}`)...)
		sequence += 3
	}

	starts := 0
	paired := 0
	for _, event := range d.Feed(raw) {
		switch event.Kind {
		case EventCommandStarted:
			starts++
			if event.AnchorNonce != "" {
				paired++
			}
		case EventCommandAborted:
			t.Fatalf("unexpected abort: %#v", event)
		}
	}
	if starts != 3 {
		t.Fatalf("starts=%d want 3", starts)
	}
	if paired != 3 {
		t.Fatalf("anchors paired=%d want 3", paired)
	}
}

// A malformed anchor (no sequence) is still refused.
func TestDecoderRejectsAnchorWithoutSequence(t *testing.T) {
	d := NewDecoder()
	if events := d.Feed(frame("B", `{"v":1,"epoch":"e1","nonce":"n1","phase":"start"}`)); len(events) != 0 {
		t.Fatalf("anchor without sequence accepted: %#v", events)
	}
}

func itoa(value uint64) string {
	if value == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}
