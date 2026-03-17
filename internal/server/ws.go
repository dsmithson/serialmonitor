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

// wsStream handles /ws/stream — broadcasts all port messages as JSON to the client.
func (s *Server) wsStream(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	sub := s.hub.SubscribeWithHistory("")
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

// wsPort handles /ws/port/{name} — a raw binary terminal tunnel.
//
// Client → server: binary frames containing raw keystrokes (xterm.js onData bytes).
// Server → client: binary frames containing raw serial output.
//
// This bypasses line-buffering so prompts (login:, $, etc.) appear immediately.
func (s *Server) wsPort(w http.ResponseWriter, r *http.Request) {
	portName := chi.URLParam(r, "name")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	tc := s.serial.RegisterTerminal(portName)
	if tc == nil {
		// Port not active — write ANSI error into the terminal and close.
		msg := "\r\n\x1b[31m[port '" + portName + "' is not active — check Configuration tab]\x1b[0m\r\n"
		conn.WriteMessage(websocket.BinaryMessage, []byte(msg))
		return
	}
	defer s.serial.UnregisterTerminal(portName, tc)

	// Client → serial: raw keystroke bytes from xterm.js onData
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			s.serial.Send(portName, data)
		}
	}()

	// Serial → client: raw byte chunks forwarded immediately as binary frames
	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case chunk, ok := <-tc.Ch:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				return
			}
		}
	}
}

// wsPortSend is a small REST-compatible wrapper kept for non-WS callers.
// The primary send path is via the wsPort binary WebSocket.
func parseJSONSend(data []byte) (string, bool) {
	var req struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return "", false
	}
	return req.Data, true
}
