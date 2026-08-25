package terminalruntime

import "sync"

type EventSink func(OutputChunk, []IntegrationEvent)
type StreamSink func(OutputChunk, []StreamItem)

// OutputObserver is an asynchronous, lossless-for-accepted-submissions queue.
// ObserveOutput only copies/enqueues bytes; decoding and sinks run off the PTY path.
type OutputObserver struct {
	blockID    string
	decoder    *Decoder
	sink       EventSink
	streamSink StreamSink
	mu         sync.Mutex
	queue      [][]byte
	wake       chan struct{}
	done       chan struct{}
	closed     bool
	wg         sync.WaitGroup
}

func NewOutputObserver(blockID string, decoder *Decoder, sink EventSink) *OutputObserver {
	return NewOutputObserverWithStream(blockID, decoder, sink, nil)
}

func NewOutputObserverWithStream(blockID string, decoder *Decoder, sink EventSink, streamSink StreamSink) *OutputObserver {
	if decoder == nil {
		decoder = NewDecoder()
	}
	o := &OutputObserver{blockID: blockID, decoder: decoder, sink: sink, streamSink: streamSink, wake: make(chan struct{}, 1), done: make(chan struct{})}
	o.wg.Add(1)
	go o.run()
	return o
}

func (o *OutputObserver) ObserveOutput(_ string, raw []byte) {
	if len(raw) == 0 {
		return
	}
	copyOfRaw := append([]byte(nil), raw...)
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	o.queue = append(o.queue, copyOfRaw)
	o.mu.Unlock()
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func (o *OutputObserver) Close() {
	o.mu.Lock()
	if !o.closed {
		o.closed = true
		close(o.done)
	}
	o.mu.Unlock()
	select {
	case o.wake <- struct{}{}:
	default:
	}
	o.wg.Wait()
}

func (o *OutputObserver) run() {
	defer o.wg.Done()
	var sequence uint64
	for {
		o.mu.Lock()
		if len(o.queue) > 0 {
			raw := o.queue[0]
			o.queue = o.queue[1:]
			o.mu.Unlock()
			sequence++
			items := o.decoder.FeedOrdered(raw)
			events := make([]IntegrationEvent, 0, len(items))
			for _, item := range items {
				if item.Kind == StreamIntegrationEvent {
					events = append(events, item.Event)
				}
			}
			chunk := OutputChunk{BlockID: o.blockID, Sequence: sequence, Raw: raw}
			if o.sink != nil {
				o.sink(chunk, events)
			}
			if o.streamSink != nil {
				o.streamSink(chunk, items)
			}
			continue
		}
		closed := o.closed
		o.mu.Unlock()
		if closed {
			return
		}
		select {
		case <-o.wake:
		case <-o.done:
		}
	}
}
