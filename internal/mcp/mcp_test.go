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

func slowServer(g *httptest.Server) *Server {
	s := New(0, "test")
	s.Base, s.Poll, s.Grace, s.Progress = g.URL, time.Millisecond, time.Millisecond, time.Millisecond
	s.DefaultWait = 30 * time.Millisecond
	return s
}

func TestSlowBuildIsNotAFailure(t *testing.T) {
	g := fakeGrid(t, []string{"running", "building"}) // builds "forever"
	defer g.Close()
	res := run(t, slowServer(g), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"restart","arguments":{"service":"api"}}}`)
	got := text(res[0])
	if !strings.Contains(got, "STILL BUILDING") || !strings.Contains(got, "NOT a failure") || !strings.Contains(got, "wait tool") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "FAILED") || res[0]["result"].(map[string]any)["isError"] == true {
		t.Fatalf("a slow build must not look like an error: %q", got)
	}
}

func TestWaitToolSeesTheServiceComeUp(t *testing.T) {
	// first state call (find) says building, later ones say running
	g := fakeGrid(t, []string{"building", "building", "running"})
	defer g.Close()
	s := slowServer(g)
	s.DefaultWait = 2 * time.Second
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait","arguments":{"service":"api"}}}`)
	if got := text(res[0]); !strings.HasPrefix(got, "api: running") {
		t.Fatalf("got %q", got)
	}
}

func TestProgressNotificationsWhileWaiting(t *testing.T) {
	g := fakeGrid(t, []string{"running", "building"})
	defer g.Close()
	res := run(t, slowServer(g), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"restart","arguments":{"service":"api"},"_meta":{"progressToken":"tok"}}}`)
	n := 0
	for _, m := range res {
		if m["method"] == "notifications/progress" {
			p := m["params"].(map[string]any)
			if p["progressToken"] != "tok" || !strings.Contains(p["message"].(string), "building") {
				t.Fatalf("bad progress %v", p)
			}
			n++
		}
	}
	if n == 0 {
		t.Fatal("no progress notification was sent")
	}
	// without a token nothing extra is sent
	res = run(t, slowServer(g), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"restart","arguments":{"service":"api"}}}`)
	if len(res) != 1 {
		t.Fatalf("want just the answer, got %d messages", len(res))
	}
}

func TestStatusShowsHowLongItIsBuilding(t *testing.T) {
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"services": []map[string]any{
			{"name": "api", "status": "building", "startedAt": time.Now().Add(-95 * time.Second).UnixMilli()}}})
	}))
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}`)
	if got := text(res[0]); !strings.Contains(got, "api: building (for 95s)") && !strings.Contains(got, "api: building (for 96s)") {
		t.Fatalf("got %q", got)
	}
}
