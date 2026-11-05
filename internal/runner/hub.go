package runner

import "sync"

// Event is pushed to UI/CLI subscribers.
type Event struct {
	Type    string `json:"type"` // log | service | snapshot | terms
	Service string `json:"service,omitempty"`
	Entry   *Entry `json:"entry,omitempty"`
	Info    *Info  `json:"info,omitempty"`
	State   *State `json:"state,omitempty"`
	// Logs is only sent in the first snapshot of a connection: the log
	// history of every service, so the UI needs no extra requests.
	Logs map[string][]Entry `json:"logs,omitempty"`
	// Terms is the terminal list (snapshot and "terms" events).
	Terms any `json:"terms,omitempty"`
}

// Hub fans events out to subscribers. Slow subscribers are dropped
// (their channel is closed) and are expected to reconnect.
type Hub struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan Event]struct{}{}} }

func (h *Hub) Subscribe() chan Event {
	ch := make(chan Event, 8192)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(ch chan Event) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *Hub) Publish(e Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- e:
		default:
			delete(h.subs, ch)
			close(ch)
		}
	}
}
