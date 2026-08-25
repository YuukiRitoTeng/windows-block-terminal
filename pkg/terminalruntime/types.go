package terminalruntime

import "fmt"

type EventKind string

const (
	EventCommandStarted  EventKind = "command_started"
	EventCommandFinished EventKind = "command_finished"
	EventShellMetadata   EventKind = "shell_metadata"
)

type IntegrationEvent struct {
	Kind            EventKind
	ProtocolVersion int
	SessionEpoch    string
	HookSequence    uint64
	CommandID       string
	Command         string
	Cwd             string
	ExitCode        *int
	Success         *bool
	Shell           string
	ShellVersion    string
}

type StreamItemKind string

const (
	StreamOutputSegment    StreamItemKind = "output_segment"
	StreamIntegrationEvent StreamItemKind = "integration_event"
)

// StreamItem preserves the byte order between terminal output and validated
// OSC 16162 integration events. Output contains no product control frames.
type StreamItem struct {
	Kind   StreamItemKind
	Output []byte
	Event  IntegrationEvent
}

type OutputChunk struct {
	BlockID  string
	Sequence uint64
	Raw      []byte
}

func generatedCommandID(epoch string, sequence uint64) string {
	return fmt.Sprintf("%s-%d", epoch, sequence)
}
