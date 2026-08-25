package terminalruntime

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
)

const maxIntegrationFrame = 64 * 1024

// Decoder consumes only OSC 16162 envelopes. It never mutates or returns the
// PTY bytes; callers continue forwarding the original bytes to xterm.js/Wave.
type Decoder struct {
	buffer           []byte
	sessionEpoch     string
	lastHookSequence uint64
	activeCommandID  string
}

func NewDecoder() *Decoder { return &Decoder{} }

type wirePayload struct {
	Version      int    `json:"v"`
	Epoch        string `json:"epoch"`
	Sequence     uint64 `json:"seq"`
	ID           string `json:"id"`
	Command64    string `json:"cmd64"`
	Cwd64        string `json:"cwd64"`
	Command      string `json:"command"`
	Cwd          string `json:"cwd"`
	ExitCode     *int   `json:"exitcode"`
	Success      *bool  `json:"success"`
	Shell        string `json:"shell"`
	ShellVersion string `json:"shellversion"`
}

func (d *Decoder) Feed(raw []byte) []IntegrationEvent {
	items := d.FeedOrdered(raw)
	events := make([]IntegrationEvent, 0, len(items))
	for _, item := range items {
		if item.Kind == StreamIntegrationEvent {
			events = append(events, item.Event)
		}
	}
	return events
}

// FeedOrdered returns validated integration events and ordinary output in the
// exact order they appeared in the PTY byte stream.
func (d *Decoder) FeedOrdered(raw []byte) []StreamItem {
	if len(raw) == 0 {
		return nil
	}
	d.buffer = append(d.buffer, raw...)
	var items []StreamItem
	for {
		start := bytes.Index(d.buffer, []byte{0x1b, ']'})
		if start < 0 {
			keep := 0
			if len(d.buffer) > 0 && d.buffer[len(d.buffer)-1] == 0x1b {
				keep = 1
			}
			if len(d.buffer)-keep > 0 {
				items = append(items, StreamItem{Kind: StreamOutputSegment, Output: append([]byte(nil), d.buffer[:len(d.buffer)-keep]...)})
			}
			if keep == 1 {
				d.buffer = d.buffer[len(d.buffer)-1:]
			} else {
				d.buffer = nil
			}
			break
		}
		if start > 0 {
			items = append(items, StreamItem{Kind: StreamOutputSegment, Output: append([]byte(nil), d.buffer[:start]...)})
			d.buffer = d.buffer[start:]
		}
		end, termLen := frameEnd(d.buffer[2:])
		if end < 0 {
			if len(d.buffer) > maxIntegrationFrame {
				// The limit applies only to an unterminated OSC candidate. If
				// another candidate follows, discard this one and continue.
				next := bytes.Index(d.buffer[2:], []byte{0x1b, ']'})
				if next >= 0 {
					d.buffer = d.buffer[2+next:]
					continue
				}
				// Preserve a possible split ESC ] marker for the next Feed.
				if d.buffer[len(d.buffer)-1] == 0x1b {
					d.buffer = d.buffer[len(d.buffer)-1:]
				} else {
					d.buffer = nil
				}
			}
			break
		}
		frameBytes := append([]byte(nil), d.buffer[:2+end+termLen]...)
		frame := string(d.buffer[2 : 2+end])
		d.buffer = d.buffer[2+end+termLen:]
		if events, ok := d.decodeFrame(frame); ok {
			for _, ev := range events {
				items = append(items, StreamItem{Kind: StreamIntegrationEvent, Event: ev})
			}
		} else if !bytes.HasPrefix([]byte(frame), []byte("16162;")) {
			items = append(items, StreamItem{Kind: StreamOutputSegment, Output: frameBytes})
		}
	}
	return items
}

func frameEnd(data []byte) (int, int) {
	bel := bytes.IndexByte(data, 0x07)
	st := bytes.Index(data, []byte{0x1b, '\\'})
	if bel < 0 && st < 0 {
		return -1, 0
	}
	if st >= 0 && (bel < 0 || st < bel) {
		return st, 2
	}
	return bel, 1
}

