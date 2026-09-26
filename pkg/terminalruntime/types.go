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

// Authority identifies which producer owns command lifecycle for a block
// session. Exactly one authority is in effect at a time: the in-band shell
// integration emitted by the shell itself (terminal-osc), or the authenticated
// hosted sidechannel. It is an explicit claim made by the producer - never
// inferred from ExecutionMode - and a session that accepted one authority
// refuses the other.
type Authority string

const (
	AuthorityUnknown           Authority = ""
	AuthorityTerminalOSC       Authority = "terminal-osc"
	AuthorityHostedSidechannel Authority = "hosted-sidechannel"
)

// Valid reports whether the value is one of the two supported authorities.
func (a Authority) Valid() bool {
	return a == AuthorityTerminalOSC || a == AuthorityHostedSidechannel
}

// DefaultOutputSource is the source a record uses when the producer does not
// claim one.
func (a Authority) DefaultOutputSource() OutputSource {
	switch a {
	case AuthorityTerminalOSC:
		return OutputSourcePTY
	case AuthorityHostedSidechannel:
		return OutputSourceHostStructured
	default:
		return OutputSourceUnknown
	}
}

// AllowsOutputSource reports whether an authority may own bytes from source.
// The in-band integration can only ever own PTY bytes, so it can never present
// sidechannel output as its own. The hosted authority owns structured output
// through the sidechannel, and PTY output for an interactive program it handed
// to the live terminal.
func (a Authority) AllowsOutputSource(source OutputSource) bool {
	switch a {
	case AuthorityTerminalOSC:
		return source == OutputSourcePTY
	case AuthorityHostedSidechannel:
		return source == OutputSourceHostStructured || source == OutputSourcePTY
	default:
		return false
	}
}

type IntegrationEvent struct {
	Kind                   EventKind
	Authority              Authority
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

	// AnchorHostID/AnchorRunspaceID are the identity an anchor mark claims for
	// itself. The claim is untrusted: it is not command provenance (that stays in
	// RuntimeHostID/RuntimeRunspaceID, which in-band frames never fill) and it
	// authorizes nothing - the anchor registry uses it only to tell the two
	// producers' marks apart, and still requires the authenticated confirmation of
	// that authority, naming the same identity, before a mark becomes a binding.
	AnchorHostID     string
	AnchorRunspaceID string
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
