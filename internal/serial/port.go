package serial

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"

	"github.com/dsmithson/serialmonitor/internal/broadcast"
	"github.com/dsmithson/serialmonitor/internal/config"
)

const reconnectDelay = 5 * time.Second

// TermConn is a raw-byte subscription to a serial port for terminal use.
type TermConn struct {
	Ch chan []byte
}

// Port manages a single serial connection.
type Port struct {
	cfg    config.PortConfig
	hub    *broadcast.Hub
	sendCh chan []byte

	termMu    sync.RWMutex
	termConns map[*TermConn]struct{}
}

func newPort(cfg config.PortConfig, hub *broadcast.Hub) *Port {
	return &Port{
		cfg:       cfg,
		hub:       hub,
		sendCh:    make(chan []byte, 32),
		termConns: make(map[*TermConn]struct{}),
	}
}

// RegisterTerminal creates a raw-byte subscription to this port's output.
func (p *Port) RegisterTerminal() *TermConn {
	tc := &TermConn{Ch: make(chan []byte, 256)}
	p.termMu.Lock()
	p.termConns[tc] = struct{}{}
	p.termMu.Unlock()
	return tc
}

// UnregisterTerminal removes a terminal connection and closes its channel.
func (p *Port) UnregisterTerminal(tc *TermConn) {
	p.termMu.Lock()
	delete(p.termConns, tc)
	p.termMu.Unlock()
	close(tc.Ch)
}

// Send queues raw bytes to be written to the serial port.
func (p *Port) Send(data []byte) {
	select {
	case p.sendCh <- data:
	default:
		slog.Warn("serial send buffer full, dropping", "port", p.cfg.Name)
	}
}

// run loops forever until ctx is cancelled, reconnecting on errors.
func (p *Port) run(ctx context.Context) {
	for {
		if err := p.connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("serial connection error", "port", p.cfg.Name, "device", p.cfg.Device, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(reconnectDelay):
			slog.Info("reconnecting serial port", "port", p.cfg.Name, "device", p.cfg.Device)
		}
	}
}

func (p *Port) connect(ctx context.Context) error {
	mode := &serial.Mode{
		BaudRate: p.cfg.BaudRate,
		DataBits: p.cfg.DataBits,
		Parity:   mapParity(p.cfg.Parity),
		StopBits: mapStopBits(p.cfg.StopBits),
	}

	sp, err := serial.Open(p.cfg.Device, mode)
	if err != nil {
		return err
	}
	defer sp.Close()

	slog.Info("serial port opened", "port", p.cfg.Name, "device", p.cfg.Device, "baud", p.cfg.BaudRate)

	// Write goroutine
	writeErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeErr <- nil
				return
			case data := <-p.sendCh:
				if _, err := sp.Write(data); err != nil {
					writeErr <- err
					return
				}
			}
		}
	}()

	// Read loop — raw bytes, no line buffering.
	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		var lineBuf []byte

		for {
			n, err := sp.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])

				// Forward raw bytes to all terminal connections immediately.
				p.termMu.RLock()
				for tc := range p.termConns {
					select {
					case tc.Ch <- chunk:
					default: // slow subscriber, drop
					}
				}
				p.termMu.RUnlock()

				// Accumulate into lines for the hub (live stream + stdout log).
				for _, b := range chunk {
					switch b {
					case '\n':
						line := strings.TrimRight(string(lineBuf), "\r")
						if line != "" {
							slog.Info("received", "port", p.cfg.Name, "device", p.cfg.Device, "data", line)
							p.hub.Publish(broadcast.Message{
								Port:   p.cfg.Name,
								Device: p.cfg.Device,
								Color:  p.cfg.Color,
								Data:   line,
								Ts:     time.Now().UTC().Format(time.RFC3339),
							})
						}
						lineBuf = lineBuf[:0]
					case '\r':
						// skip — handled as part of \r\n or ignored
					default:
						lineBuf = append(lineBuf, b)
					}
				}
			}
			if err != nil {
				readErr <- err
				return
			}
		}
	}()

	select {
	case <-ctx.Done():
		sp.Close()
		return nil
	case err := <-writeErr:
		return err
	case err := <-readErr:
		return err
	}
}

func mapParity(p config.Parity) serial.Parity {
	switch p {
	case config.ParityOdd:
		return serial.OddParity
	case config.ParityEven:
		return serial.EvenParity
	default:
		return serial.NoParity
	}
}

func mapStopBits(s config.StopBits) serial.StopBits {
	switch s {
	case config.StopBits15:
		return serial.OnePointFiveStopBits
	case config.StopBits2:
		return serial.TwoStopBits
	default:
		return serial.OneStopBit
	}
}