func (d *Decoder) decodeFrame(frame string) ([]IntegrationEvent, bool) {
	parts := bytes.SplitN([]byte(frame), []byte(";"), 3)
	if len(parts) != 3 || string(parts[0]) != "16162" {
		return nil, false
	}
	kind := string(parts[1])
	var p wirePayload
	if json.Unmarshal(parts[2], &p) != nil {
		return nil, false
	}
	if p.Version == 0 {
		p.Version = 1
	} // backwards-compatible M frames
	if p.Version != 1 {
		return nil, false
	}
	if (kind == "C" || kind == "D" || kind == "P") && (p.Epoch == "" || p.Sequence == 0) {
		return nil, false
	}
	if kind == "D" && (p.Success == nil || p.ExitCode == nil) {
		return nil, false
	}
	if kind != "M" && kind != "P" && kind != "C" && kind != "D" {
		return nil, false
	}
	if kind == "D" && d.sessionEpoch != "" && p.Epoch != d.sessionEpoch {
		return nil, false
	}
	// While a top-level command is active, a foreign epoch belongs to a
	// nested/remote terminal. It must not take over the decoder or abort the
	// outer command. The raw bytes are still consumed as product control data.
	if d.activeCommandID != "" && p.Epoch != "" && d.sessionEpoch != "" && p.Epoch != d.sessionEpoch {
		return nil, false
	}
	if p.Epoch != "" && d.sessionEpoch != "" && p.Epoch != d.sessionEpoch && p.Sequence == 0 {
		return nil, false
	}
	command, ok := decodeField(p.Command64, p.Command)
	if !ok {
		return nil, false
	}
	cwd, ok := decodeField(p.Cwd64, p.Cwd)
	if !ok {
		return nil, false
	}

	events := make([]IntegrationEvent, 0, 3)
	// A valid M/P/C frame is an epoch boundary. It can reconcile an active
	// command from the old shell session, while a D is never allowed to switch
	// session identity.
	if p.Epoch != "" && d.sessionEpoch != "" && p.Epoch != d.sessionEpoch {
		if kind != "M" && kind != "P" && kind != "C" {
			return nil, false
		}
		if d.activeCommandID != "" {
			events = append(events, IntegrationEvent{
				Kind: EventCommandAborted, SessionEpoch: d.sessionEpoch,
				CommandID: d.activeCommandID, CompletionReason: "epoch_changed",
			})
			d.activeCommandID = ""
		}
		d.sessionEpoch = p.Epoch
		d.lastHookSequence = 0
	}
	epoch := d.sessionEpoch
	if p.Epoch != "" {
		epoch = p.Epoch
	}
	sequence := d.lastHookSequence
	if p.Sequence != 0 {
		if p.Sequence <= sequence {
			return nil, false
		}
		sequence = p.Sequence
	}
	e := IntegrationEvent{ProtocolVersion: p.Version, SessionEpoch: epoch, HookSequence: p.Sequence, CommandID: p.ID, Command: command, Cwd: cwd, ExitCode: p.ExitCode, Success: p.Success, Shell: p.Shell, ShellVersion: p.ShellVersion}
	switch kind {
	case "C":
		if d.activeCommandID != "" {
			// A newer C in the same epoch is a deterministic recovery fence.
			events = append(events, IntegrationEvent{Kind: EventCommandAborted, SessionEpoch: d.sessionEpoch, CommandID: d.activeCommandID, CompletionReason: "superseded"})
			d.activeCommandID = ""
		}
		if e.CommandID == "" {
			e.CommandID = generatedCommandID(epoch, p.Sequence)
		}
		e.Kind = EventCommandStarted
	case "D":
		if d.activeCommandID == "" {
			return nil, false
		}
		if e.CommandID == "" {
			e.CommandID = d.activeCommandID
		}
		if e.CommandID != d.activeCommandID {
			return nil, false
		}
		e.Kind = EventCommandFinished
	case "P":
		if d.activeCommandID != "" {
			events = append(events, IntegrationEvent{Kind: EventCommandAborted, SessionEpoch: d.sessionEpoch, CommandID: d.activeCommandID, CompletionReason: "missing_finish"})
			d.activeCommandID = ""
		}
		e.Kind = EventPromptReady
	case "M":
		e.Kind = EventShellMetadata
	}
	d.sessionEpoch = epoch
	d.lastHookSequence = sequence
	if kind == "C" {
		d.activeCommandID = e.CommandID
	} else if kind == "D" {
		d.activeCommandID = ""
	}
	events = append(events, e)
	return events, true
}

func decodeField(encoded, plain string) (string, bool) {
	if encoded == "" {
		return plain, true
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	return string(decoded), err == nil
}
