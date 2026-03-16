package serial

import (
	"context"
	"log/slog"
	"sync"

	"github.com/dsmithson/serialmonitor/internal/broadcast"
	"github.com/dsmithson/serialmonitor/internal/config"
)

// Manager supervises all active serial port goroutines.
type Manager struct {
	hub *broadcast.Hub

	mu     sync.Mutex
	active map[string]*portEntry // keyed by device path
}

type portEntry struct {
	port   *Port
	cancel context.CancelFunc
}

func NewManager(hub *broadcast.Hub) *Manager {
	return &Manager{
		hub:    hub,
		active: make(map[string]*portEntry),
	}
}

// Sync reconciles running ports with the provided config, starting and stopping
// as needed. Safe to call at any time (e.g. on config reload).
func (m *Manager) Sync(cfg *config.Config) {
	m.mu.Lock()
	defer m.mu.Unlock()

	desired := map[string]config.PortConfig{}
	for _, p := range cfg.Ports {
		if p.Enabled {
			desired[p.Device] = p
		}
	}

	// Stop ports no longer desired
	for device, entry := range m.active {
		if _, ok := desired[device]; !ok {
			slog.Info("stopping serial port", "device", device)
			entry.cancel()
			delete(m.active, device)
		}
	}

	// Start new ports or restart ports with changed config
	for device, pcfg := range desired {
		if existing, ok := m.active[device]; ok {
			// Restart if config changed
			if configChanged(existing.port.cfg, pcfg) {
				slog.Info("restarting serial port due to config change", "device", device)
				existing.cancel()
				delete(m.active, device)
			} else {
				continue
			}
		}
		m.startLocked(pcfg)
	}
}

func (m *Manager) startLocked(pcfg config.PortConfig) {
	ctx, cancel := context.WithCancel(context.Background())
	p := newPort(pcfg, m.hub)
	m.active[pcfg.Device] = &portEntry{port: p, cancel: cancel}
	slog.Info("starting serial port", "port", pcfg.Name, "device", pcfg.Device)
	go p.run(ctx)
}

// Send delivers data to the named port (by port name, not device).
func (m *Manager) Send(portName, data string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, entry := range m.active {
		if entry.port.cfg.Name == portName {
			entry.port.Send(data)
			return true
		}
	}
	return false
}

// StopAll shuts down all running ports.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for device, entry := range m.active {
		entry.cancel()
		delete(m.active, device)
	}
}

// ActivePorts returns the names of currently running ports.
func (m *Manager) ActivePorts() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.active))
	for _, e := range m.active {
		names = append(names, e.port.cfg.Name)
	}
	return names
}

func configChanged(a, b config.PortConfig) bool {
	return a.BaudRate != b.BaudRate ||
		a.DataBits != b.DataBits ||
		a.Parity != b.Parity ||
		a.StopBits != b.StopBits ||
		a.Name != b.Name
}
