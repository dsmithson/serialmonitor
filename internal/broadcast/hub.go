// Package broadcast implements a fan-out hub that distributes serial port
// messages to all registered WebSocket subscribers.
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
	// Port is non-empty when the subscriber only wants messages from one port.
	Port string
	Ch   chan Message
}

// Hub distributes Messages to all registered subscribers.
type Hub struct {
	mu   sync.RWMutex
	subs map[*Subscriber]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: make(map[*Subscriber]struct{})}
}

// Subscribe registers a subscriber. If port is non-empty only messages from
// that port are delivered.
func (h *Hub) Subscribe(port string) *Subscriber {
	s := &Subscriber{Port: port, Ch: make(chan Message, 64)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

// Unsubscribe removes a subscriber and closes its channel.
func (h *Hub) Unsubscribe(s *Subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
	close(s.Ch)
}

// Publish sends a message to all matching subscribers (non-blocking).
func (h *Hub) Publish(msg Message) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if s.Port != "" && s.Port != msg.Port {
			continue
		}
		select {
		case s.Ch <- msg:
		default:
			// slow subscriber — drop rather than block
		}
	}
}
