package terminalruntime

import (
	"bytes"
	"fmt"
	"testing"
)

func TestDecoderHandlesSplitFramesAndPairsLifecycle(t *testing.T) {
	d := NewDecoder()
	c := "\x1b]16162;C;{\"v\":1,\"epoch\":\"e1\",\"seq\":1,\"id\":\"e1-1\",\"cmd64\":\"Z2l0IHN0YXR1cw==\",\"cwd64\":\"Qzpc\"}\a"
	if got := d.Feed([]byte(c[:17])); len(got) != 0 {
		t.Fatalf("partial frame emitted %d events", len(got))
	}
	got := d.Feed([]byte(c[17:]))
	if len(got) != 1 || got[0].Kind != EventCommandStarted || got[0].Command != "git status" || got[0].SessionEpoch != "e1" {
		t.Fatalf("unexpected C event: %#v", got)
	}
	done := d.Feed([]byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"e1\",\"seq\":2,\"id\":\"e1-1\",\"success\":false,\"exitcode\":7}\a"))
	if len(done) != 1 || done[0].Kind != EventCommandFinished || done[0].ExitCode == nil || *done[0].ExitCode != 7 {
		t.Fatalf("unexpected D event: %#v", done)
	}
}

func TestDecoderRejectsStaleAndForeignEvents(t *testing.T) {
	d := NewDecoder()
	frame := func(seq uint64, epoch string) []byte {
		return []byte("\x1b]16162;M;{\"v\":1,\"epoch\":\"" + epoch + "\",\"seq\":" + string(rune('0'+seq)) + "}\a")
	}
	if len(d.Feed(frame(1, "e1"))) != 1 {
		t.Fatal("first metadata event missing")
	}
	if len(d.Feed(frame(1, "e1"))) != 0 {
		t.Fatal("duplicate event accepted")
	}
	if got := d.Feed(frame(2, "e2")); len(got) != 1 || got[0].SessionEpoch != "e2" {
		t.Fatalf("new epoch metadata was not adopted: %#v", got)
	}
}

func TestDecoderAcceptsSTTerminator(t *testing.T) {
	d := NewDecoder()
	got := d.Feed([]byte("\x1b]16162;M;{\"shell\":\"pwsh\"}\x1b\\"))
	if len(got) != 1 || got[0].Kind != EventShellMetadata {
		t.Fatalf("unexpected ST event: %#v", got)
	}
}

func TestDecoderFindsFrameAfterLargePlainOutput(t *testing.T) {
	d := NewDecoder()
	frame := []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"e1\",\"seq\":1,\"id\":\"e1-1\",\"cmd64\":\"Ww==\"}\a")
	got := d.Feed(append(bytes.Repeat([]byte{'x'}, maxIntegrationFrame+1), frame...))
	if len(got) != 1 || got[0].Kind != EventCommandStarted || got[0].CommandID != "e1-1" {
		t.Fatalf("large plain output hid lifecycle frame: %#v", got)
	}
}

func TestDecoderRejectsInvalidLifecycleTransitions(t *testing.T) {
	d := NewDecoder()
	frame := func(kind, id string, seq uint64) []byte {
		result := "\x1b]16162;" + kind + ";{\"v\":1,\"epoch\":\"e1\",\"seq\":" + string(rune('0'+seq)) + ",\"id\":\"" + id + "\""
		if kind == "D" {
			result += ",\"success\":true,\"exitcode\":0"
		}
		return []byte(result + "}\a")
	}
	if got := d.Feed(frame("D", "e1-1", 1)); len(got) != 0 {
		t.Fatalf("accepted D without C: %#v", got)
	}
	if got := d.Feed(frame("C", "e1-1", 2)); len(got) != 1 {
		t.Fatalf("initial C rejected: %#v", got)
	}
	if got := d.Feed(frame("C", "e1-2", 3)); len(got) != 2 || got[0].Kind != EventCommandAborted || got[1].Kind != EventCommandStarted {
		t.Fatalf("same-epoch recovery C was not ordered: %#v", got)
	}
	if got := d.Feed(frame("D", "e1-3", 4)); len(got) != 0 {
		t.Fatalf("accepted mismatched D: %#v", got)
	}
	if got := d.Feed(frame("D", "e1-2", 5)); len(got) != 1 || got[0].Kind != EventCommandFinished {
		t.Fatalf("valid D did not complete recovered C: %#v", got)
	}
}

