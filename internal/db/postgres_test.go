//go:build db || postgres

package db

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func pgConn() Conn {
	return Conn{Kind: KindPostgres, Host: "h", Database: "app", User: "u"}
}

func TestPostgresNormalize(t *testing.T) {
	c := pgConn()
	c.Name, c.Mode, c.Service = "pg", ModeTNS, "stale"
	if err := c.Normalize(); err != nil || c.Port != 5432 || c.SSLMode != "prefer" || c.Mode != "" || c.Service != "" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	if c.Where() != "h:5432/app" {
		t.Fatalf("where: %q", c.Where())
	}
	for _, bad := range []Conn{
		{Name: "x", Kind: KindPostgres, Host: "h", User: "u"},                                  // no database
		{Name: "x", Kind: KindPostgres, Host: "h", Database: "d", User: "u", SSLMode: "maybe"}, // bad SSL mode
	} {
		if err := bad.Normalize(); err == nil {
			t.Errorf("%+v must be rejected", bad)
		}
	}
}

func TestPostgresDSNQuotesEverything(t *testing.T) {
	c := pgConn()
	c.Port, c.SSLMode, c.Password = 5433, "require", `it's a \ pass word=1`
	cfg, err := pgx.ParseConfig(pgDSN(c))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "h" || cfg.Port != 5433 || cfg.Database != "app" || cfg.User != "u" || cfg.Password != c.Password {
		t.Fatalf("parsed back: %s:%d/%s %s %q", cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password)
	}
}

func TestPostgresMask(t *testing.T) {
	in := `select $$a;b$$, $fn$ x; 'y' $fn$, 'c;d', E'it\'s;', "q;" /* a /* nested; */ still; */ from t where id = $1 -- e;`
	m := maskPG(in)
	if len(m) != len(in) || strings.Contains(m, ";") || !strings.Contains(m, "$1") || !strings.Contains(m, "from t where id") {
		t.Fatalf("masked: %q", m)
	}
	if strings.Contains(maskPG(`select v$x from t; delete from u`), "delete") == false {
		t.Fatal("an identifier with $ is not a dollar quote")
	}
}

func TestPostgresStatementKinds(t *testing.T) {
	d := pgDialect{}
	for sql, want := range map[string][2]bool{ // returnsRows, isRead
		"select 1":                             {true, true},
		"WITH a AS (SELECT 1) SELECT * FROM a": {true, true},
		"with d as (delete from t returning *) select * from d": {true, false},
		"select * into t2 from t":                               {true, false},
		"values (1), (2)":                                       {true, true},
		"show search_path":                                      {true, true},
		"explain select 1":                                      {true, true},
		"explain analyze delete from t":                         {true, false},
		"insert into t values (1) returning id":                 {true, false},
		"insert into t values ('returning')":                    {false, false},
		"update t set a = 1":                                    {false, false},
		"do $$ begin perform 1; end $$":                         {false, false},
	} {
		if got := [2]bool{d.returnsRows(sql), d.isRead(sql)}; got != want {
			t.Errorf("%q: returnsRows, isRead = %v, want %v", sql, got, want)
		}
	}
	for sql, want := range map[string]string{
		"commit": "COMMIT", "END;": "COMMIT", "commit work": "COMMIT", "abort": "ROLLBACK", "rollback transaction": "ROLLBACK",
		"begin": "BEGIN", "BEGIN;": "BEGIN", "start transaction": "BEGIN", "begin isolation level serializable": "BEGIN ISOLATION LEVEL SERIALIZABLE",
		"rollback to savepoint a": "", "commit and chain": "", "select 1": "", "start": "",
	} {
		if got := d.txControl(sql); got != want {
			t.Errorf("txControl(%q) = %q, want %q", sql, got, want)
		}
	}
	for sql, want := range map[string]bool{
		"vacuum t": true, "VACUUM": true, "create database x": true, "create index concurrently i on t (a)": true,
		"alter system set work_mem = '64MB'": true, "create index i on t (a)": false, "alter table t add b int": false,
	} {
		if got := d.noTx(sql); got != want {
			t.Errorf("noTx(%q) = %v", sql, got)
		}
	}
	if d.prepare("select 1;; \n") != "select 1" {
		t.Error("prepare drops the trailing ;")
	}
}

func TestPostgresReadOnlyCheck(t *testing.T) {
	d := pgDialect{}
	for _, s := range []string{"select ';' from t", "select $$;$$", "show all", "explain select * from t", "values (1)", "select 'for update'"} {
		if err := d.checkReadOnly(s); err != nil {
			t.Errorf("%q should pass: %v", s, err)
		}
	}
	for _, s := range []string{"delete from t", "select 1; delete from t", "select * from t for update", "select * from t for share",
		"select * from t for no key update", "with d as (delete from t returning *) select * from d", "select * into t2 from t",
		"explain analyze delete from t", "do $$ begin delete from t; end $$", "begin", "call p()", ""} {
		if err := d.checkReadOnly(s); err == nil {
			t.Errorf("%q must be rejected", s)
		}
	}
	if d.checkSingle("create function f() returns int as $$ select 1; $$ language sql") != nil {
		t.Error("a $$ body may hold ;")
	}
	if d.checkSingle("update t set a = 1; delete from t") == nil {
		t.Error("two statements must be rejected")
	}
}

