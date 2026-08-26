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
	closed       bool
}

func NewHostedRuntimeConsumer(blockID string, journal *Journal) *HostedRuntimeConsumer {
	if journal == nil {
		journal = New()
	}
	return &HostedRuntimeConsumer{blockID: blockID, journal: journal}
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
		sequence := c.nextHookSequence()
		accepted := c.journal.Apply(c.blockID, terminalruntime.StreamItem{
			Kind: terminalruntime.StreamIntegrationEvent,
			Event: terminalruntime.IntegrationEvent{
				Kind:          terminalruntime.EventCommandStarted,
				SessionEpoch:  c.runspaceID,
				HookSequence:  sequence,
				CommandID:     event.CommandID,
				Command:       event.Command,
				Cwd:           event.Cwd,
				ExecutionMode: mode,
				OutputSource:  source,
			},
		}, time.Now())
		if accepted {
			c.activeID = event.CommandID
			c.activeMode = mode
			c.activeSource = source
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
		sequence := c.nextHookSequence()
		accepted := c.journal.Apply(c.blockID, terminalruntime.StreamItem{
			Kind: terminalruntime.StreamIntegrationEvent,
			Event: terminalruntime.IntegrationEvent{
				Kind:          terminalruntime.EventCommandFinished,
				SessionEpoch:  c.runspaceID,
				HookSequence:  sequence,
				CommandID:     event.CommandID,
				Success:       event.Success,
				ExitCode:      event.ExitCode,
				ExecutionMode: c.activeMode,
				OutputSource:  c.activeSource,
			},
		}, time.Now())
		if accepted {
			c.activeID = ""
			c.activeMode = terminalruntime.ExecutionModeUnknown
			c.activeSource = terminalruntime.OutputSourceUnknown
		}
	}
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
