// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package commandjournal

import (
	"sync"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// VisualAnchor is an untrusted presentation hint observed on the PTY stream.
// It becomes actionable only after a matching authenticated hosted-runtime
// confirmation is observed.
type VisualAnchor struct {
	BlockID      string
	SessionEpoch string
	HookSequence uint64
	CommandID    string
	AnchorNonce  string
	AnchorPhase  string
	HostID       string
	RunspaceID   string
}

// VisualAnchorConfirmation is derived from the authenticated hosted
// sidechannel and is the authority for the CommandRecord identity.
type VisualAnchorConfirmation struct {
	BlockID      string
	SessionEpoch string
	HookSequence uint64
	CommandID    string
	AnchorNonce  string
	HostID       string
	RunspaceID   string
	Mode         terminalruntime.ExecutionMode
}

// VisualAnchorBinding is the product-owned, confirmed identity bridge sent to
// the renderer. The marker remains presentation-only; record identity comes
// from the authenticated confirmation.
type VisualAnchorBinding struct {
	BlockID      string
	SessionEpoch string
	HookSequence uint64
	CommandID    string
	AnchorNonce  string
	HostID       string
	RunspaceID   string
	Mode         terminalruntime.ExecutionMode
}

type VisualAnchorRegistry struct {
	mu            sync.Mutex
	blockID       string
	anchors       map[string]VisualAnchor
	confirmations map[string]VisualAnchorConfirmation
	bindings      map[string]VisualAnchorBinding
	rejected      map[string]struct{}
}

func NewVisualAnchorRegistry(blockID string) *VisualAnchorRegistry {
	return &VisualAnchorRegistry{
		blockID:       blockID,
		anchors:       make(map[string]VisualAnchor),
		confirmations: make(map[string]VisualAnchorConfirmation),
		bindings:      make(map[string]VisualAnchorBinding),
		rejected:      make(map[string]struct{}),
	}
}

// ObserveAnchor records a raw PTY anchor as pending. Raw terminal bytes never
// authorize a record binding because terminal programs can print arbitrary OSC.
func (r *VisualAnchorRegistry) ObserveAnchor(event terminalruntime.IntegrationEvent) {
	if r == nil || event.Kind != terminalruntime.EventVisualAnchor || event.AnchorNonce == "" || event.AnchorPhase != "start" || event.SessionEpoch == "" || event.HookSequence == 0 {
		return
	}
	anchor := VisualAnchor{
		BlockID:      r.blockID,
		SessionEpoch: event.SessionEpoch,
		HookSequence: event.HookSequence,
		CommandID:    event.CommandID,
		AnchorNonce:  event.AnchorNonce,
		AnchorPhase:  event.AnchorPhase,
		HostID:       event.RuntimeHostID,
		RunspaceID:   event.RuntimeRunspaceID,
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.rejected[anchor.AnchorNonce]; ok {
		return
	}
	if _, ok := r.bindings[anchor.AnchorNonce]; ok {
		return
	}
	if _, ok := r.anchors[anchor.AnchorNonce]; ok {
		return
	}
	if confirmation, ok := r.confirmations[anchor.AnchorNonce]; ok {
		if !visualAnchorContextsMatch(anchor, confirmation) {
			delete(r.confirmations, anchor.AnchorNonce)
			r.rejected[anchor.AnchorNonce] = struct{}{}
			return
		}
		delete(r.confirmations, anchor.AnchorNonce)
		r.bindLocked(anchor, confirmation)
		return
	}
	r.anchors[anchor.AnchorNonce] = anchor
}

// ObserveConfirmation records an authenticated hosted command start. It is
// the only path that can provide a CommandRecord identity to a visual anchor.
func (r *VisualAnchorRegistry) ObserveConfirmation(confirmation VisualAnchorConfirmation) {
	if r == nil || confirmation.BlockID == "" || confirmation.BlockID != r.blockID || confirmation.SessionEpoch == "" || confirmation.HookSequence == 0 || confirmation.CommandID == "" || confirmation.AnchorNonce == "" || confirmation.HostID == "" || confirmation.RunspaceID == "" || confirmation.Mode != terminalruntime.ExecutionModeStructured {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.rejected[confirmation.AnchorNonce]; ok {
		return
	}
	if _, ok := r.bindings[confirmation.AnchorNonce]; ok {
		return
	}
	if anchor, ok := r.anchors[confirmation.AnchorNonce]; ok {
		if !visualAnchorContextsMatch(anchor, confirmation) {
			delete(r.anchors, confirmation.AnchorNonce)
			r.rejected[confirmation.AnchorNonce] = struct{}{}
			return
		}
		delete(r.anchors, confirmation.AnchorNonce)
		r.bindLocked(anchor, confirmation)
		return
	}
	if _, ok := r.confirmations[confirmation.AnchorNonce]; ok {
		return
	}
	r.confirmations[confirmation.AnchorNonce] = confirmation
}

func visualAnchorContextsMatch(anchor VisualAnchor, confirmation VisualAnchorConfirmation) bool {
	return anchor.BlockID == confirmation.BlockID &&
		anchor.SessionEpoch == confirmation.SessionEpoch &&
		anchor.HookSequence == confirmation.HookSequence &&
		(anchor.CommandID == "" || anchor.CommandID == confirmation.CommandID) &&
		(anchor.HostID == "" || anchor.HostID == confirmation.HostID) &&
		(anchor.RunspaceID == "" || anchor.RunspaceID == confirmation.RunspaceID)
}

func (r *VisualAnchorRegistry) bindLocked(anchor VisualAnchor, confirmation VisualAnchorConfirmation) {
	binding := VisualAnchorBinding{
		BlockID:      confirmation.BlockID,
		SessionEpoch: confirmation.SessionEpoch,
		HookSequence: confirmation.HookSequence,
		CommandID:    confirmation.CommandID,
		AnchorNonce:  confirmation.AnchorNonce,
		HostID:       confirmation.HostID,
		RunspaceID:   confirmation.RunspaceID,
		Mode:         confirmation.Mode,
	}
	r.bindings[binding.AnchorNonce] = binding
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_CommandJournalAnchor,
		Scopes:  []string{waveobj.MakeORef(waveobj.OType_Block, r.blockID).String()},
		Persist: 1,
		Data: map[string]any{
			"blockId":      binding.BlockID,
			"sessionEpoch": binding.SessionEpoch,
			"hookSequence": binding.HookSequence,
			"commandId":    binding.CommandID,
			"anchorNonce":  binding.AnchorNonce,
			"hostId":       binding.HostID,
			"runspaceId":   binding.RunspaceID,
			"mode":         string(binding.Mode),
		},
	})
	_ = anchor
}

func (r *VisualAnchorRegistry) Lookup(anchorNonce string) (VisualAnchorBinding, bool) {
	if r == nil || anchorNonce == "" {
		return VisualAnchorBinding{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	binding, ok := r.bindings[anchorNonce]
	return binding, ok
}

// Invalidate drops all pending and confirmed bindings for a clear/session
// boundary. Old markers must not become valid in a new visual generation.
func (r *VisualAnchorRegistry) Invalidate() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for nonce := range r.anchors {
		r.rejected[nonce] = struct{}{}
	}
	for nonce := range r.confirmations {
		r.rejected[nonce] = struct{}{}
	}
	for nonce := range r.bindings {
		r.rejected[nonce] = struct{}{}
	}
	r.anchors = make(map[string]VisualAnchor)
	r.confirmations = make(map[string]VisualAnchorConfirmation)
	r.bindings = make(map[string]VisualAnchorBinding)
}

// ObserveHostedStart adapts an authenticated hosted event without exposing
// shellexec types to callers that only need the registry seam.
func (r *VisualAnchorRegistry) ObserveHostedStart(event shellexec.HostedRuntimeEvent, blockID string, sessionEpoch string, hookSequence uint64) {
	if r == nil || event.Kind != "command_started" {
		return
	}
	r.ObserveConfirmation(VisualAnchorConfirmation{
		BlockID:      blockID,
		SessionEpoch: sessionEpoch,
		HookSequence: hookSequence,
		CommandID:    event.CommandID,
		AnchorNonce:  event.AnchorNonce,
		HostID:       event.HostID,
		RunspaceID:   event.RunspaceID,
		Mode:         executionMode(event.Mode),
	})
}

func executionMode(mode string) terminalruntime.ExecutionMode {
	if mode == string(terminalruntime.ExecutionModeStructured) {
		return terminalruntime.ExecutionModeStructured
	}
	if mode == string(terminalruntime.ExecutionModeInteractive) {
		return terminalruntime.ExecutionModeInteractive
	}
	return terminalruntime.ExecutionModeUnknown
}
