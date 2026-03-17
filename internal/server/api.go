package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/dsmithson/serialmonitor/internal/config"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// GET /api/ports
func (s *Server) apiListPorts(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfgMgr.Get()
	active := s.serial.ActivePorts()
	activeSet := map[string]bool{}
	for _, n := range active {
		activeSet[n] = true
	}

	type portStatus struct {
		config.PortConfig
		Connected bool `json:"connected"` // already lowercase, but explicit
	}

	result := make([]portStatus, len(cfg.Ports))
	for i, p := range cfg.Ports {
		result[i] = portStatus{PortConfig: p, Connected: activeSet[p.Name]}
	}
	writeJSON(w, http.StatusOK, result)
}

// GET /api/ports/available
func (s *Server) apiAvailablePorts(w http.ResponseWriter, r *http.Request) {
	ports, err := listAvailablePorts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ports)
}

// PUT /api/ports/{device} — upsert a port config (device is URL-encoded path)
func (s *Server) apiUpsertPort(w http.ResponseWriter, r *http.Request) {
	device := chi.URLParam(r, "*")
	if device == "" {
		writeError(w, http.StatusBadRequest, "device path required")
		return
	}
	// chi wildcard strips leading slash; restore it
	if !strings.HasPrefix(device, "/") {
		device = "/" + device
	}

	var p config.PortConfig
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	p.Device = device

	if err := s.cfgMgr.UpsertPort(p); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.serial.Sync(s.cfgMgr.Get())
	writeJSON(w, http.StatusOK, p)
}

// DELETE /api/ports/{device}
func (s *Server) apiDeletePort(w http.ResponseWriter, r *http.Request) {
	device := chi.URLParam(r, "*")
	if !strings.HasPrefix(device, "/") {
		device = "/" + device
	}
	if err := s.cfgMgr.DeletePort(device); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.serial.Sync(s.cfgMgr.Get())
	w.WriteHeader(http.StatusNoContent)
}

// POST /api/ports/{name}/enable  and  /api/ports/{name}/disable
func (s *Server) apiSetPortEnabled(enabled bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		cfg := s.cfgMgr.Get()
		for _, p := range cfg.Ports {
			if p.Name == name {
				p.Enabled = enabled
				if err := s.cfgMgr.UpsertPort(p); err != nil {
					writeError(w, http.StatusInternalServerError, err.Error())
					return
				}
				s.serial.Sync(s.cfgMgr.Get())
				writeJSON(w, http.StatusOK, map[string]any{"name": name, "enabled": enabled})
				return
			}
		}
		writeError(w, http.StatusNotFound, "port not found")
	}
}

// POST /api/ports/{name}/send
func (s *Server) apiSendToPort(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	var req struct {
		Data string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !s.serial.Send(name, []byte(req.Data)) {
		writeError(w, http.StatusNotFound, "port not active")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/config
func (s *Server) apiGetConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.cfgMgr.Get())
}

// PUT /api/config — replace the full config (ports in caller-supplied order,
// server settings updated except host/port which require a restart).
func (s *Server) apiSaveConfig(w http.ResponseWriter, r *http.Request) {
	var incoming config.Config
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	existing := s.cfgMgr.Get()
	// Preserve host/port — changing them requires a process restart
	incoming.Server.Host = existing.Server.Host
	incoming.Server.Port = existing.Server.Port
	if incoming.Server.BufferSize <= 0 {
		incoming.Server.BufferSize = 300
	}
	if err := s.cfgMgr.Save(&incoming); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.serial.Sync(s.cfgMgr.Get())
	writeJSON(w, http.StatusOK, s.cfgMgr.Get())
}