func TestPostgresStatementSavepoint(t *testing.T) {
	m, f := newTestManager(t, pgConn())
	f.execErr = func(q string) error {
		if strings.Contains(q, "bad") {
			return errors.New(`ERROR: column "bad" does not exist`)
		}
		return nil
	}
	ctx := context.Background()
	run := func(sql string) (*Result, error) { return m.Run(ctx, "t", sql, 10, 0, time.Second) }

	if res, err := run("update t set a = 1"); err != nil || !res.InTx {
		t.Fatalf("DML opens a transaction: %v %+v", err, res)
	}
	if _, err := run("update t set bad = 1"); err == nil {
		t.Fatal("the error must reach the user")
	}
	if res, err := run("create table x (a int)"); err != nil || !res.InTx {
		t.Fatalf("Postgres DDL is transactional, the transaction stays open: %v %+v", err, res)
	}
	if res, err := run("savepoint mine"); err != nil || !res.InTx {
		t.Fatalf("savepoint: %v", err)
	}
	if err := m.Commit("t"); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(f.entries(), "|")
	want := "BEGIN|X: SAVEPOINT grid_stmt|X: update t set a = 1|X: RELEASE SAVEPOINT grid_stmt|" +
		"X: SAVEPOINT grid_stmt|X: update t set bad = 1|X: ROLLBACK TO SAVEPOINT grid_stmt|" +
		"X: SAVEPOINT grid_stmt|X: create table x (a int)|X: RELEASE SAVEPOINT grid_stmt|" +
		"X: savepoint mine|COMMIT"
	if got != want {
		t.Fatalf("log:\n%s\nwant:\n%s", got, want)
	}
}

func TestPostgresTypedBeginAndNoTx(t *testing.T) {
	c := pgConn()
	c.AutoCommit = true
	m, f := newTestManager(t, c)
	ctx := context.Background()
	run := func(sql string) *Result {
		res, err := m.Run(ctx, "t", sql, 10, 0, time.Second)
		if err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return res
	}
	if !run("begin isolation level serializable;").InTx {
		t.Fatal("BEGIN opens a transaction even with auto-commit")
	}
	run("update t set a = 1")
	if run("end").InTx {
		t.Fatal("END commits")
	}
	m2, f2 := newTestManager(t, pgConn()) // auto-commit off
	if res, err := m2.Run(ctx, "t", "vacuum analyze t", 10, 0, time.Second); err != nil || res.InTx {
		t.Fatalf("VACUUM runs outside a transaction: %v %+v", err, res)
	}
	got := strings.Join(f.entries(), "|")
	if !strings.HasPrefix(got, "BEGIN|X: SET TRANSACTION ISOLATION LEVEL SERIALIZABLE|X: SAVEPOINT grid_stmt|X: update t set a = 1|") || !strings.HasSuffix(got, "COMMIT") {
		t.Fatalf("log: %s", got)
	}
	if got := strings.Join(f2.entries(), "|"); got != "X: vacuum analyze t" {
		t.Fatalf("vacuum log: %s", got)
	}
}

func TestPostgresAIReadOnly(t *testing.T) {
	m, f := newTestManager(t, pgConn())
	if _, err := m.AIQuery(context.Background(), "t", "select * from t;", 10, false); err != nil {
		t.Fatal(err)
	}
	if _, err := m.AIQuery(context.Background(), "t", "with d as (delete from t returning *) select * from d", 10, false); err == nil {
		t.Fatal("a data-modifying CTE is not read-only")
	}
	if got := strings.Join(f.entries(), "|"); got != "BEGIN|X: SET TRANSACTION READ ONLY|Q: select * from t|ROLLBACK" {
		t.Fatalf("log: %s", got)
	}
}

func TestPostgresFormatCell(t *testing.T) {
	d := pgDialect{}
	day := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		v         any
		typ, want string
	}{
		{[]byte(`{"a":1}`), "JSONB", `{"a":1}`}, {[]byte(`<a/>`), "XML", `<a/>`}, {[]byte{0xde, 0xad}, "BYTEA", "0xDEAD"},
		{day, "DATE", "2026-01-02"}, {day, "TIMESTAMP", "2026-01-02 00:00:00"}, {int64(7), "INT8", "7"},
	} {
		if got := *d.formatCell(c.v, c.typ); got != c.want {
			t.Errorf("formatCell(%v, %s) = %q, want %q", c.v, c.typ, got, c.want)
		}
	}
	if d.formatCell(nil, "TEXT") != nil {
		t.Error("NULL stays nil")
	}
}
