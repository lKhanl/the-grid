package server

import (
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/lKhanl/the-grid/internal/config"
	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/term"
)

type openTermReq struct {
	Shell    string   `json:"shell"`
	Service  string   `json:"service"`
	Runtimes []string `json:"runtimes"`
	Cwd      string   `json:"cwd"`
	Cols     int      `json:"cols"`
	Rows     int      `json:"rows"`
}

// Client -> server control messages on the socket (keystrokes arrive as binary frames).
type termMsg struct {
	Type string `json:"t"` // "r" resize
	Cols int    `json:"c"`
	Rows int    `json:"r"`
}

func termRoutes(mux *http.ServeMux, m *runner.Manager, terms *term.Manager) {
	mux.HandleFunc("GET /api/terms/shells", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, term.Shells())
	})
	mux.HandleFunc("GET /api/terms", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, terms.List())
	})
	mux.HandleFunc("POST /api/terms", func(w http.ResponseWriter, r *http.Request) {
		var req openTermReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		env, cwd, err := m.TermEnv(req.Service, req.Runtimes)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if req.Cwd != "" {
			cwd = config.ResolvePath(m.ConfigDir(), req.Cwd)
		}
		env = setEnv(env, "TERM", "xterm-256color")
		env = setEnv(env, "COLORTERM", "truecolor")
		env = setEnv(env, "TERM_PROGRAM", "the-grid")
		title := req.Service
		s, err := terms.Open(term.Options{
			Shell: req.Shell, Cwd: cwd, Env: env, Title: title, Service: req.Service,
			Runtimes: req.Runtimes, Cols: req.Cols, Rows: req.Rows,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, s.Info())
	})
	mux.HandleFunc("DELETE /api/terms/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !terms.Close(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown terminal")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/terms/{id}/ws", func(w http.ResponseWriter, r *http.Request) {
		s := terms.Get(r.PathValue("id"))
		if s == nil {
			writeError(w, http.StatusNotFound, "unknown terminal")
			return
		}
		// Accept rejects any Origin other than this host: other web pages
		// open in the browser cannot reach the shell (guard already
		// rejected non-loopback Host headers, i.e. DNS rebinding).
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		termSocket(r.Context(), c, s)
	})
}

func termSocket(ctx context.Context, c *websocket.Conn, s *term.Session) {
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	history, ch := s.Attach()
	defer s.Detach(ch)
	if len(history) > 0 {
		if err := c.Write(ctx, websocket.MessageBinary, history); err != nil {
			return
		}
	}

	go func() { // keystrokes and resizes
		defer cancel()
		for {
			typ, b, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				s.Write(b)
				continue
			}
			var msg termMsg
			if json.Unmarshal(b, &msg) == nil && msg.Type == "r" {
				s.Resize(msg.Cols, msg.Rows)
			}
		}
	}()

	if ch == nil { // already exited: history only
		finish(ctx, c, s)
		return
	}
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.Ping(pctx)
			pcancel()
			if err != nil {
				return
			}
		case b, ok := <-ch:
			if !ok {
				finish(ctx, c, s)
				return
			}
			// Coalesce whatever is already queued into one frame.
			closed := false
		drain:
			for len(b) < 256*1024 {
				select {
				case nb, ok := <-ch:
					if !ok {
						closed = true
						break drain
					}
					b = append(b, nb...)
				default:
					break drain
				}
			}
			if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
				return
			}
			if closed {
				finish(ctx, c, s)
				return
			}
		}
	}
}

// finish runs when the output channel closed: either the shell exited (tell
// the client, which keeps showing the screen) or this client fell behind
// (drop it; it reconnects and replays the history).
func finish(ctx context.Context, c *websocket.Conn, s *term.Session) {
	if !s.Info().Exited {
		c.Close(websocket.StatusTryAgainLater, "too slow")
		return
	}
	c.Write(ctx, websocket.MessageText, []byte(`{"t":"exit"}`))
	<-ctx.Done() // the client closes the socket
}

func setEnv(env []string, k, v string) []string {
	prefix := k + "="
	for i, kv := range env {
		if len(kv) >= len(prefix) && equalKey(kv[:len(prefix)], prefix) {
			env[i] = prefix + v
			return env
		}
	}
	return append(env, prefix+v)
}

func equalKey(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
