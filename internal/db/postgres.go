//go:build db || postgres

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// pgDialect: PostgreSQL through pgx (pure Go).
type pgDialect struct{}

func init() { dialects[KindPostgres] = pgDialect{} }

var sslModes = []string{"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}

func (pgDialect) normalize(c *Conn) error {
	c.Mode, c.Service, c.SID, c.TNS, c.TNSAdmin = "", "", "", "", ""
	c.Database = strings.TrimSpace(c.Database)
	if c.Host == "" || c.Database == "" {
		return errors.New("host and database are required")
	}
	if c.Port == 0 {
		c.Port = 5432
	}
	if c.SSLMode == "" {
		c.SSLMode = "prefer"
	}
	for _, m := range sslModes {
		if c.SSLMode == m {
			return nil
		}
	}
	return fmt.Errorf("SSL mode %q: use %s", c.SSLMode, strings.Join(sslModes, ", "))
}

// pgDSN is a keyword=value connection string; every value is quoted, so passwords may hold anything.
func pgDSN(c Conn) string {
	q := func(s string) string { return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'" }
	parts := []string{
		"host=" + q(c.Host), "port=" + strconv.Itoa(c.Port), "dbname=" + q(c.Database), "user=" + q(c.User),
		"sslmode=" + q(c.SSLMode), "application_name='The Grid'", "connect_timeout=15",
	}
	if c.Password != "" {
		parts = append(parts, "password="+q(c.Password))
	}
	return strings.Join(parts, " ")
}

func (pgDialect) open(c Conn) (*sql.DB, error) {
	cfg, err := pgx.ParseConfig(pgDSN(c))
	if err != nil {
		return nil, err
	}
	// one statement per round trip, nothing prepared and cached: the SQL comes from an editor
	cfg.DefaultQueryExecMode = pgx.QueryExecModeExec
	d := stdlib.OpenDB(*cfg)
	d.SetMaxOpenConns(8)
	d.SetConnMaxIdleTime(5 * time.Minute)
	return d, nil
}

func (pgDialect) hello(ctx context.Context, d *sql.DB) (string, error) {
	var who, version string
	if err := d.QueryRowContext(ctx, `SELECT current_user, current_setting('server_version')`).Scan(&who, &version); err != nil {
		return "", err
	}
	return "Connected as " + who + " (PostgreSQL " + version + ")", nil
}

// ---- SQL text ----

func (pgDialect) prepare(sql string) string {
	return strings.TrimSpace(strings.TrimRight(strings.TrimSpace(sql), "; \t\r\n"))
}

// pgWords are the upper-case words of a masked statement (punctuation splits words).
func pgWords(masked string) []string {
	return strings.FieldsFunc(strings.ToUpper(masked), func(r rune) bool {
		return !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '$')
	})
}

func hasWord(words []string, w ...string) bool {
	for _, x := range words {
		for _, y := range w {
			if x == y {
				return true
			}
		}
	}
	return false
}

func (pgDialect) returnsRows(sql string) bool {
	m := maskPG(sql)
	switch firstWord(m) {
	case "SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN", "FETCH":
		return true
	case "INSERT", "UPDATE", "DELETE", "MERGE":
		return hasWord(pgWords(m), "RETURNING")
	}
	return false
}

func (pgDialect) isRead(sql string) bool { return pgRead(maskPG(sql)) }

func pgRead(masked string) bool {
	w := pgWords(masked)
	switch firstWord(masked) {
	case "SELECT":
		return !hasWord(w, "INTO") // SELECT ... INTO creates a table
	case "VALUES", "TABLE", "SHOW":
		return true
	case "EXPLAIN":
		return !hasWord(w, "ANALYZE", "ANALYSE") // EXPLAIN ANALYZE runs the statement
	case "WITH":
		return !hasWord(w, "INSERT", "UPDATE", "DELETE", "MERGE", "INTO") // data-modifying CTEs
	}
	return false
}

// txControl: COMMIT / END, ROLLBACK / ABORT (not ROLLBACK TO SAVEPOINT), and BEGIN / START
// TRANSACTION, returned as "BEGIN" plus its options (e.g. "BEGIN ISOLATION LEVEL SERIALIZABLE").
func (pgDialect) txControl(sql string) string {
	f := strings.Fields(strings.ToUpper(strings.TrimRight(strings.TrimSpace(maskPG(sql)), "; \t\r\n")))
	if len(f) == 0 {
		return ""
	}
	rest := f[1:]
	if f[0] == "START" {
		if len(f) < 2 || f[1] != "TRANSACTION" {
			return ""
		}
		f, rest = []string{"BEGIN"}, f[2:]
	} else if len(rest) > 0 && (rest[0] == "WORK" || rest[0] == "TRANSACTION") {
		rest = rest[1:]
	}
	switch f[0] {
	case "COMMIT", "END":
		if len(rest) == 0 {
			return "COMMIT"
		}
	case "ROLLBACK", "ABORT":
		if len(rest) == 0 {
			return "ROLLBACK"
		}
	case "BEGIN":
		return strings.TrimSpace("BEGIN " + strings.Join(rest, " "))
	}
	return ""
}

func (pgDialect) implicitCommit(string) bool    { return false } // Postgres DDL is transactional
func (pgDialect) stmtSavepoint(sql string) bool { return !savepointCmd(sql) }

// noTx reports statements Postgres refuses to run inside a transaction block.
func (pgDialect) noTx(sql string) bool {
	m := maskPG(sql)
	w := pgWords(m)
	if len(w) == 0 {
		return false
	}
	switch w[0] {
	case "VACUUM":
		return true
	case "ALTER":
		return len(w) > 1 && w[1] == "SYSTEM"
	case "CREATE", "DROP":
		return len(w) > 1 && (w[1] == "DATABASE" || w[1] == "TABLESPACE") || hasWord(w, "CONCURRENTLY") && hasWord(w, "INDEX")
	case "REINDEX":
		return hasWord(w, "CONCURRENTLY")
	}
	return false
}

// savepointCmd: the user works with savepoints themselves; Grid's own one stays out of their way
// (a RELEASE or ROLLBACK TO of theirs would also drop it).
func savepointCmd(sql string) bool {
	w := pgWords(maskPG(sql))
	return len(w) > 0 && (w[0] == "SAVEPOINT" || w[0] == "RELEASE" || w[0] == "ROLLBACK" && len(w) > 1 && hasWord(w[1:], "TO"))
}

func (pgDialect) checkReadOnly(sql string) error {
	masked := strings.TrimRight(strings.TrimSpace(maskPG(sql)), "; \t\r\n")
	if masked == "" {
		return errors.New("empty statement")
	}
	if strings.Contains(masked, ";") {
		return errors.New("one statement at a time (no ; in the middle)")
	}
	if !pgRead(masked) {
		return errors.New("this connection is read-only for AI: only SELECT / WITH / VALUES / SHOW / EXPLAIN statements are allowed")
	}
	w := pgWords(masked)
	for i := 0; i+1 < len(w); i++ {
		if w[i] == "FOR" && (w[i+1] == "UPDATE" || w[i+1] == "SHARE" || w[i+1] == "NO" || w[i+1] == "KEY") {
			return errors.New("SELECT ... FOR UPDATE / SHARE is not allowed on a read-only connection")
		}
	}
	return nil
}

func (pgDialect) checkSingle(sql string) error {
	masked := strings.TrimRight(strings.TrimSpace(maskPG(sql)), "; \t\r\n")
	if masked == "" {
		return errors.New("empty statement")
	}
	if strings.Contains(masked, ";") { // function bodies are $$ quoted, so they are masked out
		return errors.New("one statement at a time (no ; in the middle)")
	}
	return nil
}

// formatCell: pgx hands JSON and XML over as bytes (they are text), and a DATE has no time of day.
func (pgDialect) formatCell(v any, dbType string) *string {
	switch x := v.(type) {
	case []byte:
		if dbType == "JSON" || dbType == "JSONB" || dbType == "XML" {
			s := string(x)
			return &s
		}
	case time.Time:
		if dbType == "DATE" {
			s := x.Format("2006-01-02")
			return &s
		}
	}
	return formatCell(v, dbType)
}

// ---- catalog ----

func (pgDialect) foldName(name string) string { return strings.ToLower(name) }
func (pgDialect) currentSchemaSQL() string    { return `SELECT COALESCE(current_schema(), 'public')` }

const pgUserSchemas = `n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'`

func (pgDialect) schemasSQL(all bool) string {
	if all {
		return `SELECT n.nspname FROM pg_namespace n ORDER BY 1`
	}
	return `SELECT n.nspname FROM pg_namespace n WHERE ` + pgUserSchemas + ` ORDER BY 1`
}

const pgRelKind = `CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END`

func (pgDialect) tablesSQL(all bool) string {
	where, like := `n.nspname = $1`, "$2"
	if all {
		where, like = pgUserSchemas, "$1"
	}
	return `SELECT n.nspname, c.relname, ` + pgRelKind + `, obj_description(c.oid, 'pg_class')
	      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	      WHERE ` + where + ` AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
	      AND upper(c.relname) LIKE ` + like + `
	      ORDER BY 1, 2`
}

// pgRel is the table's oid from (schema, table) = ($1, $2).
const pgRel = `(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)`

func (pgDialect) meta() metaSQL {
	return metaSQL{
		object: `SELECT ` + pgRelKind + `, obj_description(c.oid, 'pg_class')
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
		columns: `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NULL::int, NULL::int, NULL::int,
		  CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END, col_description(a.attrelid, a.attnum)
		FROM pg_attribute a WHERE a.attrelid = ` + pgRel + ` AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`,
		keys: `SELECT con.conname, CASE con.contype WHEN 'p' THEN 'P' WHEN 'u' THEN 'U' ELSE 'R' END, a.attname
		FROM pg_constraint con
		CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
		WHERE con.conrelid = ` + pgRel + ` AND con.contype IN ('p','u','f')
		ORDER BY con.conname, k.ord`,
		fkRefs: `SELECT con.conname, rn.nspname, rc.relname, a.attname
		FROM pg_constraint con
		JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
		CROSS JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
		JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
		WHERE con.conrelid = ` + pgRel + ` AND con.contype = 'f'
		ORDER BY con.conname, k.ord`,
		indexes: `SELECT ic.relname, CASE WHEN i.indisunique THEN 'UNIQUE' ELSE 'NONUNIQUE' END, pg_get_indexdef(i.indexrelid, k.n, true)
		FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
		CROSS JOIN LATERAL generate_series(1, i.indnatts::int) AS k(n)
		WHERE i.indrelid = ` + pgRel + `
		ORDER BY ic.relname, k.n`,
	}
}
