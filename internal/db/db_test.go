//go:build db || oracle

package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- store ----

func TestStorePasswordsAndNames(t *testing.T) {
	dir := t.TempDir()
	s := OpenStore(dir)
	c, err := s.Put("", Conn{Name: "dev", Host: "h", Service: "s", User: "u", Password: "secret"})
	if err != nil || c.Port != 1521 || c.MCP != MCPReadOnly || c.Kind != "oracle" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	if _, err := s.Put("", Conn{Name: "DEV", Host: "h", Service: "s", User: "u"}); err == nil {
		t.Fatal("names are unique, ignoring case")
	}
	// editing with an empty password keeps the stored one; a rename is allowed
	if _, err := s.Put("dev", Conn{Name: "dev2", Host: "h2", Service: "s", User: "u"}); err != nil {
		t.Fatal(err)
	}
	got, ok := s.Get("DEV2")
	if !ok || got.Password != "secret" || got.Host != "h2" {
		t.Fatalf("after edit: %+v", got)
	}
	if _, ok := s.Get("dev"); ok {
		t.Fatal("the old name must be gone")
	}
	if fi, err := os.Stat(filepath.Join(dir, "connections.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("file must be private: %v %v", fi, err)
	}
	if again := OpenStore(dir); len(again.List()) != 1 {
		t.Fatal("not persisted")
	}
	if err := s.Delete("dev2"); err != nil || len(s.List()) != 0 {
		t.Fatalf("delete: %v", err)
	}
	for _, bad := range []Conn{
		{Name: "", Host: "h", Service: "s", User: "u"},
		{Name: "x", Host: "", Service: "s", User: "u"},
		{Name: "x", Mode: ModeSID, Host: "h", User: "u"},
		{Name: "x", Mode: ModeTNS, User: "u"},
		{Name: "x", Host: "h", Service: "s"},
		{Name: "x", Host: "h", Service: "s", User: "u", MCP: "sometimes"},
		{Name: "x", Kind: "mysql", Host: "h", Service: "s", User: "u"},
	} {
		if _, err := s.Put("", bad); err == nil {
			t.Errorf("should be rejected: %+v", bad)
		}
	}
}

func TestViewsNeverCarryPasswords(t *testing.T) {
	m, _ := newTestManager(t, Conn{Password: "secret"})
	v := m.Views()
	if len(v) != 1 || v[0].Password != "" || !v[0].HasPassword {
		t.Fatalf("%+v", v)
	}
}

// ---- connection strings ----

func TestDSN(t *testing.T) {
	u, err := dsn(Conn{Mode: ModeService, Host: "db.example", Port: 1522, Service: "ORCLPDB1", User: "scott", Password: "p@ss/word"})
	if err != nil || !strings.HasPrefix(u, "oracle://scott:") || !strings.Contains(u, "db.example:1522/ORCLPDB1") || strings.Contains(u, "p@ss/word") {
		t.Fatalf("service: %q %v", u, err)
	}
	u, _ = dsn(Conn{Mode: ModeSID, Host: "h", Port: 1521, SID: "XE", User: "u", Password: "p"})
	if !strings.Contains(u, "SID=XE") {
		t.Fatalf("sid: %q", u)
	}
	u, _ = dsn(Conn{Mode: ModeTNS, TNS: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))", User: "u", Password: "p"})
	if !strings.Contains(u, "connStr=") {
		t.Fatalf("tns descriptor: %q", u)
	}
}

func TestTNSNamesAlias(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "tnsnames.ora"), []byte(`
# a comment
PROD, PROD_ALIAS =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = prod.example)(PORT = 1521))   # trailing comment
    (CONNECT_DATA = (SERVICE_NAME = prod.example))
  )

TEST=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=test)(PORT=1521))(CONNECT_DATA=(SID=T1)))
`), 0o644)
	all := parseTNSNames(string(mustRead(t, filepath.Join(dir, "tnsnames.ora"))))
	if len(all) != 3 || !strings.Contains(all["PROD_ALIAS"], "HOST=prod.example") || !strings.Contains(all["TEST"], "SID=T1") {
		t.Fatalf("parsed: %v", all)
	}
	if strings.Contains(all["PROD"], "comment") || strings.Contains(all["PROD"], " ") {
		t.Fatalf("descriptor must be clean: %q", all["PROD"])
	}
	if _, err := dsn(Conn{Mode: ModeTNS, TNS: "prod", TNSAdmin: dir, User: "u", Password: "p"}); err != nil {
		t.Fatalf("alias lookup (case-insensitive): %v", err)
	}
	if _, err := dsn(Conn{Mode: ModeTNS, TNS: "nope", TNSAdmin: dir, User: "u"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing alias: %v", err)
	}
}

