package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dsmithson/serialmonitor/internal/broadcast"
	"github.com/dsmithson/serialmonitor/internal/config"
	"github.com/dsmithson/serialmonitor/internal/serial"
	"github.com/dsmithson/serialmonitor/internal/server"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	// Structured JSON logging to stdout (Loki-friendly)
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	// Load config first so hub is created with the right buffer size.
	cfgMgr, err := config.NewManager(*configPath, nil)
	if err != nil {
		slog.Error("failed to load config", "err", err)
		os.Exit(1)
	}

	hub := broadcast.NewHub(cfgMgr.Get().Server.BufferSize)
	serialMgr := serial.NewManager(hub)

	// Wire up onChange now that hub and serialMgr exist.
	cfgMgr.SetOnChange(func(cfg *config.Config) {
		slog.Info("config reloaded")
		serialMgr.Sync(cfg)
		hub.SetHistoryCapacity(cfg.Server.BufferSize)
	})

	// Start serial ports from initial config
	serialMgr.Sync(cfgMgr.Get())

	srv := server.New(cfgMgr, hub, serialMgr)

	// Handle OS signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)

	go func() {
		cfg := cfgMgr.Get()
		slog.Info("HTTP server starting", "addr", cfg.Server.Host, "port", cfg.Server.Port)
		if err := srv.Start(); err != nil {
			slog.Error("HTTP server error", "err", err)
		}
	}()

	for sig := range sigCh {
		switch sig {
		case syscall.SIGHUP:
			slog.Info("SIGHUP received, reloading config")
			if err := cfgMgr.Reload(); err != nil {
				slog.Error("config reload failed", "err", err)
			}
		case syscall.SIGINT, syscall.SIGTERM:
			slog.Info("shutdown signal received")
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			srv.Shutdown(ctx)
			serialMgr.StopAll()
			slog.Info("shutdown complete")
			return
		}
	}
}
