package commandjournal

import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

const (
	hostedEventHello           = "hello"
	hostedEventRuntimeReady    = "runtime_ready"
	hostedEventCommandStarted  = "command_started"
	hostedEventOutput          = "output"
	hostedEventCommandFinished = "command_finished"
)

// HostedRuntimeConsumer is the narrow production adapter from authenticated
// hosted-runtime transport events to Journal domain operations. Identity is
// bound to one host and one Runspace; events from another identity fail closed.
type HostedRuntimeConsumer struct {
	mu           sync.Mutex
	blockID      string
	journal      *Journal
	hostID       string
	runspaceID   string
	ready        bool
	activeID     string
	activeMode   terminalruntime.ExecutionMode
	activeSource terminalruntime.OutputSource
	hookSequence uint64
	anchor       *VisualAnchorRegistry
	closed       bool
}

func NewHostedRuntimeConsumer(blockID string, journal *Journal, anchor ...*VisualAnchorRegistry) *HostedRuntimeConsumer {
	if journal == nil {
		journal = New()
	}
	var anchorRegistry *VisualAnchorRegistry
	if len(anchor) > 0 {
		anchorRegistry = anchor[0]
	}
	return &HostedRuntimeConsumer{blockID: blockID, journal: journal, anchor: anchorRegistry}
}

// ObserveHostedRuntimeEvent implements shellexec.HostedRuntimeObserver.
func (c *HostedRuntimeConsumer) ObserveHostedRuntimeEvent(event shellexec.HostedRuntimeEvent) {
	if c == nil || c.journal == nil || c.blockID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}

	switch event.Kind {
	case hostedEventHello:
		if event.HostID == "" || (c.hostID != "" && c.hostID != event.HostID) {
			return
		}
		c.hostID = event.HostID
	case hostedEventRuntimeReady:
		if event.HostID == "" || event.RunspaceID == "" || (c.hostID != "" && c.hostID != event.HostID) {
			return
		}
		if c.ready && c.runspaceID != event.RunspaceID {
			return
		}
		c.hostID = event.HostID
		c.runspaceID = event.RunspaceID
		c.ready = true
	case hostedEventCommandStarted:
		if !c.validIdentity(event) || c.activeID != "" || event.CommandID == "" {
			return
		}
		mode, source, ok := hostedMode(event.Mode)
		if !ok {
			return
		}
		sequence, ok := c.acceptHookSequence(event.HookSequence)
		if !ok {
			return
		}
		accepted := c.journal.Apply(c.blockID, terminalruntime.StreamItem{
			Kind: terminalruntime.StreamIntegrationEvent,
			Event: terminalruntime.IntegrationEvent{
				Kind:                   terminalruntime.EventCommandStarted,
				SessionEpoch:           c.runspaceID,
				HookSequence:           sequence,
				CommandID:              event.CommandID,
				Command:                event.Command,
				Cwd:                    event.Cwd,
				ExecutionMode:          mode,
				OutputSource:           source,
				RuntimeHostID:          event.HostID,
				RuntimeRunspaceID:      event.RunspaceID,
				CaptureContractVersion: 1,
				ProtocolVersion:        1,
			},
		}, time.Now())
		if accepted {
			c.activeID = event.CommandID
			c.activeMode = mode
			c.activeSource = source
			if c.anchor != nil {
				c.anchor.ObserveHostedStart(event, c.blockID, c.runspaceID, sequence)
			}
		}
	case hostedEventOutput:
		if !c.validIdentity(event) || c.activeID == "" || event.CommandID != c.activeID || c.activeMode != terminalruntime.ExecutionModeStructured {
			return
		}
		c.journal.Apply(c.blockID, terminalruntime.StreamItem{
			Kind:   terminalruntime.StreamOutputSegment,
			Output: []byte(event.Data),
			Source: terminalruntime.OutputSourceHostStructured,
		}, time.Now())
	case hostedEventCommandFinished:
		if !c.validIdentity(event) || c.activeID == "" || event.CommandID != c.activeID || event.Success == nil || event.ExitCode == nil {
			return
		}
		sequence, ok := c.acceptHookSequence(event.HookSequence)
		if !ok {
			return
		}
		accepted := c.journal.Apply(c.blockID, terminalruntime.StreamItem{
			Kind: terminalruntime.StreamIntegrationEvent,
			Event: terminalruntime.IntegrationEvent{
				Kind:                   terminalruntime.EventCommandFinished,
				SessionEpoch:           c.runspaceID,
				HookSequence:           sequence,
				CommandID:              event.CommandID,
				Success:                event.Success,
				ExitCode:               event.ExitCode,
				Interrupted:            event.Interrupted,
				ExecutionMode:          c.activeMode,
				OutputSource:           c.activeSource,
				RuntimeHostID:          c.hostID,
				RuntimeRunspaceID:      c.runspaceID,
				CaptureContractVersion: 1,
				ProtocolVersion:        1,
			},
		}, time.Now())
		if accepted {
			c.activeID = ""
			c.activeMode = terminalruntime.ExecutionModeUnknown
			c.activeSource = terminalruntime.OutputSourceUnknown
		}
	}
}

