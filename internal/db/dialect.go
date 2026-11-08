//go:build db || oracle || postgres

package db

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// Database kinds.
const (
	KindOracle   = "oracle"
	KindPostgres = "postgres"
)

// dialect is what differs between the databases: connecting, reading SQL text, and the
// catalog queries behind the schema browser. Everything else (sessions, transactions,
// stop / timeout, AI access) is shared.
type dialect interface {
	// normalize fills the defaults of the kind's own fields and validates them.
	normalize(c *Conn) error
	open(c Conn) (*sql.DB, error)
	// hello is the "connected as ..." line of a connection test.
	hello(ctx context.Context, d *sql.DB) (string, error)

	// SQL text of one statement.
	prepare(sql string) string      // as sent to the driver (e.g. without a trailing ;)
	returnsRows(sql string) bool    // run as a query (rows come back)
	isRead(sql string) bool         // changes nothing: no transaction is opened for it
	txControl(sql string) string    // a typed COMMIT | ROLLBACK | BEGIN, else ""
	implicitCommit(sql string) bool // the database commits the open transaction itself (Oracle DDL)
	noTx(sql string) bool           // must run outside a transaction block (Postgres VACUUM, ...)
	// stmtSavepoint: an error aborts the whole transaction (Postgres), so a statement in an
	// open transaction runs behind a savepoint and an error only undoes that statement.
	stmtSavepoint(sql string) bool
	checkReadOnly(sql string) error // what an AI may run on a read-only connection
	checkSingle(sql string) error   // one statement only (AI writes)
	// formatCell turns a driver value of a column of type dbType into display text (nil = NULL).
	formatCell(v any, dbType string) *string

	// Catalog. Placeholders are the driver's own; the arguments are given in the comments.
	currentSchemaSQL() string
	schemasSQL(all bool) string
	tablesSQL(all bool) string // args: schema (not when all), name pattern (upper case LIKE)
	meta() metaSQL
	// foldName is how the database stores an unquoted name (Oracle upper, Postgres lower case).
	foldName(name string) string
}

// metaSQL are the queries of Describe; each takes (schema, table).
type metaSQL struct {
	object  string // object type, comment
	columns string // name, data type, char length, precision, scale, nullable Y/N, comment
	keys    string // constraint name, type P/U/R, column (in key order)
	fkRefs  string // foreign key name, referenced owner, table, column (in key order)
	indexes string // index name, UNIQUE / NONUNIQUE, column (in index order)
}

// dialects holds the kinds compiled into this build: each driver file registers itself, so
// -tags oracle or -tags postgres leaves the other driver out (-tags db: both).
var dialects = map[string]dialect{}

// defaultKind is the kind of a connection saved without one (older files: Oracle).
func defaultKind() string {
	if _, ok := dialects[KindOracle]; ok {
		return KindOracle
	}
	if k := Kinds(); len(k) > 0 {
		return k[0]
	}
	return KindOracle
}

// Kinds lists the supported database kinds.
func Kinds() []string {
	out := make([]string, 0, len(dialects))
	for k := range dialects {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func dialectOf(kind string) (dialect, error) {
	if d, ok := dialects[kind]; ok {
		return d, nil
	}
	if kind == KindOracle || kind == KindPostgres {
		return nil, fmt.Errorf("%s is not in this build of Grid (it has: %s); build with -tags db or -tags %s", kind, strings.Join(Kinds(), ", "), kind)
	}
	return nil, fmt.Errorf("kind %q is not supported (%s)", kind, strings.Join(Kinds(), ", "))
}

// openConn opens the pool of c with its kind's driver.
func openConn(c Conn) (*sql.DB, error) {
	d, err := dialectOf(c.Kind)
	if err != nil {
		return nil, err
	}
	return d.open(c)
}
