package terminalruntime

import "sync"

type EventSink func(OutputChunk, []IntegrationEvent)
type StreamSink func(OutputChunk, []StreamItem)

const DefaultOutputObserverQueueBytes int64 = 8 * 1024 * 1024

type OutputObserverOptions struct {
	MaxQueueBytes int64
}

// OutputObserver is an asynchronous, lossless-for-accepted-submissions queue.
// ObserveOutput only copies/enqueues bytes; decoding and sinks run off the PTY path.
type OutputObserver struct {
	blockID     string
	decoder     *Decoder
	sink        EventSink
	streamSink  StreamSink
	mu          sync.Mutex
	queue       [][]byte
	queueBytes  int64
	maxBytes    int64
	pendingDrop int64
	wake        chan struct{}
	done        chan struct{}
	closed      bool
	wg          sync.WaitGroup
}

func NewOutputObserver(blockID string, decoder *Decoder, sink EventSink) *OutputObserver {
	return NewOutputObserverWithStream(blockID, decoder, sink, nil)
}

func NewOutputObserverWithStream(blockID string, decoder *Decoder, sink EventSink, streamSink StreamSink) *OutputObserver {
	return NewOutputObserverWithOptions(blockID, decoder, sink, streamSink, OutputObserverOptions{})
}

func NewOutputObserverWithOptions(blockID string, decoder *Decoder, sink EventSink, streamSink StreamSink, opts OutputObserverOptions) *OutputObserver {
	if decoder == nil {
		decoder = NewDecoder()
	}
	maxBytes := opts.MaxQueueBytes
	if maxBytes <= 0 {
		maxBytes = DefaultOutputObserverQueueBytes
	}
	o := &OutputObserver{blockID: blockID, decoder: decoder, sink: sink, streamSink: streamSink, maxBytes: maxBytes, wake: make(chan struct{}, 1), done: make(chan struct{})}
	o.wg.Add(1)
	go o.run()
	return o
}

func (o *OutputObserver) ObserveOutput(_ string, raw []byte) {
	if len(raw) == 0 {
		return
	}
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	if o.queueBytes+int64(len(raw)) > o.maxBytes {
		o.pendingDrop += int64(len(raw))
		o.mu.Unlock()
		o.wakeWorker()
		return
	}
	copyOfRaw := append([]byte(nil), raw...)
	o.queue = append(o.queue, copyOfRaw)
	o.queueBytes += int64(len(copyOfRaw))
	o.mu.Unlock()
	o.wakeWorker()
}

func (o *OutputObserver) wakeWorker() {
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
	o.wakeWorker()
	o.wg.Wait()
}

func (o *OutputObserver) run() {
	defer o.wg.Done()
	var sequence uint64
	for {
		o.mu.Lock()
		if len(o.queue) == 0 && o.pendingDrop > 0 {
			dropped := o.pendingDrop
			o.pendingDrop = 0
			o.mu.Unlock()
			sequence++
			chunk := OutputChunk{BlockID: o.blockID, Sequence: sequence, Complete: false, DroppedBytes: dropped}
			if o.sink != nil {
				o.sink(chunk, nil)
			}
			if o.streamSink != nil {
				o.streamSink(chunk, nil)
			}
			continue
		}
		if len(o.queue) > 0 {
			raw := o.queue[0]
			o.queue = o.queue[1:]
			o.queueBytes -= int64(len(raw))
			o.mu.Unlock()
			sequence++
			items := o.decoder.FeedOrdered(raw)
			events := make([]IntegrationEvent, 0, len(items))
			for _, item := range items {
				if item.Kind == StreamIntegrationEvent {
					events = append(events, item.Event)
				}
			}
			chunk := OutputChunk{BlockID: o.blockID, Sequence: sequence, Raw: raw, Complete: true}
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
