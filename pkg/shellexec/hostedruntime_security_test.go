package shellexec

import (
	"encoding/json"
	"net"
	"testing"
	"time"
)

type securityEventSink struct {
	events chan HostedRuntimeEvent
}

func (s *securityEventSink) ObserveHostedRuntimeEvent(event HostedRuntimeEvent) {
	s.events <- event
}

func TestHostedSidechannelRejectsUnauthenticatedHello(t *testing.T) {
	sink := &securityEventSink{events: make(chan HostedRuntimeEvent, 1)}
	sidechannel, err := newHostedSidechannel("security-test", sink)
	if err != nil {
		t.Fatal(err)
	}
	defer sidechannel.listener.Close()
	if sidechannel.token == "" || len(sidechannel.token) != 64 {
		t.Fatalf("unexpected token shape: %q", sidechannel.token)
	}
	if addr := sidechannel.address(); len(addr) < len("127.0.0.1:") || addr[:len("127.0.0.1:")] != "127.0.0.1:" {
		t.Fatalf("sidechannel is not loopback-bound: %s", addr)
	}
	go sidechannel.serve()
	conn, err := net.Dial("tcp", sidechannel.address())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(conn).Encode(map[string]string{"kind": "hello", "token": "wrong-token", "hostId": "foreign"}); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	select {
	case event := <-sink.events:
		t.Fatalf("unauthenticated event was delivered: %#v", event)
	case <-time.After(100 * time.Millisecond):
	}
}
