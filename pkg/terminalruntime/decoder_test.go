package terminalruntime

import (
	"bytes"
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
	if len(d.Feed(frame(2, "e2"))) != 0 {
		t.Fatal("foreign epoch accepted")
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
		return []byte("\x1b]16162;" + kind + ";{\"v\":1,\"epoch\":\"e1\",\"seq\":" + string(rune('0'+seq)) + ",\"id\":\"" + id + "\"}\a")
	}
	if got := d.Feed(frame("D", "e1-1", 1)); len(got) != 0 {
		t.Fatalf("accepted D without C: %#v", got)
	}
	if got := d.Feed(frame("C", "e1-1", 2)); len(got) != 1 {
		t.Fatalf("initial C rejected: %#v", got)
	}
	if got := d.Feed(frame("C", "e1-2", 3)); len(got) != 0 {
		t.Fatalf("accepted overlapping C: %#v", got)
	}
	if got := d.Feed(frame("D", "e1-2", 4)); len(got) != 0 {
		t.Fatalf("accepted mismatched D: %#v", got)
	}
	if got := d.Feed(frame("D", "e1-1", 5)); len(got) != 1 || got[0].Kind != EventCommandFinished {
		t.Fatalf("valid D did not complete active C: %#v", got)
	}
}
