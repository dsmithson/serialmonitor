package config

import (
	"fmt"
	"os"
	"sync"

	"gopkg.in/yaml.v3"
)

type Parity string
type StopBits float64

const (
	ParityNone  Parity = "none"
	ParityOdd   Parity = "odd"
	ParityEven  Parity = "even"

	StopBits1   StopBits = 1
	StopBits15  StopBits = 1.5
	StopBits2   StopBits = 2
)

type PortConfig struct {
	Device   string   `yaml:"device"`
	Name     string   `yaml:"name"`
	Enabled  bool     `yaml:"enabled"`
	BaudRate int      `yaml:"baud_rate"`
	DataBits int      `yaml:"data_bits"`
	Parity   Parity   `yaml:"parity"`
	StopBits StopBits `yaml:"stop_bits"`
	Color    string   `yaml:"color,omitempty"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

type Config struct {
	Server ServerConfig `yaml:"server"`
	Ports  []PortConfig `yaml:"ports"`
}

// Default palette assigned to ports without an explicit color.
var defaultColors = []string{
	"#4CAF50", "#2196F3", "#FF9800", "#E91E63",
	"#00BCD4", "#9C27B0", "#FFEB3B", "#FF5722",
}

func Default() *Config {
	return &Config{
		Server: ServerConfig{Host: "0.0.0.0", Port: 8080},
		Ports:  []PortConfig{},
	}
}

func DefaultPort(device string) PortConfig {
	return PortConfig{
		Device:   device,
		Name:     device,
		Enabled:  false,
		BaudRate: 115200,
		DataBits: 8,
		Parity:   ParityNone,
		StopBits: StopBits1,
	}
}

type Manager struct {
	mu       sync.RWMutex
	path     string
	cfg      *Config
	onChange func(*Config)
}

func NewManager(path string, onChange func(*Config)) (*Manager, error) {
	m := &Manager{path: path, onChange: onChange}
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	assignMissingColors(cfg)
	m.cfg = cfg
	return m, nil
}

func load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Default(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading config %s: %w", path, err)
	}
	cfg := Default()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parsing config %s: %w", path, err)
	}
	return cfg, nil
}

func (m *Manager) Reload() error {
	cfg, err := load(m.path)
	if err != nil {
		return err
	}
	assignMissingColors(cfg)
	m.mu.Lock()
	m.cfg = cfg
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(cfg)
	}
	return nil
}

func (m *Manager) Get() *Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg
}

func (m *Manager) Save(cfg *Config) error {
	assignMissingColors(cfg)
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshalling config: %w", err)
	}
	if err := os.WriteFile(m.path, data, 0644); err != nil {
		return fmt.Errorf("writing config %s: %w", m.path, err)
	}
	m.mu.Lock()
	m.cfg = cfg
	m.mu.Unlock()
	if m.onChange != nil {
		m.onChange(cfg)
	}
	return nil
}

// UpsertPort adds or replaces a port config entry by device path.
func (m *Manager) UpsertPort(p PortConfig) error {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	// clone ports slice
	ports := make([]PortConfig, len(cfg.Ports))
	copy(ports, cfg.Ports)

	found := false
	for i, existing := range ports {
		if existing.Device == p.Device {
			ports[i] = p
			found = true
			break
		}
	}
	if !found {
		ports = append(ports, p)
	}

	newCfg := &Config{Server: cfg.Server, Ports: ports}
	return m.Save(newCfg)
}

// DeletePort removes a port config entry by device path.
func (m *Manager) DeletePort(device string) error {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	ports := make([]PortConfig, 0, len(cfg.Ports))
	for _, p := range cfg.Ports {
		if p.Device != device {
			ports = append(ports, p)
		}
	}
	newCfg := &Config{Server: cfg.Server, Ports: ports}
	return m.Save(newCfg)
}

func assignMissingColors(cfg *Config) {
	used := map[string]bool{}
	for _, p := range cfg.Ports {
		if p.Color != "" {
			used[p.Color] = true
		}
	}
	colorIdx := 0
	for i, p := range cfg.Ports {
		if p.Color == "" {
			for colorIdx < len(defaultColors) && used[defaultColors[colorIdx]] {
				colorIdx++
			}
			if colorIdx < len(defaultColors) {
				cfg.Ports[i].Color = defaultColors[colorIdx]
				used[defaultColors[colorIdx]] = true
				colorIdx++
			}
		}
	}
}
