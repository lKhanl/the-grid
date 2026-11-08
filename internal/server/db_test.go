//go:build db || oracle

package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/lKhanl/the-grid/internal/config"
	"github.com/lKhanl/the-grid/internal/db"
	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/term"
)

func dbServer(t *testing.T) *httptest.Server {
	dbm := db.NewManager(db.OpenStore(t.TempDir()))
	t.Cleanup(dbm.Close)
	h := New(runner.NewManager(config.Empty()), term.NewManager(func() {}), nil, fstest.MapFS{"index.html": {Data: []byte("x")}}, DBRoutes(dbm))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, string) {
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set(CSRFHeader, "test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestDBConnectionsCRUDNeverLeakPasswords(t *testing.T) {
	srv := dbServer(t)
	// like every mutating call, it needs the CSRF header
	req, _ := http.NewRequest("POST", srv.URL+"/api/dbconn", strings.NewReader(`{}`))
	if resp, _ := http.DefaultClient.Do(req); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("without header: %d", resp.StatusCode)
	}
	code, body := call(t, srv, "POST", "/api/dbconn", `{"name":"dev","host":"h","service":"s","user":"u","password":"hunter2"}`)
	if code != 200 || strings.Contains(body, "hunter2") || !strings.Contains(body, `"hasPassword":true`) {
		t.Fatalf("create: %d %s", code, body)
	}
	if code, body = call(t, srv, "GET", "/api/dbconn", ""); code != 200 || strings.Contains(body, "hunter2") {
		t.Fatalf("list must not carry the password: %d %s", code, body)
	}
	if code, _ = call(t, srv, "POST", "/api/dbconn", `{"name":"dev","host":"h","service":"s","user":"u"}`); code != 400 {
		t.Fatalf("duplicate name: %d", code)
	}
	if code, _ = call(t, srv, "PUT", "/api/dbconn/dev", `{"name":"dev","host":"h2","service":"s","user":"u"}`); code != 200 {
		t.Fatalf("edit: %d", code)
	}
	_, body = call(t, srv, "GET", "/api/dbconn", "")
	var list []map[string]any
	json.Unmarshal([]byte(body), &list)
	if len(list) != 1 || list[0]["host"] != "h2" || list[0]["hasPassword"] != true {
		t.Fatalf("an edit without a password keeps the old one: %s", body)
	}
	if code, _ = call(t, srv, "DELETE", "/api/dbconn/dev", ""); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ = call(t, srv, "DELETE", "/api/dbconn/dev", ""); code != 404 {
		t.Fatalf("delete twice: %d", code)
	}
}

func TestDBTestEndpointReportsFailureAsData(t *testing.T) {
	srv := dbServer(t)
	code, body := call(t, srv, "POST", "/api/dbconn/test", `{"name":"x","host":"127.0.0.1","port":1,"service":"s","user":"u","password":"p"}`)
	if code != 200 || !strings.Contains(body, `"ok":false`) || !strings.Contains(body, `"error"`) {
		t.Fatalf("%d %s", code, body)
	}
	if code, body = call(t, srv, "POST", "/api/dbconn/test", `{"name":"x","host":"","service":"s","user":"u"}`); !strings.Contains(body, "host") {
		t.Fatalf("a bad draft explains itself: %d %s", code, body)
	}
}

func TestAIOnlySeesSharedConnections(t *testing.T) {
	srv := dbServer(t)
	call(t, srv, "POST", "/api/dbconn", `{"name":"shared","host":"h","service":"s","user":"u","mcp":"readonly"}`)
	call(t, srv, "POST", "/api/dbconn", `{"name":"private","host":"h","service":"s","user":"u","mcp":"off"}`)
	_, body := call(t, srv, "GET", "/api/ai/db", "")
	if !strings.Contains(body, "shared") || strings.Contains(body, "private") {
		t.Fatalf("AI list: %s", body)
	}
	for _, p := range []string{"/api/ai/db/private/tables", "/api/ai/db/private/describe?table=T", "/api/ai/db/private/schemas"} {
		if code, _ := call(t, srv, "GET", p, ""); code != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", p, code)
		}
	}
	if code, body := call(t, srv, "POST", "/api/ai/db/private/query", `{"sql":"select 1 from dual"}`); code != 400 || !strings.Contains(body, "not shared") {
		t.Fatalf("AI query on a private connection: %d %s", code, body)
	}
	if code, body := call(t, srv, "POST", "/api/ai/db/shared/query", `{"sql":"delete from t"}`); code != 400 || !strings.Contains(body, "only SELECT") {
		t.Fatalf("AI write on a read-only connection: %d %s", code, body)
	}
	if code, body := call(t, srv, "POST", "/api/ai/db/shared/query", `{"sql":"delete from t","write":true}`); code != 400 || !strings.Contains(body, "read-only for AI") {
		t.Fatalf("AI write flag on a read-only connection: %d %s", code, body)
	}
}
