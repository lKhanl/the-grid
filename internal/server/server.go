// Package server exposes the manager over HTTP: a JSON/SSE API and the embedded UI.
package server

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/lKhanl/the-grid/internal/config"
	"github.com/lKhanl/the-grid/internal/detect"
	"github.com/lKhanl/the-grid/internal/runner"
)

func isActive(s runner.Status) bool {
	return s == runner.Starting || s == runner.Building || s == runner.Running || s == runner.Stopping
}

// CSRFHeader must be present on every mutating request. Browsers cannot add
// custom headers cross-origin without a CORS preflight (which we never
// answer), so random web pages cannot start/stop services.
const CSRFHeader = "X-Grid"

func New(m *runner.Manager, ui fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.State())
	})
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) { events(m, w, r) })
	mux.HandleFunc("GET /api/services/{name}/logs", func(w http.ResponseWriter, r *http.Request) {
		s := m.Get(r.PathValue("name"))
		if s == nil {
			writeError(w, http.StatusNotFound, "unknown service")
			return
		}
		n, _ := strconv.Atoi(r.URL.Query().Get("tail"))
		if n == 0 {
			n = 200
		}
		entries := s.Logs(n)
		if r.URL.Query().Get("format") == "json" {
			writeJSON(w, http.StatusOK, entries)
			return
		}
		raw := r.URL.Query().Get("raw") == "1"
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		var b strings.Builder
		for _, e := range entries {
			line := e.Line
			if !raw {
				line = runner.StripANSI(line)
			}
			if e.Stream == "sys" {
				line = "[grid] " + line
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
		w.Write([]byte(b.String()))
	})
	mux.HandleFunc("POST /api/do/{target}/{action}", func(w http.ResponseWriter, r *http.Request) {
		if err := m.Do(r.PathValue("target"), r.PathValue("action")); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/reload", func(w http.ResponseWriter, r *http.Request) {
		if err := m.Reload(); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, m.State())
	})
	// --- editing grid.yaml ---
	mux.HandleFunc("GET /api/config/services/{name}", func(w http.ResponseWriter, r *http.Request) {
		spec, err := config.ReadSpec(m.ConfigPath(), r.PathValue("name"))
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, spec)
	})
	save := func(w http.ResponseWriter, r *http.Request, oldName string) {
		var spec config.ServiceSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			writeError(w, http.StatusBadRequest, "bad JSON: "+err.Error())
			return
		}
		spec.Name = strings.TrimSpace(spec.Name)
		if oldName != "" && spec.Name != oldName {
			if s := m.Get(oldName); s != nil && isActive(s.Info().Status) {
				writeError(w, http.StatusConflict, "stop "+oldName+" before renaming it")
				return
			}
		}
		if err := config.SaveService(m.ConfigPath(), oldName, spec); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := m.Reload(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, m.State())
	}
	mux.HandleFunc("POST /api/config/services", func(w http.ResponseWriter, r *http.Request) { save(w, r, "") })
	mux.HandleFunc("PUT /api/config/services/{name}", func(w http.ResponseWriter, r *http.Request) {
		save(w, r, r.PathValue("name"))
	})
	mux.HandleFunc("DELETE /api/config/services/{name}", func(w http.ResponseWriter, r *http.Request) {
		if err := config.DeleteService(m.ConfigPath(), r.PathValue("name")); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := m.Reload(); err != nil { // stops the removed service
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, m.State())
	})
	mux.HandleFunc("PUT /api/config/order", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Services []string `json:"services"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "bad JSON: "+err.Error())
			return
		}
		if err := config.ReorderServices(m.ConfigPath(), body.Services); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := m.Reload(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	// --- runtimes ---
	mux.HandleFunc("GET /api/config/runtimes/{name}", func(w http.ResponseWriter, r *http.Request) {
		spec, err := config.ReadRuntime(m.ConfigPath(), r.PathValue("name"))
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, spec)
	})
	saveRuntime := func(w http.ResponseWriter, r *http.Request, oldName string) {
		var spec config.RuntimeSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			writeError(w, http.StatusBadRequest, "bad JSON: "+err.Error())
			return
		}
		if err := config.SaveRuntime(m.ConfigPath(), oldName, spec); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := m.Reload(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, m.State())
	}
	mux.HandleFunc("POST /api/config/runtimes", func(w http.ResponseWriter, r *http.Request) { saveRuntime(w, r, "") })
	mux.HandleFunc("PUT /api/config/runtimes/{name}", func(w http.ResponseWriter, r *http.Request) {
		saveRuntime(w, r, r.PathValue("name"))
	})
	mux.HandleFunc("DELETE /api/config/runtimes/{name}", func(w http.ResponseWriter, r *http.Request) {
		if err := config.DeleteRuntime(m.ConfigPath(), r.PathValue("name"), r.URL.Query().Get("detach") == "1"); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := m.Reload(); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, m.State())
	})
	// Checks a runtime folder and reports the real version (java -version, node --version).
	mux.HandleFunc("GET /api/runtimes/probe", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		writeJSON(w, http.StatusOK, config.ProbeRuntime(m.ConfigDir(), q.Get("type"), q.Get("home"), q.Get("bin")))
	})
	// Lets the form show whether a working directory / file exists.
	mux.HandleFunc("GET /api/fs/check", func(w http.ResponseWriter, r *http.Request) {
		p := config.ResolvePath(m.ConfigDir(), strings.TrimSpace(r.URL.Query().Get("path")))
		st, err := os.Stat(p)
		writeJSON(w, http.StatusOK, map[string]any{"path": p, "exists": err == nil, "dir": err == nil && st.IsDir()})
	})
	// --- project detection (IntelliJ-style run configuration) ---
	mux.HandleFunc("GET /api/detect", func(w http.ResponseWriter, r *http.Request) {
		dir := config.ResolvePath(m.ConfigDir(), strings.TrimSpace(r.URL.Query().Get("dir")))
		writeJSON(w, http.StatusOK, detect.Dir(dir))
	})
	mux.HandleFunc("GET /api/fs/list", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimSpace(r.URL.Query().Get("path"))
		dir := m.ConfigDir()
		if p != "" {
			dir = config.ResolvePath(m.ConfigDir(), p)
		}
		writeJSON(w, http.StatusOK, detect.List(dir))
	})
	mux.HandleFunc("POST /api/preview", func(w http.ResponseWriter, r *http.Request) {
		var spec config.ServiceSpec
		if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
			writeError(w, http.StatusBadRequest, "bad JSON: "+err.Error())
			return
		}
		build, run, err := config.PreviewSpec(m.ConfigDir(), spec)
		res := map[string]string{"build": build, "run": run}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(w, http.StatusOK, res)
	})
	mux.Handle("/", http.FileServerFS(ui))
	return guard(mux)
}

func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		// Blocks DNS-rebinding: only loopback host names are served.
		if host != "localhost" && host != "127.0.0.1" && host != "::1" && host != "[::1]" {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get(CSRFHeader) == "" {
			http.Error(w, "missing "+CSRFHeader+" header", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func events(m *runner.Manager, w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := m.Hub.Subscribe() // subscribe before the snapshot so nothing is missed
	defer m.Hub.Unsubscribe(ch)

	// The first snapshot carries every service's log history: one stream
	// instead of one request per service (browsers allow only 6 connections
	// per host, shared by all tabs, and each tab already holds this stream).
	st := m.State()
	logs := map[string][]runner.Entry{}
	for _, s := range m.Services() {
		logs[s.Name()] = s.Logs(10000)
	}
	writeEvent(w, runner.Event{Type: "snapshot", State: &st, Logs: logs})
	fl.Flush()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			w.Write([]byte(": ping\n\n"))
			fl.Flush()
		case e, ok := <-ch:
			if !ok {
				return // too slow, client will reconnect
			}
			writeEvent(w, e)
			// Batch whatever is already queued before flushing.
		drain:
			for i := 0; i < 512; i++ {
				select {
				case e, ok := <-ch:
					if !ok {
						fl.Flush()
						return
					}
					writeEvent(w, e)
				default:
					break drain
				}
			}
			fl.Flush()
		}
	}
}

func writeEvent(w http.ResponseWriter, e runner.Event) {
	b, _ := json.Marshal(e)
	w.Write([]byte("data: "))
	w.Write(b)
	w.Write([]byte("\n\n"))
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
