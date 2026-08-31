package terminalruntime

import "fmt"

type EventKind string

const (
	EventCommandStarted  EventKind = "command_started"
	EventCommandFinished EventKind = "command_finished"
	EventCommandAborted  EventKind = "command_aborted"
	EventPromptReady     EventKind = "prompt_ready"
	EventShellMetadata   EventKind = "shell_metadata"
	EventVisualAnchor    EventKind = "visual_anchor"
)

// ExecutionMode identifies whether a lifecycle event belongs to a structured
// command or an interactive program handed to the live terminal.
type ExecutionMode string

const (
	ExecutionModeUnknown     ExecutionMode = "unknown"
	ExecutionModeStructured  ExecutionMode = "structured"
	ExecutionModeInteractive ExecutionMode = "interactive"
)

// OutputSource identifies the authority for command output bytes. PTY bytes
// remain useful for the live terminal, but hosted structured commands use the
// authenticated host sidechannel as their journal authority.
type OutputSource string

const (
	OutputSourceUnknown        OutputSource = "unknown"
	OutputSourcePTY            OutputSource = "pty"
	OutputSourceHostStructured OutputSource = "hostStructured"
)

type IntegrationEvent struct {
	Kind                   EventKind
	ProtocolVersion        int
	SessionEpoch           string
	HookSequence           uint64
	CommandID              string
	Command                string
	Cwd                    string
	ExitCode               *int
	Success                *bool
	Interrupted            bool
	Shell                  string
	ShellVersion           string
	CompletionReason       string
	ExecutionMode          ExecutionMode
	OutputSource           OutputSource
	RuntimeHostID          string
	RuntimeRunspaceID      string
	CaptureContractVersion int
	AnchorNonce            string
	AnchorPhase            string
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
	Source OutputSource
}

type OutputChunk struct {
	BlockID      string
	Sequence     uint64
	Raw          []byte
	Complete     bool
	DroppedBytes int64
}

func generatedCommandID(epoch string, sequence uint64) string {
	return fmt.Sprintf("%s-%d", epoch, sequence)
}
