package terminalruntime

import "testing"

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
