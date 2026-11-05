package main

import (
	_ "embed"
	"runtime/debug"
	"strings"
)

// VERSION holds the release number; bump it when cutting a release.
//
//go:embed VERSION
var versionFile string

var version = buildVersion()

// buildVersion is VERSION plus the commit it was built from (Go stamps it
// into every build made inside a git checkout, plain `go build` included):
// "0.1.0+414c167", "-dirty" with uncommitted changes. A build from a source
// ZIP has no git, so it is just "0.1.0".
func buildVersion() string {
	v := strings.TrimSpace(versionFile)
	if v == "" {
		v = "dev"
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return v
	}
	var rev string
	var dirty bool
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if len(rev) > 7 {
		rev = rev[:7]
	}
	if rev != "" {
		v += "+" + rev
		if dirty {
			v += "-dirty"
		}
	}
	return v
}