// ObserveHostedRuntimeDisconnect implements shellexec.HostedRuntimeDisconnectObserver.
// It closes structured authority without treating the PTY session as ended.
func (c *HostedRuntimeConsumer) ObserveHostedRuntimeDisconnect() {
	if c == nil || c.journal == nil || c.blockID == "" {
		return
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	commandID := c.activeID
	mode := c.activeMode
	runspaceID := c.runspaceID
	c.activeID = ""
	c.activeMode = terminalruntime.ExecutionModeUnknown
	c.activeSource = terminalruntime.OutputSourceUnknown
	c.ready = false
	c.mu.Unlock()

	if commandID == "" || mode != terminalruntime.ExecutionModeStructured {
		return
	}
	c.journal.Apply(c.blockID, terminalruntime.StreamItem{
		Kind: terminalruntime.StreamIntegrationEvent,
		Event: terminalruntime.IntegrationEvent{
			Kind:             terminalruntime.EventCommandAborted,
			SessionEpoch:     runspaceID,
			CommandID:        commandID,
			CompletionReason: string(CompletionSidechannelDisconnected),
		},
	}, time.Now())
}

// Close prevents late events from a terminated hosted process from mutating a
// journal that may already belong to a replacement shell session.
func (c *HostedRuntimeConsumer) Close() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.closed = true
	c.activeID = ""
	c.mu.Unlock()
}

func (c *HostedRuntimeConsumer) validIdentity(event shellexec.HostedRuntimeEvent) bool {
	return c.ready && event.HostID != "" && event.RunspaceID != "" && event.HostID == c.hostID && event.RunspaceID == c.runspaceID
}

func (c *HostedRuntimeConsumer) nextHookSequence() uint64 {
	c.hookSequence++
	return c.hookSequence
}

func (c *HostedRuntimeConsumer) acceptHookSequence(sequence uint64) (uint64, bool) {
	if sequence == 0 {
		return c.nextHookSequence(), true
	}
	if sequence <= c.hookSequence {
		return 0, false
	}
	c.hookSequence = sequence
	return sequence, true
}

func hostedMode(mode string) (terminalruntime.ExecutionMode, terminalruntime.OutputSource, bool) {
	switch mode {
	case string(terminalruntime.ExecutionModeStructured):
		return terminalruntime.ExecutionModeStructured, terminalruntime.OutputSourceHostStructured, true
	case string(terminalruntime.ExecutionModeInteractive):
		return terminalruntime.ExecutionModeInteractive, terminalruntime.OutputSourcePTY, true
	default:
		return terminalruntime.ExecutionModeUnknown, terminalruntime.OutputSourceUnknown, false
	}
}
