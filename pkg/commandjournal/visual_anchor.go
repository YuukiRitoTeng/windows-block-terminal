// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package commandjournal

import (
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const (
	visualAnchorPendingCapacity   = 256
	visualAnchorBindingCapacity   = 1024
	visualAnchorTombstoneCapacity = 512
	visualAnchorPendingTTL        = 10 * time.Minute
	visualAnchorTombstoneTTL      = 30 * time.Minute
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
	sessionEpoch  string
	maxSequence   uint64
	anchors       map[string]visualAnchorEntry
	confirmations map[string]visualConfirmationEntry
	bindings      map[string]visualBindingEntry
	rejected      map[string]time.Time
}

type visualAnchorEntry struct {
	anchor VisualAnchor
	at     time.Time
}

type visualConfirmationEntry struct {
	confirmation VisualAnchorConfirmation
	at           time.Time
}

type visualBindingEntry struct {
	binding VisualAnchorBinding
	at      time.Time
}

func NewVisualAnchorRegistry(blockID string) *VisualAnchorRegistry {
	return &VisualAnchorRegistry{
		blockID:       blockID,
		anchors:       make(map[string]visualAnchorEntry),
		confirmations: make(map[string]visualConfirmationEntry),
		bindings:      make(map[string]visualBindingEntry),
		rejected:      make(map[string]time.Time),
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
	now := time.Now()
	r.pruneLocked(now)
	if !r.acceptEpochAndSequenceLocked(anchor.SessionEpoch, anchor.HookSequence, anchor.AnchorNonce) {
		return
	}
	if _, ok := r.rejected[anchor.AnchorNonce]; ok {
		return
	}
	if _, ok := r.bindings[anchor.AnchorNonce]; ok {
		return
	}
	if _, ok := r.anchors[anchor.AnchorNonce]; ok {
		return
	}
	if confirmationEntry, ok := r.confirmations[anchor.AnchorNonce]; ok {
		confirmation := confirmationEntry.confirmation
		if !visualAnchorContextsMatch(anchor, confirmation) {
			delete(r.confirmations, anchor.AnchorNonce)
			r.rejected[anchor.AnchorNonce] = now
			return
		}
		delete(r.confirmations, anchor.AnchorNonce)
		r.bindLocked(anchor, confirmation)
		return
	}
	r.anchors[anchor.AnchorNonce] = visualAnchorEntry{anchor: anchor, at: now}
	r.evictPendingLocked(now)
	r.evictTombstonesLocked(now)
}

// ObserveConfirmation records an authenticated hosted command start. It is
// the only path that can provide a CommandRecord identity to a visual anchor.
func (r *VisualAnchorRegistry) ObserveConfirmation(confirmation VisualAnchorConfirmation) {
	if r == nil || confirmation.BlockID == "" || confirmation.BlockID != r.blockID || confirmation.SessionEpoch == "" || confirmation.HookSequence == 0 || confirmation.CommandID == "" || confirmation.AnchorNonce == "" || confirmation.HostID == "" || confirmation.RunspaceID == "" || confirmation.Mode != terminalruntime.ExecutionModeStructured {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.pruneLocked(now)
	if !r.acceptEpochAndSequenceLocked(confirmation.SessionEpoch, confirmation.HookSequence, confirmation.AnchorNonce) {
		return
	}
	if _, ok := r.rejected[confirmation.AnchorNonce]; ok {
		return
	}
	if _, ok := r.bindings[confirmation.AnchorNonce]; ok {
		return
	}
	if anchorEntry, ok := r.anchors[confirmation.AnchorNonce]; ok {
		anchor := anchorEntry.anchor
		if !visualAnchorContextsMatch(anchor, confirmation) {
			delete(r.anchors, confirmation.AnchorNonce)
			r.rejected[confirmation.AnchorNonce] = now
			return
		}
		delete(r.anchors, confirmation.AnchorNonce)
		r.bindLocked(anchor, confirmation)
		return
	}
	if _, ok := r.confirmations[confirmation.AnchorNonce]; ok {
		return
	}
	r.confirmations[confirmation.AnchorNonce] = visualConfirmationEntry{confirmation: confirmation, at: now}
	r.evictPendingLocked(now)
	r.evictTombstonesLocked(now)
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
	r.bindings[binding.AnchorNonce] = visualBindingEntry{binding: binding, at: time.Now()}
	r.evictBindingsLocked(time.Now())
	r.evictTombstonesLocked(time.Now())
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
	r.pruneLocked(time.Now())
	binding, ok := r.bindings[anchorNonce]
	if !ok {
		return VisualAnchorBinding{}, false
	}
	return binding.binding, true
}

// Invalidate drops all pending and confirmed bindings for a clear/session
// boundary. Old markers must not become valid in a new visual generation.
func (r *VisualAnchorRegistry) Invalidate() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for nonce := range r.anchors {
		r.rejected[nonce] = now
	}
	for nonce := range r.confirmations {
		r.rejected[nonce] = now
	}
	for nonce := range r.bindings {
		r.rejected[nonce] = now
	}
	r.anchors = make(map[string]visualAnchorEntry)
	r.confirmations = make(map[string]visualConfirmationEntry)
	r.bindings = make(map[string]visualBindingEntry)
	r.evictTombstonesLocked(now)
}

func (r *VisualAnchorRegistry) acceptEpochAndSequenceLocked(epoch string, sequence uint64, nonce string) bool {
	if epoch == "" || sequence == 0 {
		return false
	}
	if r.sessionEpoch == "" {
		r.sessionEpoch = epoch
	} else if r.sessionEpoch != epoch {
		return false
	}
	if sequence < r.maxSequence {
		return false
	}
	if sequence == r.maxSequence && nonce != "" {
		_, anchorPending := r.anchors[nonce]
		_, confirmationPending := r.confirmations[nonce]
		if !anchorPending && !confirmationPending {
			return false
		}
	}
	if sequence > r.maxSequence {
		r.maxSequence = sequence
	}
	return true
}

func (r *VisualAnchorRegistry) pruneLocked(now time.Time) {
	for nonce, entry := range r.anchors {
		if now.Sub(entry.at) > visualAnchorPendingTTL {
			delete(r.anchors, nonce)
			r.rejected[nonce] = now
		}
	}
	for nonce, entry := range r.confirmations {
		if now.Sub(entry.at) > visualAnchorPendingTTL {
			delete(r.confirmations, nonce)
			r.rejected[nonce] = now
		}
	}
	for nonce, at := range r.rejected {
		if now.Sub(at) > visualAnchorTombstoneTTL {
			delete(r.rejected, nonce)
		}
	}
	r.evictPendingLocked(now)
	r.evictBindingsLocked(now)
	r.evictTombstonesLocked(now)
}

func (r *VisualAnchorRegistry) evictPendingLocked(now time.Time) {
	for len(r.anchors) > visualAnchorPendingCapacity {
		r.evictOldestAnchorLocked(now)
	}
	for len(r.confirmations) > visualAnchorPendingCapacity {
		r.evictOldestConfirmationLocked(now)
	}
}

func (r *VisualAnchorRegistry) evictOldestAnchorLocked(now time.Time) {
	var oldestNonce string
	var oldest time.Time
	for nonce, entry := range r.anchors {
		if oldestNonce == "" || entry.at.Before(oldest) {
			oldestNonce, oldest = nonce, entry.at
		}
	}
	if oldestNonce != "" {
		delete(r.anchors, oldestNonce)
		r.rejected[oldestNonce] = now
	}
}

func (r *VisualAnchorRegistry) evictOldestConfirmationLocked(now time.Time) {
	var oldestNonce string
	var oldest time.Time
	for nonce, entry := range r.confirmations {
		if oldestNonce == "" || entry.at.Before(oldest) {
			oldestNonce, oldest = nonce, entry.at
		}
	}
	if oldestNonce != "" {
		delete(r.confirmations, oldestNonce)
		r.rejected[oldestNonce] = now
	}
}

func (r *VisualAnchorRegistry) evictBindingsLocked(now time.Time) {
	for len(r.bindings) > visualAnchorBindingCapacity {
		var oldestNonce string
		var oldest time.Time
		for nonce, entry := range r.bindings {
			if oldestNonce == "" || entry.at.Before(oldest) {
				oldestNonce, oldest = nonce, entry.at
			}
		}
		if oldestNonce == "" {
			return
		}
		delete(r.bindings, oldestNonce)
		r.rejected[oldestNonce] = now
	}
}

func (r *VisualAnchorRegistry) evictTombstonesLocked(now time.Time) {
	for len(r.rejected) > visualAnchorTombstoneCapacity {
		var oldestNonce string
		var oldest time.Time
		for nonce, at := range r.rejected {
			if oldestNonce == "" || at.Before(oldest) {
				oldestNonce, oldest = nonce, at
			}
		}
		if oldestNonce == "" {
			return
		}
		delete(r.rejected, oldestNonce)
	}
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
