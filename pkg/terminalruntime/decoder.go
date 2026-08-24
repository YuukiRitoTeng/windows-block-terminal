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
	if len(raw) == 0 {
		return nil
	}
	d.buffer = append(d.buffer, raw...)
	if len(d.buffer) > maxIntegrationFrame {
		d.buffer = nil
	}
	var events []IntegrationEvent
	for {
		start := bytes.Index(d.buffer, []byte{0x1b, ']'})
		if start < 0 {
			if len(d.buffer) > 1 {
				d.buffer = d.buffer[len(d.buffer)-1:]
			}
			break
		}
		if start > 0 {
			d.buffer = d.buffer[start:]
		}
		end, termLen := frameEnd(d.buffer[2:])
		if end < 0 {
			break
		}
		frame := string(d.buffer[2 : 2+end])
		d.buffer = d.buffer[2+end+termLen:]
		if ev, ok := d.decodeFrame(frame); ok {
			events = append(events, ev)
		}
	}
	return events
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

func (d *Decoder) decodeFrame(frame string) (IntegrationEvent, bool) {
	parts := bytes.SplitN([]byte(frame), []byte(";"), 3)
	if len(parts) != 3 || string(parts[0]) != "16162" {
		return IntegrationEvent{}, false
	}
	kind := string(parts[1])
	var p wirePayload
	if json.Unmarshal(parts[2], &p) != nil {
		return IntegrationEvent{}, false
	}
	if p.Version == 0 {
		p.Version = 1
	} // backwards-compatible M frames
	if p.Version != 1 {
		return IntegrationEvent{}, false
	}
	if p.Epoch != "" {
		if d.sessionEpoch != "" && d.sessionEpoch != p.Epoch {
			return IntegrationEvent{}, false
		}
		d.sessionEpoch = p.Epoch
	}
	if p.Sequence != 0 {
		if p.Sequence <= d.lastHookSequence {
			return IntegrationEvent{}, false
		}
		d.lastHookSequence = p.Sequence
	}
	command, ok := decodeField(p.Command64, p.Command)
	if !ok {
		return IntegrationEvent{}, false
	}
	cwd, ok := decodeField(p.Cwd64, p.Cwd)
	if !ok {
		return IntegrationEvent{}, false
	}
	e := IntegrationEvent{ProtocolVersion: p.Version, SessionEpoch: d.sessionEpoch, HookSequence: p.Sequence, CommandID: p.ID, Command: command, Cwd: cwd, ExitCode: p.ExitCode, Success: p.Success, Shell: p.Shell, ShellVersion: p.ShellVersion}
	switch kind {
	case "C":
		if e.CommandID == "" {
			e.CommandID = generatedCommandID(d.sessionEpoch, p.Sequence)
		}
		d.activeCommandID = e.CommandID
		e.Kind = EventCommandStarted
	case "D":
		if e.CommandID == "" {
			e.CommandID = d.activeCommandID
		}
		if d.activeCommandID != "" && e.CommandID != d.activeCommandID {
			return IntegrationEvent{}, false
		}
		d.activeCommandID = ""
		e.Kind = EventCommandFinished
	case "M":
		e.Kind = EventShellMetadata
	default:
		return IntegrationEvent{}, false
	}
	return e, true
}

func decodeField(encoded, plain string) (string, bool) {
	if encoded == "" {
		return plain, true
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	return string(decoded), err == nil
}
