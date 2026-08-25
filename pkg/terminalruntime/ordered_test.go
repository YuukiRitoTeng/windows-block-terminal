package terminalruntime

import (
	"bytes"
	"fmt"
	"testing"
)

func orderedFrame(kind, epoch, id string, sequence uint64) []byte {
	payload := fmt.Sprintf(`{"v":1,"epoch":"%s","seq":%d,"id":"%s"`, epoch, sequence, id)
	if kind == "D" {
		payload += `,"success":true,"exitcode":0`
	}
	return []byte(fmt.Sprintf("\x1b]16162;%s;%s}\a", kind, payload))
}

func outputFromItems(items []StreamItem) []byte {
	var output []byte
	for _, item := range items {
		if item.Kind == StreamOutputSegment {
			output = append(output, item.Output...)
		}
	}
	return output
}

func eventsFromItems(items []StreamItem) []IntegrationEvent {
	var events []IntegrationEvent
	for _, item := range items {
		if item.Kind == StreamIntegrationEvent {
			events = append(events, item.Event)
		}
	}
	return events
}

func TestDecoderOrderedStreamSameSubmission(t *testing.T) {
	d := NewDecoder()
	raw := append([]byte("prefix"), orderedFrame("C", "epoch-1", "cmd-1", 1)...)
	raw = append(raw, []byte("output-one")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-1", 2)...)
	raw = append(raw, []byte("suffix")...)
	items := d.FeedOrdered(raw)
	events := eventsFromItems(items)
	if len(events) != 2 || events[0].Kind != EventCommandStarted || events[1].Kind != EventCommandFinished {
		t.Fatalf("unexpected ordered lifecycle: %#v", events)
	}
	if got := string(outputFromItems(items)); got != "prefixoutput-onesuffix" {
		t.Fatalf("unexpected ordered output: %q", got)
	}
}

func TestDecoderOrderedStreamFragmentedFrames(t *testing.T) {
	d := NewDecoder()
	c := orderedFrame("C", "epoch-1", "cmd-1", 1)
	done := orderedFrame("D", "epoch-1", "cmd-1", 2)
	first := d.FeedOrdered(c[:len(c)/2])
	secondRaw := append(append(append([]byte{}, c[len(c)/2:]...), []byte("fragmented-output")...), done[:len(done)/2]...)
	second := d.FeedOrdered(secondRaw)
	third := d.FeedOrdered(done[len(done)/2:])
	if len(first) != 0 || len(eventsFromItems(second)) != 1 || len(eventsFromItems(third)) != 1 {
		t.Fatalf("fragmented lifecycle ordering failed: first=%#v second=%#v third=%#v", first, second, third)
	}
	if got := string(append(outputFromItems(second), outputFromItems(third)...)); got != "fragmented-output" {
		t.Fatalf("unexpected fragmented output: %q", got)
	}
}

func TestDecoderOrderedStreamTwoCommandsSameChunk(t *testing.T) {
	d := NewDecoder()
	raw := append(orderedFrame("C", "epoch-1", "cmd-1", 1), []byte("one")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-1", 2)...)
	raw = append(raw, orderedFrame("C", "epoch-1", "cmd-2", 3)...)
	raw = append(raw, []byte("two")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-2", 4)...)
	items := d.FeedOrdered(raw)
	var outputs []string
	var current int
	for _, item := range items {
		if item.Kind == StreamIntegrationEvent && item.Event.Kind == EventCommandStarted {
			current++
		} else if item.Kind == StreamOutputSegment && current > 0 {
			outputs = append(outputs, string(item.Output))
		}
	}
	if len(outputs) != 2 || !bytes.Equal([]byte(outputs[0]), []byte("one")) || !bytes.Equal([]byte(outputs[1]), []byte("two")) {
		t.Fatalf("cross-command output contamination: %#v", outputs)
	}
}

func TestDecoderOrderedStreamPreservesUnknownTerminalSequences(t *testing.T) {
	d := NewDecoder()
	unknown := []byte("\x1b]9;title\a")
	raw := append(orderedFrame("C", "epoch-1", "cmd-1", 1), []byte("before")...)
	raw = append(raw, unknown...)
	raw = append(raw, []byte("after")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-1", 2)...)
	items := d.FeedOrdered(raw)
	if !bytes.Contains(outputFromItems(items), unknown) || bytes.Contains(outputFromItems(items), orderedFrame("C", "epoch-1", "cmd-1", 1)) {
		t.Fatalf("terminal sequence/control bytes were not separated correctly: %#v", items)
	}
}

func TestDecoderOrderedStreamDropsInvalidProductFrame(t *testing.T) {
	d := NewDecoder()
	raw := append(orderedFrame("C", "epoch-1", "cmd-1", 1), []byte("one")...)
	raw = append(raw, []byte("\x1b]16162;D;{\"v\":1,\"epoch\":\"epoch-1\",\"seq\":2,\"id\":\"cmd-1\"}\a")...)
	raw = append(raw, orderedFrame("D", "epoch-1", "cmd-1", 3)...)
	items := d.FeedOrdered(raw)
	if got := string(outputFromItems(items)); got != "one" {
		t.Fatalf("invalid product control frame entered output: %q", got)
	}
	if len(eventsFromItems(items)) != 2 {
		t.Fatalf("active lifecycle was not preserved after invalid D: %#v", items)
	}
}
