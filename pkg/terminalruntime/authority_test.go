package terminalruntime

import (
	"strings"
	"testing"
)

func frame(kind string, body string) []byte {
	return []byte("\x1b]16162;" + kind + ";" + body + "\a")
}

// Every frame on the PTY stream belongs to the in-band authority.
func TestDecoderTagsInBandAuthority(t *testing.T) {
	d := NewDecoder()
	raw := frame("C", `{"v":1,"epoch":"e1","seq":1,"id":"e1-1","cmd64":"bHM="}`)
	raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":2,"id":"e1-1","success":true,"exitcode":0}`)...)
	events := d.Feed(raw)
	if len(events) != 2 {
		t.Fatalf("events=%#v", events)
	}
	for _, event := range events {
		if event.Authority != AuthorityTerminalOSC {
			t.Fatalf("kind=%s authority=%q want %q", event.Kind, event.Authority, AuthorityTerminalOSC)
		}
	}
}

// An in-band frame cannot claim hosted identity: hostId/runspaceId in the
// payload are never adopted, so a record built from this stream carries no
// hosted identity even if the shell (or a program) writes those keys.
func TestDecoderRefusesForgedHostedIdentity(t *testing.T) {
	d := NewDecoder()
	raw := frame("C", `{"v":1,"epoch":"e1","seq":1,"id":"e1-1","hostid":"host-1","runspaceid":"runspace-1"}`)
	raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":2,"id":"e1-1","success":true,"exitcode":0,"hostid":"host-1","runspaceid":"runspace-1"}`)...)
	raw = append(raw, frame("B", `{"v":1,"epoch":"e1","seq":3,"id":"e1-1","nonce":"n1","phase":"start","hostid":"host-1","runspaceid":"runspace-1"}`)...)
	events := d.Feed(raw)
	if len(events) != 3 {
		t.Fatalf("events=%#v", events)
	}
	for _, event := range events {
		if event.RuntimeHostID != "" || event.RuntimeRunspaceID != "" {
			t.Fatalf("kind=%s adopted forged hosted identity: host=%q runspace=%q", event.Kind, event.RuntimeHostID, event.RuntimeRunspaceID)
		}
		if event.Authority != AuthorityTerminalOSC {
			t.Fatalf("kind=%s authority=%q", event.Kind, event.Authority)
		}
	}
}

// The decoder's own recovery fences carry the authority they belong to.
func TestDecoderRecoveryAbortsCarryAuthority(t *testing.T) {
	cases := []struct {
		name string
		raw  [][]byte
		want string
	}{
		{
			name: "superseded by a newer C",
			raw: [][]byte{
				frame("C", `{"v":1,"epoch":"e1","seq":1,"id":"e1-1"}`),
				frame("C", `{"v":1,"epoch":"e1","seq":3,"id":"e1-2"}`),
			},
			want: "superseded",
		},
		{
			name: "missing finish at the prompt",
			raw: [][]byte{
				frame("C", `{"v":1,"epoch":"e1","seq":1,"id":"e1-1"}`),
				frame("P", `{"v":1,"epoch":"e1","seq":2}`),
			},
			want: "missing_finish",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDecoder()
			var raw []byte
			for _, part := range tc.raw {
				raw = append(raw, part...)
			}
			events := d.Feed(raw)
			aborts := 0
			for _, event := range events {
				if event.Kind != EventCommandAborted {
					continue
				}
				aborts++
				if event.Authority != AuthorityTerminalOSC {
					t.Fatalf("abort authority=%q want %q", event.Authority, AuthorityTerminalOSC)
				}
				if event.CompletionReason != tc.want {
					t.Fatalf("completion reason=%q want %q", event.CompletionReason, tc.want)
				}
			}
			if aborts != 1 {
				t.Fatalf("aborts=%d want 1 (events=%#v)", aborts, events)
			}
		})
	}
}

// Duplicate D for the same command never produces two finishes.
func TestDecoderDropsDuplicateFinish(t *testing.T) {
	d := NewDecoder()
	raw := frame("C", `{"v":1,"epoch":"e1","seq":1,"id":"e1-1"}`)
	raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":2,"id":"e1-1","success":true,"exitcode":0}`)...)
	raw = append(raw, frame("D", `{"v":1,"epoch":"e1","seq":3,"id":"e1-1","success":false,"exitcode":1}`)...)
	finishes := 0
	for _, event := range d.Feed(raw) {
		if event.Kind == EventCommandFinished {
			finishes++
		}
	}
	if finishes != 1 {
		t.Fatalf("finishes=%d want 1", finishes)
	}
}

// The authority value decides which output sources a record may own.
func TestAuthorityOutputSourceContract(t *testing.T) {
	if !AuthorityTerminalOSC.Valid() || !AuthorityHostedSidechannel.Valid() || AuthorityUnknown.Valid() {
		t.Fatal("authority validity table is wrong")
	}
	if AuthorityTerminalOSC.DefaultOutputSource() != OutputSourcePTY {
		t.Fatal("terminal-osc default source")
	}
	if AuthorityHostedSidechannel.DefaultOutputSource() != OutputSourceHostStructured {
		t.Fatal("hosted default source")
	}
	if AuthorityTerminalOSC.AllowsOutputSource(OutputSourceHostStructured) {
		t.Fatal("terminal-osc must never own sidechannel output")
	}
	if !AuthorityTerminalOSC.AllowsOutputSource(OutputSourcePTY) {
		t.Fatal("terminal-osc owns PTY output")
	}
	if !AuthorityHostedSidechannel.AllowsOutputSource(OutputSourceHostStructured) || !AuthorityHostedSidechannel.AllowsOutputSource(OutputSourcePTY) {
		t.Fatal("hosted authority owns structured and interactive PTY output")
	}
	if AuthorityUnknown.AllowsOutputSource(OutputSourcePTY) {
		t.Fatal("an unknown authority owns nothing")
	}
}

// The authority name is the wire-visible claim; it must stay stable because the
// renderer and the persistence layer store it verbatim.
func TestAuthorityNames(t *testing.T) {
	if string(AuthorityTerminalOSC) != "terminal-osc" || string(AuthorityHostedSidechannel) != "hosted-sidechannel" {
		t.Fatalf("authority names changed: %q %q", AuthorityTerminalOSC, AuthorityHostedSidechannel)
	}
	if strings.TrimSpace(string(AuthorityUnknown)) != "" {
		t.Fatalf("unknown authority must be the empty string, got %q", AuthorityUnknown)
	}
}
