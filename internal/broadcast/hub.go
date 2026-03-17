// Package broadcast implements a fan-out hub that distributes serial port
// messages to all registered WebSocket subscribers, with a ring-buffer history
// so new subscribers receive recent messages immediately on connect.
package broadcast

import "sync"

// Message is a single line received from a serial port.
type Message struct {
	Port   string `json:"port"`
	Device string `json:"device"`
	Color  string `json:"color"`
	Data   string `json:"data"`
	Ts     string `json:"ts"`
}

// Subscriber receives messages from the hub.
type Subscriber struct {
	Port string
	Ch   chan Message
}

// Hub distributes Messages to all registered subscribers and maintains a
// capped history ring buffer that is replayed to new subscribers.
type Hub struct {
	mu      sync.Mutex
	subs    map[*Subscriber]struct{}
	history []Message
	histCap int
}

func NewHub(histCap int) *Hub {
	if histCap < 0 {
		histCap = 0
	}
	return &Hub{
		subs:    make(map[*Subscriber]struct{}),
		histCap: histCap,
		history: make([]Message, 0, histCap),
	}
}

// SetHistoryCapacity updates the ring buffer capacity live (e.g. on config reload).
func (h *Hub) SetHistoryCapacity(cap int) {
	if cap < 0 {
		cap = 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.histCap = cap
	if cap == 0 {
		h.history = nil
		return
	}
	if len(h.history) > cap {
		h.history = h.history[len(h.history)-cap:]
	}
}

// Subscribe registers a subscriber that receives only live messages.
// If port is non-empty only messages from that port are delivered.
func (h *Hub) Subscribe(port string) *Subscriber {
	s := &Subscriber{Port: port, Ch: make(chan Message, 64)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

// SubscribeWithHistory registers a subscriber and pre-fills its channel with
// buffered history before live messages begin flowing.
func (h *Hub) SubscribeWithHistory(port string) *Subscriber {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Size channel to hold history + live headroom
	chCap := len(h.history) + 128
	if chCap < 128 {
		chCap = 128
	}
	s := &Subscriber{Port: port, Ch: make(chan Message, chCap)}

	for _, msg := range h.history {
		if port != "" && port != msg.Port {
			continue
		}
		select {
		case s.Ch <- msg:
		default:
		}
	}

	h.subs[s] = struct{}{}
	return s
}

// Unsubscribe removes a subscriber and closes its channel.
func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
	close(s.Ch)
}

// Publish sends a message to all matching subscribers and appends to history.
func (h *Hub) Publish(msg Message) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Append to ring buffer
	if h.histCap > 0 {
		h.history = append(h.history, msg)
		if len(h.history) > h.histCap {
			// Trim oldest — O(n) but histCap is small, negligible at serial rates
			copy(h.history, h.history[1:])
			h.history = h.history[:h.histCap]
		}
	}

	// Fan out to subscribers
	for s := range h.subs {
		if s.Port != "" && s.Port != msg.Port {
			continue
		}
		select {
		case s.Ch <- msg:
		default: // slow subscriber — drop
		}
	}
}
