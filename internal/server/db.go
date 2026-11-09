//go:build db || oracle || postgres

package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lKhanl/the-grid/internal/db"
)

func clamp(n, def, lo, hi int) int {
	if n == 0 {
		n = def
	}
	return max(lo, min(hi, n))
}

func dbError(w http.ResponseWriter, err error) {
	code := http.StatusBadRequest
	if errors.Is(err, db.ErrBusy) {
		code = http.StatusConflict
	}
	writeError(w, code, err.Error())
}

// DBRoutes is the database module for New.
func DBRoutes(dbm *db.Manager) func(*http.ServeMux) {
	return func(mux *http.ServeMux) { dbRoutes(mux, dbm) }
}

// dbRoutes serves the database panel (/api/db...) and the guarded AI access (/api/ai/db...).
func dbRoutes(mux *http.ServeMux, dbm *db.Manager) {
	view := func(name string) (db.View, bool) {
		for _, v := range dbm.Views() {
			if v.Name == name || equalFold(v.Name, name) {
				return v, true
			}
		}
		return db.View{}, false
	}

	// ---- saved connections ----
	mux.HandleFunc("GET /api/dbconn", func(w http.ResponseWriter, r *http.Request) {
		v := dbm.Views()
		if v == nil {
			v = []db.View{}
		}
		writeJSON(w, http.StatusOK, v)
	})
	save := func(w http.ResponseWriter, r *http.Request, old string) {
		var c db.Conn
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		c, err := dbm.Store.Put(old, c)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if old != "" {
			dbm.Forget(old) // reconnect with the new settings
		}
		v, _ := view(c.Name)
		writeJSON(w, http.StatusOK, v)
	}
	mux.HandleFunc("POST /api/dbconn", func(w http.ResponseWriter, r *http.Request) { save(w, r, "") })
	mux.HandleFunc("PUT /api/dbconn/{name}", func(w http.ResponseWriter, r *http.Request) { save(w, r, r.PathValue("name")) })
	mux.HandleFunc("DELETE /api/dbconn/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		dbm.Forget(name)
		if err := dbm.Store.Delete(name); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	// re-read connections.json after it was edited outside the Grid
	mux.HandleFunc("POST /api/dbconn/reload", func(w http.ResponseWriter, r *http.Request) {
		added, removed, changed, err := dbm.Reload()
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"added": added, "removed": removed, "changed": changed, "total": len(dbm.Store.List())})
	})
	mux.HandleFunc("POST /api/dbconn/test", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			db.Conn
			Existing string `json:"existing"` // edit form: keep the stored password
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		msg, err := dbm.Test(r.Context(), body.Conn, body.Existing)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
	})

	// ---- the SQL session ----
	mux.HandleFunc("POST /api/db/{name}/query", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SQL      string `json:"sql"`
			MaxRows  int    `json:"maxRows"`
			Offset   int    `json:"offset"`
			TimeoutS int    `json:"timeoutSec"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		res, err := dbm.Run(r.Context(), r.PathValue("name"), body.SQL, clamp(body.MaxRows, 500, 1, 10000), clamp(body.Offset, 0, 0, 10000000),
			time.Duration(clamp(body.TimeoutS, 60, 1, 3600))*time.Second)
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	endpoint := func(pattern string, fn func(name string) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if err := fn(r.PathValue("name")); err != nil {
				dbError(w, err)
				return
			}
			v, _ := view(r.PathValue("name"))
			writeJSON(w, http.StatusOK, v)
		})
	}
	endpoint("POST /api/db/{name}/commit", dbm.Commit)
	endpoint("POST /api/db/{name}/rollback", dbm.Rollback)
	endpoint("POST /api/db/{name}/cancel", func(n string) error { dbm.Cancel(n); return nil })
	endpoint("POST /api/db/{name}/disconnect", func(n string) error { dbm.Disconnect(n); return nil })

	// ---- schema browsing: the UI, and AI (the same data, but only for shared connections) ----
	schemaRoutes := func(prefix string, guard func(http.Handler) http.Handler) {
		h := func(pattern string, f http.HandlerFunc) { mux.Handle(pattern, guard(f)) }
		h("GET "+prefix+"/{name}/schemas", func(w http.ResponseWriter, r *http.Request) {
			list, err := dbm.Schemas(r.Context(), r.PathValue("name"), r.URL.Query().Get("all") == "1")
			if err != nil {
				dbError(w, err)
				return
			}
			cur, _ := dbm.CurrentSchema(r.Context(), r.PathValue("name"))
			writeJSON(w, http.StatusOK, map[string]any{"schemas": list, "current": cur})
		})
		h("GET "+prefix+"/{name}/tables", func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			limit, _ := strconv.Atoi(q.Get("limit"))
			list, more, err := dbm.Tables(r.Context(), r.PathValue("name"), q.Get("schema"), q.Get("q"), clamp(limit, 500, 1, 5000))
			if err != nil {
				dbError(w, err)
				return
			}
			if list == nil {
				list = []db.TableRef{}
			}
			writeJSON(w, http.StatusOK, map[string]any{"tables": list, "truncated": more})
		})
		h("GET "+prefix+"/{name}/describe", func(w http.ResponseWriter, r *http.Request) {
			q := r.URL.Query()
			info, err := dbm.Describe(r.Context(), r.PathValue("name"), q.Get("schema"), q.Get("table"))
			if err != nil {
				dbError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, info)
		})
	}
	schemaRoutes("/api/db", func(next http.Handler) http.Handler { return next })
	shared := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if v, ok := view(r.PathValue("name")); !ok || v.MCP == db.MCPOff {
				writeError(w, http.StatusForbidden, "connection is not shared with AI")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	schemaRoutes("/api/ai/db", shared)

	// ---- AI access ----
	mux.HandleFunc("GET /api/ai/db", func(w http.ResponseWriter, r *http.Request) {
		out := []db.View{}
		for _, v := range dbm.Views() {
			if v.MCP != db.MCPOff {
				out = append(out, v)
			}
		}
		writeJSON(w, http.StatusOK, out)
	})
	mux.HandleFunc("POST /api/ai/db/{name}/query", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SQL     string `json:"sql"`
			MaxRows int    `json:"maxRows"`
			Write   bool   `json:"write"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		res, err := dbm.AIQuery(r.Context(), r.PathValue("name"), body.SQL, clamp(body.MaxRows, 100, 1, 500), body.Write)
		if err != nil {
			dbError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
}

func equalFold(a, b string) bool { return strings.EqualFold(a, b) }
