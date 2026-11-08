//go:build db || oracle || postgres

package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/lKhanl/the-grid/internal/db"
	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/server"
	"github.com/lKhanl/the-grid/internal/state"
)

// Built with -tags db (both drivers), -tags oracle or -tags postgres: the Database panel is included.

func init() {
	runner.Features = append(runner.Features, "db")
	for _, k := range db.Kinds() { // the drivers in this build: db:oracle, db:postgres
		runner.Features = append(runner.Features, "db:"+k)
	}
}

func modules() ([]func(*http.ServeMux), func()) {
	home, err := state.Dir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "warning: no ~/.grid (database connections are kept in the temp folder):", err)
		home = filepath.Join(os.TempDir(), ".grid")
	}
	dbm := db.NewManager(db.OpenStore(home))
	return []func(*http.ServeMux){server.DBRoutes(dbm)}, dbm.Close
}
