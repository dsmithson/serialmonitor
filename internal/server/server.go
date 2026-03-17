package server

import (
	"context"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/dsmithson/serialmonitor/internal/broadcast"
	"github.com/dsmithson/serialmonitor/internal/config"
	"github.com/dsmithson/serialmonitor/internal/serial"
	"github.com/dsmithson/serialmonitor/web"
)

// Server wires together HTTP routing, WebSocket hub, and serial manager.
type Server struct {
	cfgMgr *config.Manager
	hub    *broadcast.Hub
	serial *serial.Manager
	http   *http.Server
}

func New(cfgMgr *config.Manager, hub *broadcast.Hub, serialMgr *serial.Manager) *Server {
	s := &Server{
		cfgMgr: cfgMgr,
		hub:    hub,
		serial: serialMgr,
	}

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// WebSocket endpoints
	r.Get("/ws/stream", s.wsStream)
	r.Get("/ws/port/{name}", s.wsPort)

	// REST API
	r.Get("/api/ports", s.apiListPorts)
	r.Get("/api/ports/available", s.apiAvailablePorts)
	r.Put("/api/ports/*", s.apiUpsertPort)
	r.Delete("/api/ports/*", s.apiDeletePort)
	r.Post("/api/ports/{name}/enable", s.apiSetPortEnabled(true))
	r.Post("/api/ports/{name}/disable", s.apiSetPortEnabled(false))
	r.Post("/api/ports/{name}/send", s.apiSendToPort)
	r.Get("/api/config", s.apiGetConfig)
	r.Put("/api/config", s.apiSaveConfig)

	// Serve embedded static web UI
	r.Handle("/*", http.FileServer(http.FS(web.Static)))

	cfg := cfgMgr.Get()
	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)

	s.http = &http.Server{Addr: addr, Handler: r}
	return s
}

func (s *Server) Start() error {
	return s.http.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.http.Shutdown(ctx)
}
