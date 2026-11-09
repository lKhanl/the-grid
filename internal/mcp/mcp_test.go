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

const sampleLog = `2026-01-01 INFO  starting up
2026-01-01 INFO  listening on 8080
2026-01-01 ERROR request failed
java.lang.IllegalStateException: boom
	at demo.A.run(A.java:1)
	at demo.B.run(B.java:2)
2026-01-01 INFO  retrying
2026-01-01 WARN  slow response
2026-01-01 INFO  done
`

// logGrid serves a fixed log and remembers the last query of the logs endpoint.
func logGrid(t *testing.T, lastQuery *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/state":
			json.NewEncoder(w).Encode(map[string]any{"services": []map[string]any{{
				"name": "api", "status": "running", "type": "spring-boot", "group": "backend", "cwd": "/work/api",
				"command": "java -jar target/api.jar", "build": "mvn package", "url": "http://localhost:8081",
				"ready": "port 8081", "dependsOn": []string{"db"}, "pid": 42}}})
		case strings.HasPrefix(r.URL.Path, "/api/do/"):
			w.Write([]byte(`{"ok":true}`))
		case strings.HasSuffix(r.URL.Path, "/logs"):
			*lastQuery = r.URL.RawQuery
			w.Write([]byte(sampleLog))
		default:
			http.NotFound(w, r)
		}
	}))
}

func callTool(t *testing.T, s *Server, name, args string) string {
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"`+name+`","arguments":`+args+`}}`)
	return text(res[0])
}

func TestLogsLevelErrorWithContext(t *testing.T) {
	var q string
	g := logGrid(t, &q)
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	got := callTool(t, s, "logs", `{"service":"api","level":"error","context":3}`)
	for _, want := range []string{"2 matching lines", "request failed", "IllegalStateException", "A.java:1", "B.java:2"} {
		if !strings.Contains(got, want) {
			t.Errorf("answer lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "listening on") || strings.Contains(got, "slow response") {
		t.Errorf("unrelated lines leaked in:\n%s", got)
	}
	// level=warn adds the warning
	if got := callTool(t, s, "logs", `{"service":"api","level":"warn"}`); !strings.Contains(got, "slow response") {
		t.Errorf("warn level should include warnings:\n%s", got)
	}
}

func TestLogsGrepAndErrors(t *testing.T) {
	var q string
	g := logGrid(t, &q)
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	if got := callTool(t, s, "logs", `{"service":"api","grep":"LISTENING on \\d+"}`); !strings.Contains(got, "1 matching lines") || !strings.Contains(got, "listening on 8080") {
		t.Errorf("case-insensitive grep failed:\n%s", got)
	}
	if got := callTool(t, s, "logs", `{"service":"api","grep":"nothing like this"}`); !strings.HasPrefix(got, "No matching lines") {
		t.Errorf("got %q", got)
	}
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"logs","arguments":{"service":"api","grep":"("}}}`)
	if res[0]["result"].(map[string]any)["isError"] != true || !strings.Contains(text(res[0]), "regular expression") {
		t.Errorf("a bad regex must be a clear tool error: %v", res[0])
	}
	res = run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"logs","arguments":{"service":"api","level":"loud"}}}`)
	if res[0]["result"].(map[string]any)["isError"] != true {
		t.Error("unknown level must be an error")
	}
}

func TestLogsSinceRestartAsksTheGrid(t *testing.T) {
	var q string
	g := logGrid(t, &q)
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	callTool(t, s, "logs", `{"service":"api","since_restart":true}`)
	if !strings.Contains(q, "since=start") {
		t.Fatalf("query %q", q)
	}
	callTool(t, s, "logs", `{"service":"api"}`)
	if strings.Contains(q, "since=") {
		t.Fatalf("plain logs must not ask for since: %q", q)
	}
	// restart / wait report only what the latest start produced
	callTool(t, slowRestart(g), "restart", `{"service":"api"}`)
	if !strings.Contains(q, "since=start") {
		t.Fatalf("restart must show the log since the start: %q", q)
	}
}

func slowRestart(g *httptest.Server) *Server {
	s := New(0, "test")
	s.Base, s.Poll, s.Grace = g.URL, time.Millisecond, time.Millisecond
	s.DefaultWait = 50 * time.Millisecond
	return s
}

func TestDescribe(t *testing.T) {
	var q string
	g := logGrid(t, &q)
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	got := callTool(t, s, "describe", `{"service":"api"}`)
	for _, want := range []string{"api: running", "folder: /work/api", "build: mvn package", "run: java -jar target/api.jar",
		"url: http://localhost:8081", "ready when: port 8081", "depends on: db", "group: backend"} {
		if !strings.Contains(got, want) {
			t.Errorf("describe lacks %q:\n%s", want, got)
		}
	}
}

func TestFilterLinesSeparatorsOnlyWithContext(t *testing.T) {
	lines := []string{"a err", "b", "c", "d err", "e"}
	isErr := func(l string) bool { return strings.Contains(l, "err") }
	if out, n := filterLines(lines, isErr, 0, 10); n != 2 || strings.Join(out, "|") != "a err|d err" {
		t.Fatalf("no context: %v %d", out, n)
	}
	if out, _ := filterLines(lines, isErr, 1, 10); strings.Join(out, "|") != "a err|b|--|d err|e" {
		t.Fatalf("context 1: %v", out)
	}
	if out, _ := filterLines(lines, isErr, 1, 2); out[0] == "--" {
		t.Fatalf("must not start with a separator: %v", out)
	}
}

func TestReloadReportsWhatChanged(t *testing.T) {
	reloaded := false
	g := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/reload":
			reloaded = true
			json.NewEncoder(w).Encode(map[string]any{
				"services": []map[string]any{{"name": "api"}, {"name": "web"}},
				"runtimes": []map[string]any{{"name": "java-21"}, {"name": "node-9", "error": "home not found"}},
			})
		case r.URL.Path == "/api/state":
			json.NewEncoder(w).Encode(map[string]any{"services": []map[string]any{{"name": "api"}, {"name": "old"}}})
		default: // a Grid built without the database module
			http.NotFound(w, r)
		}
	}))
	defer g.Close()
	s := New(0, "test")
	s.Base = g.URL
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"reload","arguments":{}}}`)
	got := text(res[0])
	for _, want := range []string{"2 services, 2 runtimes", "added: web", "removed (stopped): old", "runtime node-9: home not found"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	if !reloaded {
		t.Fatal("did not ask the Grid to reload")
	}
}
