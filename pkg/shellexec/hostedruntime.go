// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/blocklogger"
)

type hostedSidechannel struct {
	listener  net.Listener
	token     string
	blockID   string
	tracePath string
	observer  HostedRuntimeObserver
}

// HostedRuntimeEvent is the transport DTO emitted by WbtHostedPowerShell.
// It deliberately remains separate from CommandRecord and Journal state.
type HostedRuntimeEvent struct {
	Kind         string `json:"kind"`
	HostID       string `json:"hostId"`
	RunspaceID   string `json:"runspaceId"`
	CommandID    string `json:"commandId"`
	AnchorNonce  string `json:"anchorNonce"`
	HookSequence uint64 `json:"hookSequence"`
	Command      string `json:"command"`
	Cwd          string `json:"cwd"`
	Mode         string `json:"mode"`
	Stream       string `json:"stream"`
	Data         string `json:"data"`
	Success      *bool  `json:"success"`
	ExitCode     *int   `json:"exitCode"`
	Interrupted  bool   `json:"interrupted"`
}

// HostedRuntimeObserver consumes authenticated hosted-runtime events without
// exposing Wave or PTY types to the product domain.
type HostedRuntimeObserver interface {
	ObserveHostedRuntimeEvent(HostedRuntimeEvent)
}

func newHostedSidechannel(blockID string, observer HostedRuntimeObserver) (*hostedSidechannel, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen hosted runtime sidechannel: %w", err)
	}
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("generate hosted runtime sidechannel token: %w", err)
	}
	return &hostedSidechannel{
		listener:  listener,
		token:     hex.EncodeToString(tokenBytes[:]),
		blockID:   blockID,
		tracePath: filepath.Join(os.TempDir(), fmt.Sprintf("wbt-hosted-%s-%d.log", sanitizeHostedBlockID(blockID), time.Now().UnixNano())),
		observer:  observer,
	}, nil
}

func (s *hostedSidechannel) address() string { return s.listener.Addr().String() }

func (s *hostedSidechannel) env() map[string]string {
	return map[string]string{
		"WBT_HOSTED_SIDECAR_ADDR":  s.address(),
		"WBT_HOSTED_SIDECAR_TOKEN": s.token,
		"WBT_HOSTED_RUNTIME":       "1",
		"WBT_HOSTED_TRACE_PATH":    s.tracePath,
	}
}

func (s *hostedSidechannel) serve() {
	conn, err := s.listener.Accept()
	_ = s.listener.Close()
	if err != nil {
		if !strings.Contains(err.Error(), "use of closed network connection") {
			log.Printf("[hosted-runtime] block=%s sidechannel accept failed: %v", s.blockID, err)
		}
		return
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	decoder := json.NewDecoder(bufio.NewReader(conn))
	var first HostedRuntimeEvent
	var hello struct {
		Kind   string `json:"kind"`
		Token  string `json:"token"`
		HostID string `json:"hostId"`
	}
	if err := decoder.Decode(&hello); err != nil {
		log.Printf("[hosted-runtime] block=%s sidechannel hello failed: %v", s.blockID, err)
		return
	}
	if hello.Kind != "hello" || hello.Token != s.token {
		log.Printf("[hosted-runtime] block=%s sidechannel authentication failed", s.blockID)
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	first = HostedRuntimeEvent{Kind: hello.Kind, HostID: hello.HostID}
	logHostedEvent(s.blockID, first)
	if s.observer != nil {
		s.observer.ObserveHostedRuntimeEvent(first)
	}
	for {
		var event HostedRuntimeEvent
		if err := decoder.Decode(&event); err != nil {
			if err != io.EOF {
				log.Printf("[hosted-runtime] block=%s sidechannel read failed: %v", s.blockID, err)
			}
			return
		}
		logHostedEvent(s.blockID, event)
		if s.observer != nil {
			s.observer.ObserveHostedRuntimeEvent(event)
		}
	}
}

func logHostedEvent(blockID string, event HostedRuntimeEvent) {
	kind := event.Kind
	if kind == "output" {
		log.Printf("[hosted-runtime] block=%s kind=%s command_id=%s mode=%s length=%d", blockID, kind, event.CommandID, event.Mode, len(event.Data))
		return
	}
	log.Printf("[hosted-runtime] block=%s kind=%s host_id=%s runspace_id=%s command_id=%s mode=%s success=%v exit_code=%v interrupted=%v", blockID, kind, event.HostID, event.RunspaceID, event.CommandID, event.Mode, event.Success, event.ExitCode, event.Interrupted)
}

func prepareHostedPowerShell(ecmdEnv *[]string, blockID string, observer HostedRuntimeObserver) (*hostedSidechannel, error) {
	sidechannel, err := newHostedSidechannel(blockID, observer)
	if err != nil {
		return nil, err
	}
	for key, value := range sidechannel.env() {
		*ecmdEnv = append(*ecmdEnv, key+"="+value)
	}
	go sidechannel.serve()
	return sidechannel, nil
}

func hostedRuntimeEnabled() bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv("WBT_HOSTED_PWSH")))
	return value == "1" || value == "true" || value == "yes"
}

func hostedRuntimePath() string {
	return strings.TrimSpace(os.Getenv("WBT_HOSTED_PWSH_EXE"))
}

func sanitizeHostedBlockID(blockID string) string {
	if blockID == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range blockID {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

func logHostedLaunch(logCtx context.Context, blockID, executable string) {
	blocklogger.Debugf(logCtx, "[hosted-runtime] opt-in executable=%s block=%s\n", executable, blockID)
}
