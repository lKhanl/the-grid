//go:build db || oracle || postgres

package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func dbGrid(t *testing.T, lastBody *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/ai/db":
			w.Write([]byte(`[{"name":"dev","kind":"oracle","mode":"service","host":"db1","port":1521,"service":"PDB1","user":"scott","mcp":"readonly"},
			                 {"name":"test","kind":"oracle","mode":"sid","host":"db2","port":1521,"sid":"XE","user":"hr","mcp":"readwrite"}]`))
		case strings.HasSuffix(r.URL.Path, "/tables"):
			w.Write([]byte(`{"tables":[{"schema":"HR","name":"EMPLOYEES","type":"TABLE","comment":"people\nwho work"},{"schema":"HR","name":"EMP_VIEW","type":"VIEW"}],"truncated":true}`))
		case strings.HasSuffix(r.URL.Path, "/describe"):
			if r.URL.Query().Get("table") == "NOPE" {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":"table or view HR.NOPE not found (or no access)"}`))
				return
			}
			w.Write([]byte(`{"schema":"HR","name":"EMPLOYEES","type":"TABLE","comment":"people",
			 "columns":[{"name":"ID","type":"NUMBER(6)","nullable":false,"pk":true},{"name":"NAME","type":"VARCHAR2(40)","nullable":true,"comment":"full name"}],
			 "primaryKey":["ID"],"unique":[{"name":"EMP_U","columns":["NAME"]}],
			 "foreignKeys":[{"name":"EMP_DEPT_FK","columns":["DEPT_ID"],"ref":"HR.DEPARTMENTS(ID)"}],
			 "indexes":[{"name":"EMP_PK","unique":true,"columns":["ID"]}]}`))
		case strings.HasSuffix(r.URL.Path, "/query"):
			b, _ := io.ReadAll(r.Body)
			*lastBody = string(b)
			var req struct {
				SQL   string
				Write bool
			}
			json.Unmarshal(b, &req)
			switch {
			case strings.Contains(req.SQL, "update"):
				w.Write([]byte(`{"kind":"update","rowsAffected":2,"ms":5}`))
			case strings.Contains(req.SQL, "none"):
				w.Write([]byte(`{"kind":"rows","columns":[{"name":"ID","type":"NUMBER"}],"ms":3}`))
			case strings.Contains(req.SQL, "big"):
				rows := `[` + strings.Repeat(`["`+strings.Repeat("x", 100)+`",null],`, 300) + `["y","z"]]`
				w.Write([]byte(`{"kind":"rows","columns":[{"name":"A","type":"VARCHAR2"},{"name":"B","type":"VARCHAR2"}],"rows":` + rows + `,"truncated":true,"ms":9}`))
			default:
				w.Write([]byte(`{"kind":"rows","columns":[{"name":"ID","type":"NUMBER"},{"name":"NAME","type":"VARCHAR2"}],"rows":[["1","Ann"],["2",null]],"ms":7}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
}

func dbServerFor(g *httptest.Server) *Server {
	s := New(0, "test")
	s.Base = g.URL
	return s
}

func TestDBListTablesDescribe(t *testing.T) {
	var body string
	g := dbGrid(t, &body)
	defer g.Close()
	s := dbServerFor(g)
	got := callTool(t, s, "db_list", `{}`)
	if !strings.Contains(got, "dev: oracle db1:1521/PDB1 as scott, read-only") || !strings.Contains(got, "test: oracle db2:1521 SID XE as hr, read & write") {
		t.Fatalf("db_list:\n%s", got)
	}
	got = callTool(t, s, "db_tables", `{"connection":"dev","search":"emp"}`)
	if !strings.Contains(got, "HR.EMPLOYEES (table) - people who work") || !strings.Contains(got, "HR.EMP_VIEW (view)") || !strings.Contains(got, "narrow the search") {
		t.Fatalf("db_tables:\n%s", got)
	}
	got = callTool(t, s, "db_describe", `{"connection":"dev","table":"employees"}`)
	for _, want := range []string{"HR.EMPLOYEES (table) - people", "ID NUMBER(6) NOT NULL PK", "NAME VARCHAR2(40) - full name",
		"unique EMP_U: (NAME)", "foreign key EMP_DEPT_FK: (DEPT_ID) -> HR.DEPARTMENTS(ID)", "index EMP_PK unique: (ID)"} {
		if !strings.Contains(got, want) {
			t.Errorf("db_describe lacks %q:\n%s", want, got)
		}
	}
	res := run(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"db_describe","arguments":{"connection":"dev","table":"NOPE"}}}`)
	if res[0]["result"].(map[string]any)["isError"] != true || !strings.Contains(text(res[0]), "not found") {
		t.Fatalf("a missing table is a clear tool error: %v", res[0])
	}
}

func TestDBQueryRendering(t *testing.T) {
	var body string
	g := dbGrid(t, &body)
	defer g.Close()
	s := dbServerFor(g)
	got := callTool(t, s, "db_query", `{"connection":"dev","sql":"select * from t","max_rows":5}`)
	if got != "ID | NAME\n1 | Ann\n2 | NULL\n2 rows (7 ms)." {
		t.Fatalf("rows:\n%q", got)
	}
	if !strings.Contains(body, `"write":false`) || !strings.Contains(body, `"maxRows":5`) {
		t.Fatalf("db_query must ask for a read-only run: %s", body)
	}
	if got := callTool(t, s, "db_query", `{"connection":"dev","sql":"select none"}`); !strings.HasPrefix(got, "0 rows") || !strings.Contains(got, "ID") {
		t.Fatalf("empty result: %q", got)
	}
	got = callTool(t, s, "db_query", `{"connection":"dev","sql":"select big"}`)
	if len(got) > maxDBText+200 || !strings.Contains(got, "fit; select fewer columns") || strings.Contains(got, strings.Repeat("x", 130)) {
		t.Fatalf("a big result must be cut (%d chars), cells shortened:\n%.300s", len(got), got)
	}
	got = callTool(t, s, "db_execute", `{"connection":"test","sql":"update t set a=1"}`)
	if got != "2 rows affected, committed (5 ms)." || !strings.Contains(body, `"write":true`) {
		t.Fatalf("db_execute: %q body %s", got, body)
	}
}

func TestOneLine(t *testing.T) {
	if got := oneLine("a\n  b\t c", 50); got != "a b c" {
		t.Fatal(got)
	}
	if got := oneLine("äöüäöü", 3); got != "äöü..." {
		t.Fatalf("must cut on characters, not bytes: %q", got)
	}
}

func TestDBToolsAreListed(t *testing.T) {
	g := dbGrid(t, new(string))
	defer g.Close()
	res := run(t, dbServerFor(g), `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	names := map[string]bool{}
	for _, tl := range res[0]["result"].(map[string]any)["tools"].([]any) {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	for _, n := range []string{"status", "logs", "restart", "wait", "describe", "db_list", "db_tables", "db_describe", "db_query", "db_execute"} {
		if !names[n] {
			t.Errorf("tool %s missing", n)
		}
	}
}
