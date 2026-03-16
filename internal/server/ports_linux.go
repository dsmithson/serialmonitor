//go:build linux

package server

import (
	"os"
	"path/filepath"
	"strings"
)

func listAvailablePorts() ([]string, error) {
	matches, err := filepath.Glob("/dev/tty[A-Z]*")
	if err != nil {
		return nil, err
	}

	var ports []string
	for _, m := range matches {
		if strings.HasPrefix(filepath.Base(m), "ttyS") ||
			strings.HasPrefix(filepath.Base(m), "ttyUSB") ||
			strings.HasPrefix(filepath.Base(m), "ttyACM") ||
			strings.HasPrefix(filepath.Base(m), "ttyAMA") {
			if _, err := os.Stat(m); err == nil {
				ports = append(ports, m)
			}
		}
	}
	return ports, nil
}