func TestDecoderRequiresLifecycleIdentity(t *testing.T) {
	frame := func(kind, epoch string, sequence uint64, id string) []byte {
		result := fmt.Sprintf("\x1b]16162;%s;{\"v\":1,\"epoch\":\"%s\",\"seq\":%d,\"id\":\"%s\"", kind, epoch, sequence, id)
		if kind == "D" {
			result += ",\"success\":true,\"exitcode\":0"
		}
		return []byte(result + "}\a")
	}

	d := NewDecoder()
	if got := d.Feed(frame("C", "", 1, "e1-1")); len(got) != 0 {
		t.Fatalf("accepted C without epoch: %#v", got)
	}
	if got := d.Feed(frame("C", "e1", 0, "e1-1")); len(got) != 0 {
		t.Fatalf("accepted C with zero sequence: %#v", got)
	}
	if got := d.Feed(frame("C", "e1", 1, "e1-1")); len(got) != 1 {
		t.Fatalf("valid C rejected: %#v", got)
	}
	if got := d.Feed(frame("D", "", 2, "e1-1")); len(got) != 0 {
		t.Fatalf("accepted D without epoch: %#v", got)
	}
	if got := d.Feed(frame("D", "e1", 0, "e1-1")); len(got) != 0 {
		t.Fatalf("accepted D with zero sequence: %#v", got)
	}
	if got := d.Feed(frame("D", "e1", 2, "e1-1")); len(got) != 1 || got[0].Kind != EventCommandFinished {
		t.Fatalf("valid D did not complete active C: %#v", got)
	}
}

func TestDecoderRequiresFinishedResult(t *testing.T) {
	d := NewDecoder()
	c := []byte("\x1b]16162;C;{\"v\":1,\"epoch\":\"e1\",\"seq\":1,\"id\":\"e1-1\"}\a")
	if len(d.Feed(c)) != 1 {
		t.Fatal("valid C rejected")
	}
	missingSuccess := []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"e1\",\"seq\":2,\"id\":\"e1-1\",\"exitcode\":0}\a")
	if len(d.Feed(missingSuccess)) != 0 {
		t.Fatal("accepted D without success")
	}
	missingExitCode := []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"e1\",\"seq\":3,\"id\":\"e1-1\",\"success\":true}\a")
	if len(d.Feed(missingExitCode)) != 0 {
		t.Fatal("accepted D without exitcode")
	}
	valid := []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"e1\",\"seq\":4,\"id\":\"e1-1\",\"success\":true,\"exitcode\":0}\a")
	if len(d.Feed(valid)) != 1 {
		t.Fatal("valid D did not complete active C")
	}
}

func TestDecoderPromptAbortsMissingFinishAndFencesOutput(t *testing.T) {
	d := NewDecoder()
	raw := append(orderedFrame("C", "epoch-1", "cmd-1", 1), []byte("inside")...)
	raw = append(raw, []byte("\x1b]16162;P;{\"v\":1,\"epoch\":\"epoch-1\",\"seq\":2}\a")...)
	raw = append(raw, []byte("prompt-text")...)
	items := d.FeedOrdered(raw)
	events := eventsFromItems(items)
	if len(events) != 3 || events[0].Kind != EventCommandStarted || events[1].Kind != EventCommandAborted || events[1].CompletionReason != "missing_finish" || events[2].Kind != EventPromptReady {
		t.Fatalf("unexpected prompt recovery events: %#v", events)
	}
	if got := string(outputFromItems(items)); got != "insideprompt-text" {
		t.Fatalf("unexpected ordered output: %q", got)
	}
	if next := d.Feed(orderedFrame("D", "epoch-1", "cmd-1", 3)); len(next) != 0 {
		t.Fatalf("stale D completed an aborted command: %#v", next)
	}
}

func TestDecoderNewCommandSupersedesActiveCommand(t *testing.T) {
	d := NewDecoder()
	raw := append(orderedFrame("C", "epoch-1", "cmd-1", 1), []byte("one")...)
	raw = append(raw, orderedFrame("C", "epoch-1", "cmd-2", 2)...)
	raw = append(raw, []byte("two")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-2", 3)...)
	items := d.FeedOrdered(raw)
	events := eventsFromItems(items)
	if len(events) != 4 || events[1].Kind != EventCommandAborted || events[1].CompletionReason != "superseded" || events[2].Kind != EventCommandStarted || events[3].Kind != EventCommandFinished {
		t.Fatalf("unexpected supersession events: %#v", events)
	}
}

func TestDecoderEpochChangeAbortsActiveButForeignDIsRejected(t *testing.T) {
	d := NewDecoder()
	if got := d.Feed(orderedFrame("C", "epoch-a", "cmd-a", 1)); len(got) != 1 {
		t.Fatal("initial C rejected")
	}
	if got := d.Feed(orderedFrame("D", "epoch-b", "cmd-a", 2)); len(got) != 0 {
		t.Fatalf("foreign D changed epoch: %#v", got)
	}
	if got := d.Feed([]byte("\x1b]16162;M;{\"v\":1,\"epoch\":\"epoch-b\",\"seq\":1}\a")); len(got) != 2 || got[0].Kind != EventCommandAborted || got[0].CompletionReason != "epoch_changed" || got[1].Kind != EventShellMetadata {
		t.Fatalf("epoch recovery did not reconcile active command: %#v", got)
	}
	if got := d.Feed(orderedFrame("C", "epoch-b", "cmd-b", 2)); len(got) != 1 || got[0].Kind != EventCommandStarted {
		t.Fatalf("new epoch command rejected: %#v", got)
	}
}
