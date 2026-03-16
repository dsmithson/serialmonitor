package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// wsStream handles /ws/stream — broadcasts all port messages to the client.
func (s *Server) wsStream(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	sub := s.hub.Subscribe("")
	defer s.hub.Unsubscribe(sub)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case msg, ok := <-sub.Ch:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				return
			}
		}
	}
}

// wsPort handles /ws/port/{name} — bidirectional for a single port.
func (s *Server) wsPort(w http.ResponseWriter, r *http.Request) {
	portName := chi.URLParam(r, "name")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	sub := s.hub.Subscribe(portName)
	defer s.hub.Unsubscribe(sub)

	// Read goroutine: client → serial port
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				Data string `json:"data"`
			}
			if err := json.Unmarshal(raw, &req); err == nil && req.Data != "" {
				s.serial.Send(portName, req.Data)
			}
		}
	}()

	// Write loop: serial port → client
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case msg, ok := <-sub.Ch:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				return
			}
		}
	}
}
