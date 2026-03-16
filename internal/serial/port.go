package serial

import (
	"bufio"
	"context"
	"log/slog"
	"time"

	"go.bug.st/serial"

	"github.com/dsmithson/serialmonitor/internal/broadcast"
	"github.com/dsmithson/serialmonitor/internal/config"
)

const reconnectDelay = 5 * time.Second

// Port manages a single serial connection.
type Port struct {
	cfg    config.PortConfig
	hub    *broadcast.Hub
	sendCh chan string
}

func newPort(cfg config.PortConfig, hub *broadcast.Hub) *Port {
	return &Port{
		cfg:    cfg,
		hub:    hub,
		sendCh: make(chan string, 32),
	}
}

// Send queues a string to be written to the serial port.
func (p *Port) Send(data string) {
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
				if _, err := sp.Write([]byte(data)); err != nil {
					writeErr <- err
					return
				}
			}
		}
	}()

	// Read loop
	scanner := bufio.NewScanner(sp)
	readDone := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			line := scanner.Text()
			slog.Info("received", "port", p.cfg.Name, "device", p.cfg.Device, "data", line)
			p.hub.Publish(broadcast.Message{
				Port:   p.cfg.Name,
				Device: p.cfg.Device,
				Color:  p.cfg.Color,
				Data:   line,
				Ts:     time.Now().UTC().Format(time.RFC3339),
			})
		}
		readDone <- scanner.Err()
	}()

	select {
	case <-ctx.Done():
		sp.Close()
		return nil
	case err := <-writeErr:
		return err
	case err := <-readDone:
		if err != nil {
			return err
		}
		return nil
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
