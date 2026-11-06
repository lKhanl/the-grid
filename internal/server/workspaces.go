package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/state"
)

// workspaceRoutes: the recent-workspaces list and switching between them.
// store may be nil (no usable ~/.grid); recents are then simply empty.
func workspaceRoutes(mux *http.ServeMux, m *runner.Manager, store *state.Store) {
	mux.HandleFunc("GET /api/workspaces", func(w http.ResponseWriter, r *http.Request) {
		out := struct {
			Current    string            `json:"current"`
			Workspaces []state.Workspace `json:"workspaces"`
		}{Current: m.ConfigPath(), Workspaces: []state.Workspace{}}
		if store != nil {
			out.Workspaces = store.Recent()
		}
		writeJSON(w, http.StatusOK, out)
	})
	// Open (switch to) a grid.yaml. Stops the current workspace's services.
	mux.HandleFunc("POST /api/workspaces/open", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
			writeError(w, http.StatusBadRequest, "path required")
			return
		}
		path, err := filepath.Abs(body.Path)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if fi, err := os.Stat(path); err == nil && fi.IsDir() { // a folder means its grid.yaml
			path = filepath.Join(path, "grid.yaml")
		}
		if err := m.Switch(path); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if store != nil {
			store.Touch(m.ConfigPath(), m.State().Name)
		}
		writeJSON(w, http.StatusOK, m.State())
	})
	// Forget a workspace (the file itself is untouched).
	mux.HandleFunc("DELETE /api/workspaces", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		if p == "" || p == m.ConfigPath() {
			writeError(w, http.StatusBadRequest, "cannot forget the open workspace")
			return
		}
		if store != nil {
			store.Remove(p)
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
}
