package terminalruntime

import "sync"

type EventSink func(OutputChunk, []IntegrationEvent)

// OutputObserver is an asynchronous, lossless-for-accepted-submissions queue.
// ObserveOutput only copies/enqueues bytes; decoding and sinks run off the PTY path.
type OutputObserver struct {
	epoch   string
	decoder *Decoder
	sink    EventSink
	mu      sync.Mutex
	queue   [][]byte
	wake    chan struct{}
	done    chan struct{}
	closed  bool
	wg      sync.WaitGroup
}

func NewOutputObserver(epoch string, decoder *Decoder, sink EventSink) *OutputObserver {
	if decoder == nil {
		decoder = NewDecoder()
	}
	o := &OutputObserver{epoch: epoch, decoder: decoder, sink: sink, wake: make(chan struct{}, 1), done: make(chan struct{})}
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
			events := o.decoder.Feed(raw)
			if o.sink != nil {
				o.sink(OutputChunk{SessionEpoch: o.epoch, Sequence: sequence, Raw: raw}, events)
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