func mustRead(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ---- SQL text ----

func TestSQLText(t *testing.T) {
	for sql, want := range map[string]bool{
		"select 1 from dual": true, "  SELECT * FROM t": true, "-- hi\nselect 1": true, "/* c */ WITH a AS (SELECT 1 FROM dual) SELECT * FROM a": true,
		"(select 1 from dual)": true, "update t set a=1": false, "insert into t values (1)": false, "BEGIN null; END;": false, "": false,
	} {
		if got := isQuery(sql); got != want {
			t.Errorf("isQuery(%q) = %v", sql, got)
		}
	}
	for in, want := range map[string]string{
		"select 1 from dual;": "select 1 from dual", "select 1 from dual ;\n": "select 1 from dual", "select 'a;' from dual;": "select 'a;' from dual",
		"BEGIN\n  null;\nEND;": "BEGIN\n  null;\nEND;", "update t set a=1;;": "update t set a=1",
	} {
		if got := prepare(in); got != want {
			t.Errorf("prepare(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadOnlyCheck(t *testing.T) {
	ok := []string{"SELECT * FROM t;", "select ';' from dual", "/* x; y */ select 1 from dual", "-- a; b\nselect 1 from dual", "WITH a AS (SELECT 1 FROM dual) SELECT * FROM a",
		"select 'for update' from dual", `select "FOR UPDATE" from t`}
	for _, s := range ok {
		if err := checkReadOnly(s); err != nil {
			t.Errorf("%q should pass: %v", s, err)
		}
	}
	bad := []string{"DELETE FROM t", "update t set a = 1", "select 1 from dual; delete from t", "SELECT * FROM t FOR UPDATE", "select * from t for  update nowait",
		"BEGIN dbms_output.put_line(1); END;", "drop table t", "truncate table t", "", "   ;", "CALL p()", "merge into t using x on (1=1) when matched then update set a=1"}
	for _, s := range bad {
		if err := checkReadOnly(s); err == nil {
			t.Errorf("%q must be rejected", s)
		}
	}
}

func TestFormatCell(t *testing.T) {
	str := func(p *string) string {
		if p == nil {
			return "<NULL>"
		}
		return *p
	}
	ts := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, c := range []struct {
		v    any
		typ  string
		want string
	}{
		{nil, "", "<NULL>"}, {int64(9007199254740993), "NUMBER", "9007199254740993"}, {1234.5, "NUMBER", "1234.5"}, {1e21, "NUMBER", "1000000000000000000000"},
		{"x", "VARCHAR2", "x"}, {ts, "DATE", "2026-01-02 03:04:05"}, {ts, "TIMESTAMP WITH TIME ZONE", "2026-01-02 03:04:05 +00:00"},
		{[]byte{1, 2, 255}, "RAW", "0x0102FF"}, {true, "", "true"},
	} {
		if got := str(formatCell(c.v, c.typ)); got != c.want {
			t.Errorf("formatCell(%v, %s) = %q, want %q", c.v, c.typ, got, c.want)
		}
	}
}

// ---- the UI session ----

func TestRunQueryTruncates(t *testing.T) {
	m, _ := newTestManager(t, Conn{})
	res, err := m.Run(context.Background(), "t", "select * from t;", 2, 0, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != "rows" || len(res.Rows) != 2 || !res.Truncated || res.Columns[0].Name != "ID" || *res.Rows[0][0] != "1" {
		t.Fatalf("%+v", res)
	}
	res, _ = m.Run(context.Background(), "t", "select * from t", 10, 0, time.Second)
	if res.Truncated || len(res.Rows) != 3 || res.Rows[1][1] != nil {
		t.Fatalf("NULL must stay NULL, no truncation: %+v", res)
	}
}

func TestAutoCommitOffNeedsCommit(t *testing.T) {
	m, f := newTestManager(t, Conn{AutoCommit: false})
	ctx := context.Background()
	// a plain query starts no transaction
	if res, _ := m.Run(ctx, "t", "select 1 from dual", 10, 0, time.Second); res.InTx {
		t.Fatal("SELECT must not open a transaction")
	}
	res, err := m.Run(ctx, "t", "update t set a = 1", 10, 0, time.Second)
	if err != nil || res.Kind != "update" || res.RowsAffected != 3 || !res.InTx {
		t.Fatalf("%+v %v", res, err)
	}
	if v := m.Views(); !v[0].InTx || !v[0].Connected {
		t.Fatalf("view: %+v", v[0])
	}
	if err := m.Commit("t"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.entries(), "|"); !strings.Contains(got, "BEGIN|X: update t set a = 1|COMMIT") {
		t.Fatalf("log: %s", got)
	}
	m.Run(ctx, "t", "delete from t", 10, 0, time.Second)
	if err := m.Rollback("t"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.entries(), "|"); !strings.HasSuffix(got, "X: delete from t|ROLLBACK") {
		t.Fatalf("log: %s", got)
	}
	if v := m.Views(); v[0].InTx {
		t.Fatal("no transaction left")
	}
}

func TestAutoCommitOnRunsDirectly(t *testing.T) {
	m, f := newTestManager(t, Conn{AutoCommit: true})
	res, err := m.Run(context.Background(), "t", "update t set a = 1", 10, 0, time.Second)
	if err != nil || res.InTx {
		t.Fatalf("%+v %v", res, err)
	}
	for _, e := range f.entries() {
		if e == "BEGIN" {
			t.Fatal("auto-commit must not open a transaction")
		}
	}
}

func TestBusyAndCancel(t *testing.T) {
	m, f := newTestManager(t, Conn{})
	f.setBlock(make(chan struct{}), false)
	errc := make(chan error, 1)
	go func() {
		_, err := m.Run(context.Background(), "t", "select slow from dual", 10, 0, time.Minute)
		errc <- err
	}()
	for i := 0; i < 200 && len(f.entries()) == 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := m.Run(context.Background(), "t", "select 2 from dual", 10, 0, time.Second); !errors.Is(err, ErrBusy) {
		t.Fatalf("second statement: %v", err)
	}
	m.Cancel("t")
	select {
	case err := <-errc:
		if err == nil || !strings.Contains(err.Error(), "stopped") {
			t.Fatalf("cancelled run: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not stop the statement")
	}
	// and the session works again afterwards
	f.setBlock(nil, false)
	if _, err := m.Run(context.Background(), "t", "select 3 from dual", 10, 0, time.Second); err != nil {
		t.Fatalf("after cancel: %v", err)
	}
}

func TestTimeout(t *testing.T) {
	m, f := newTestManager(t, Conn{})
	f.setBlock(make(chan struct{}), false)
	if _, err := m.Run(context.Background(), "t", "select slow from dual", 10, 0, 30*time.Millisecond); err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("got %v", err)
	}
}

// ---- AI access ----

func TestAIReadOnly(t *testing.T) {
	m, f := newTestManager(t, Conn{MCP: MCPReadOnly})
	ctx := context.Background()
	res, err := m.AIQuery(ctx, "t", "select * from t", 10, false)
	if err != nil || len(res.Rows) != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	got := strings.Join(f.entries(), "|")
	if !strings.HasPrefix(got, "BEGIN|X: SET TRANSACTION READ ONLY|Q: select * from t|ROLLBACK") {
		t.Fatalf("a read-only transaction must come first and be rolled back: %s", got)
	}
	before := len(f.entries())
	for _, sql := range []string{"delete from t", "select 1 from dual; delete from t", "select * from t for update", "begin null; end;"} {
		if _, err := m.AIQuery(ctx, "t", sql, 10, false); err == nil {
			t.Errorf("%q must be refused", sql)
		}
	}
	for _, e := range f.entries()[before:] {
		if strings.HasPrefix(e, "Q:") || strings.HasPrefix(e, "X:") && !strings.Contains(e, "READ ONLY") {
			t.Errorf("refused statements must never reach the database, saw %q", e)
		}
	}
	if _, err := m.AIQuery(ctx, "t", "update t set a=1", 10, true); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("writes on a read-only connection: %v", err)
	}
}

func TestAIOffAndReadWrite(t *testing.T) {
	m, f := newTestManager(t, Conn{MCP: MCPOff})
	if _, err := m.AIQuery(context.Background(), "t", "select 1 from dual", 10, false); err == nil || !strings.Contains(err.Error(), "not shared") {
		t.Fatalf("off: %v", err)
	}
	// the access level is re-read on every call: no reconnect needed
	c, _ := m.Store.Get("t")
	c.MCP = MCPReadWrite
	if _, err := m.Store.Put("t", c); err != nil {
		t.Fatal(err)
	}
	res, err := m.AIQuery(context.Background(), "t", "update t set a = 1", 10, true)
	if err != nil || res.RowsAffected != 3 {
		t.Fatalf("%+v %v", res, err)
	}
	if got := strings.Join(f.entries(), "|"); !strings.HasSuffix(got, "BEGIN|X: update t set a = 1|COMMIT") {
		t.Fatalf("a write is committed when it succeeds: %s", got)
	}
	if _, err := m.AIQuery(context.Background(), "t", "update a set x=1; delete from b", 10, true); err == nil {
		t.Fatal("several statements at once must be refused")
	}
}

func TestForgetRollsBack(t *testing.T) {
	m, f := newTestManager(t, Conn{AutoCommit: false})
	m.Run(context.Background(), "t", "update t set a = 1", 10, 0, time.Second)
	m.Forget("t")
	if got := strings.Join(f.entries(), "|"); !strings.HasSuffix(got, "ROLLBACK") {
		t.Fatalf("closing a connection with open changes must roll back: %s", got)
	}
	if v := m.Views(); v[0].Connected {
		t.Fatal("must be disconnected")
	}
}

func TestStopAnswersEvenIfTheDriverCannotInterrupt(t *testing.T) {
	m, f := newTestManager(t, Conn{AutoCommit: false})
	ctx := context.Background()
	if _, err := m.Run(ctx, "t", "update t set a = 1", 10, 0, time.Second); err != nil { // an open transaction
		t.Fatal(err)
	}
	stuck := make(chan struct{})
	f.setBlock(stuck, true)
	errc := make(chan error, 1)
	go func() {
		_, err := m.Run(ctx, "t", "select slow from dual", 10, 0, time.Minute)
		errc <- err
	}()
	for i := 0; i < 200 && len(f.entries()) < 3; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	m.Cancel("t")
	select {
	case err := <-errc:
		if err == nil || !strings.Contains(err.Error(), "stopped") || !strings.Contains(err.Error(), "rolled back") {
			t.Fatalf("got %v", err)
		}
		if time.Since(start) > time.Second {
			t.Fatalf("Stop took %s", time.Since(start))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not answer while the driver was stuck")
	}
	// the UI session is usable at once, on a new connection, with no transaction left
	f.setBlock(nil, false)
	res, err := m.Run(ctx, "t", "select 1 from dual", 10, 0, time.Second)
	if err != nil || res.InTx {
		t.Fatalf("after stop: %+v %v", res, err)
	}
	// while the statement is stuck its connection stays out of the pool; when it ends the
	// connection is handed back (no leak). Only the new UI session's connection stays in use.
	inUse := func() int {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.pools["t"].db.Stats().InUse
	}
	if n := inUse(); n != 2 {
		t.Fatalf("stuck + new session = 2 connections in use, got %d", n)
	}
	close(stuck)
	for i := 0; i < 200 && inUse() != 1; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if n := inUse(); n != 1 {
		t.Fatalf("the abandoned connection was never handed back (%d in use)", n)
	}
}

func TestAITimeoutAnswersEvenIfTheDriverCannotInterrupt(t *testing.T) {
	m, f := newTestManager(t, Conn{MCP: MCPReadOnly})
	m.AITimeout = 50 * time.Millisecond
	block := make(chan struct{})
	f.setBlock(block, true)
	start := time.Now()
	_, err := m.AIQuery(context.Background(), "t", "select slow from dual", 10, false)
	if err == nil || !strings.Contains(err.Error(), "timeout") || time.Since(start) > time.Second {
		t.Fatalf("got %v after %s", err, time.Since(start))
	}
	close(block) // lets the stuck goroutine finish and clean up
	for i := 0; i < 200; i++ {
		if strings.Contains(strings.Join(f.entries(), "|"), "ROLLBACK") {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the abandoned AI statement must still be rolled back")
}

func TestTypedCommitRollbackAndDDLEndTheTransaction(t *testing.T) {
	m, f := newTestManager(t, Conn{AutoCommit: false})
	ctx := context.Background()
	run := func(sql string) *Result {
		res, err := m.Run(ctx, "t", sql, 10, 0, time.Second)
		if err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return res
	}
	if !run("update t set a = 1").InTx {
		t.Fatal("DML opens a transaction")
	}
	if res := run("commit;"); res.InTx || res.Kind != "update" {
		t.Fatalf("typed COMMIT: %+v", res)
	}
	run("update t set a = 2")
	if run("  Rollback work ").InTx {
		t.Fatal("typed ROLLBACK")
	}
	run("update t set a = 3")
	if run("create table x (a number)").InTx {
		t.Fatal("DDL commits implicitly")
	}
	got := strings.Join(f.entries(), "|")
	for _, want := range []string{"X: update t set a = 1|COMMIT", "X: update t set a = 2|ROLLBACK", "X: create table x (a number)|COMMIT"} {
		if !strings.Contains(got, want) {
			t.Errorf("log lacks %q:\n%s", want, got)
		}
	}
	// ROLLBACK TO SAVEPOINT is an ordinary statement
	run("update t set a = 4")
	if !run("rollback to savepoint s1").InTx {
		t.Fatal("ROLLBACK TO SAVEPOINT must not end the transaction")
	}
	// a typed COMMIT with nothing open is harmless
	m.Rollback("t")
	if res := run("commit"); res.InTx {
		t.Fatal("nothing to commit")
	}
}

func TestRunQueryPaging(t *testing.T) {
	m, _ := newTestManager(t, Conn{})
	first, err := m.Run(context.Background(), "t", "select * from t;", 1, 0, time.Second)
	if err != nil || len(first.Rows) != 1 {
		t.Fatalf("first page: %v %+v", err, first)
	}
	next, err := m.Run(context.Background(), "t", "select * from t;", 1, 1, time.Second)
	if err != nil || next.Offset != 1 || len(next.Rows) != 1 || *next.Rows[0][0] == *first.Rows[0][0] {
		t.Fatalf("second page: %v %+v", err, next)
	}
	past, err := m.Run(context.Background(), "t", "select * from t;", 5, 1000, time.Second)
	if err != nil || len(past.Rows) != 0 || past.Truncated {
		t.Fatalf("past the end: %v %+v", err, past)
	}
}

func TestStoreReloadSeesOutsideEdits(t *testing.T) {
	dir := t.TempDir()
	s := OpenStore(dir)
	for _, n := range []string{"dev", "test"} {
		if _, err := s.Put("", Conn{Name: n, Host: "h", Service: "s", User: "u"}); err != nil {
			t.Fatal(err)
		}
	}
	// someone else edits the file: dev changes, test goes, qa comes
	other := OpenStore(dir)
	if _, err := other.Put("dev", Conn{Name: "dev", Host: "h2", Service: "s", User: "u"}); err != nil {
		t.Fatal(err)
	}
	other.Delete("test")
	other.Put("", Conn{Name: "qa", Host: "h", Service: "s", User: "u"})

	added, removed, changed, err := s.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(added, ",") != "qa" || strings.Join(removed, ",") != "test" || strings.Join(changed, ",") != "dev" {
		t.Fatalf("added %v removed %v changed %v", added, removed, changed)
	}
	if c, _ := s.Get("dev"); c.Host != "h2" {
		t.Fatalf("dev not reloaded: %+v", c)
	}

	// a broken file is an error and keeps what was loaded
	os.WriteFile(filepath.Join(dir, "connections.json"), []byte("{oops"), 0o600)
	if _, _, _, err := s.Reload(); err == nil {
		t.Fatal("corrupt file accepted")
	}
	if len(s.List()) != 2 {
		t.Fatalf("lost the connections: %v", s.List())
	}
}
