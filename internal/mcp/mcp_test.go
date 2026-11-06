package mcp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeGrid serves one service whose state follows `states` on every /api/state call.
func fakeGrid(t *testing.T, states []string) *httptest.Server {
	calls := 0
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/state":
			st := states[min(calls, len(states)-1)]
			calls++
			start := int64(1)
			if calls > 1 {
				start = 2 // restarted
			}
			json.NewEncoder(w).Encode(map[string]any{"services": []map[string]any{{"name": "api", "status": st, "startedAt": start}}})
		case strings.HasPrefix(r.URL.Path, "/api/do/api/"):
			w.Write([]byte(`{"ok":true}`))
		case strings.HasSuffix(r.URL.Path, "/logs"):
			w.Write([]byte("line one\nline two\n"))
		default:
			http.NotFound(w, r)
		}
	}))
}

func run(t *testing.T, s *Server, reqs ...string) []map[string]any {
	var out bytes.Buffer
	if err := s.Serve(strings.NewReader(strings.Join(reqs, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	var res []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("bad line %q: %v", l, err)
		}
		res = append(res, m)
	}
	return res
}

func text(m map[string]any) string {
	return m["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
}

func TestRestartReportsCrash(t *testing.T) {
	g := fakeGrid(t, []string{"running", "starting", "crashed"})
	defer g.Close()
	s := New(0, "test")
	s.Base, s.Poll, s.Grace = g.URL, time.Millisecond, time.Millisecond
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"restart","arguments":{"service":"api"}}}`)
	got := text(res[0])
	if !strings.Contains(got, "FAILED") || !strings.Contains(got, "line two") {
		t.Fatalf("got %q", got)
	}
}

func TestRestartReportsRunning(t *testing.T) {
	g := fakeGrid(t, []string{"running", "starting", "running"})
	defer g.Close()
	s := New(0, "test")
	s.Base, s.Poll, s.Grace = g.URL, time.Millisecond, time.Millisecond
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"restart","arguments":{"service":"api"}}}`)
	if got := text(res[0]); !strings.HasPrefix(got, "api: running") {
		t.Fatalf("got %q", got)
	}
}

func TestProtocolBasics(t *testing.T) {
	g := fakeGrid(t, []string{"running"})
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	res := run(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"logs","arguments":{"service":"missing"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"nope"}`)
	if len(res) != 3 { // the notification gets no answer
		t.Fatalf("want 3 answers, got %d", len(res))
	}
	for _, m := range res {
		switch m["id"].(float64) {
		case 2:
			if m["result"].(map[string]any)["isError"] != true {
				t.Fatal("unknown service should be a tool error")
			}
		case 3:
			if m["error"] == nil {
				t.Fatal("unknown method should be an rpc error")
			}
		}
	}
}
