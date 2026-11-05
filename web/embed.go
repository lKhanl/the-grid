// Package web holds the built UI (web/dist), embedded into the binary.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
