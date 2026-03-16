// Package web embeds the static web UI into the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticFiles embed.FS

// Static is the sub-filesystem rooted at web/static, served at /.
var Static, _ = fs.Sub(staticFiles, "static")
