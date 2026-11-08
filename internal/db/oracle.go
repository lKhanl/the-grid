//go:build db || oracle

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// oracleDialect: go-ora (pure Go, no Oracle client). The SQL text helpers are the
// package-level functions in sqltext.go.
type oracleDialect struct{}

func init() { dialects[KindOracle] = oracleDialect{} }

func (oracleDialect) normalize(c *Conn) error {
	if c.Mode == "" {
		c.Mode = ModeService
	}
	c.Database, c.SSLMode = "", ""
	switch c.Mode {
	case ModeService:
		if c.Host == "" || c.Service == "" {
			return errors.New("host and service name are required")
		}
	case ModeSID:
		if c.Host == "" || c.SID == "" {
			return errors.New("host and SID are required")
		}
	case ModeTNS:
		if c.TNS == "" {
			return errors.New("a TNS descriptor or alias is required")
		}
	default:
		return fmt.Errorf("mode %q: use service, sid or tns", c.Mode)
	}
	if c.Mode != ModeTNS && c.Port == 0 {
		c.Port = 1521
	}
	return nil
}

func (oracleDialect) open(c Conn) (*sql.DB, error) {
	url, err := dsn(c)
	if err != nil {
		return nil, err
	}
	d, err := sql.Open("oracle", url)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(8) // stopped statements keep their connection until the database ends them
	d.SetConnMaxIdleTime(5 * time.Minute)
	return d, nil
}

func (oracleDialect) hello(ctx context.Context, d *sql.DB) (string, error) {
	var who, version string
	if err := d.QueryRowContext(ctx, `SELECT sys_context('USERENV','SESSION_USER') FROM dual`).Scan(&who); err != nil {
		return "", err
	}
	d.QueryRowContext(ctx, `SELECT version FROM product_component_version WHERE ROWNUM = 1`).Scan(&version) // best effort
	msg := "Connected as " + who
	if version != "" {
		msg += " (Oracle " + version + ")"
	}
	return msg, nil
}

func (oracleDialect) prepare(sql string) string          { return prepare(sql) }
func (oracleDialect) returnsRows(sql string) bool        { return isQuery(sql) }
func (oracleDialect) isRead(sql string) bool             { return isQuery(sql) }
func (oracleDialect) txControl(sql string) string        { return txControl(sql) }
func (oracleDialect) implicitCommit(sql string) bool     { return isDDL(sql) }
func (oracleDialect) noTx(string) bool                   { return false }
func (oracleDialect) stmtSavepoint(string) bool          { return false }
func (oracleDialect) checkReadOnly(sql string) error     { return checkReadOnly(sql) }
func (oracleDialect) checkSingle(sql string) error       { return checkSingle(sql) }
func (oracleDialect) foldName(name string) string        { return strings.ToUpper(name) }
func (oracleDialect) formatCell(v any, t string) *string { return formatCell(v, t) }
func (oracleDialect) currentSchemaSQL() string {
	return `SELECT sys_context('USERENV','CURRENT_SCHEMA') FROM dual`
}

func (oracleDialect) schemasSQL(all bool) string {
	if all {
		return `SELECT username FROM all_users ORDER BY username`
	}
	return `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`
}

func (oracleDialect) tablesSQL(all bool) string {
	where, like := `o.owner = :1`, ":2"
	if all {
		where, like = `o.owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')`, ":1"
	}
	return `SELECT o.owner, o.object_name, o.object_type, tc.comments
	      FROM all_objects o LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
	      WHERE ` + where + ` AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')
	      AND o.object_name LIKE ` + like + `
	      ORDER BY o.owner, o.object_name`
}

func (oracleDialect) meta() metaSQL {
	return metaSQL{
		object: `SELECT o.object_type, tc.comments FROM all_objects o
		LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
		WHERE o.owner = :1 AND o.object_name = :2 AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') AND ROWNUM = 1`,
		columns: `SELECT c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale, c.nullable, cc.comments
		FROM all_tab_columns c LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id`,
		keys: `SELECT ac.constraint_name, ac.constraint_type, acc.column_name
		FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
		WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type IN ('P','U','R')
		ORDER BY ac.constraint_name, acc.position`,
		fkRefs: `SELECT ac.constraint_name, rc.owner, rc.table_name, rcc.column_name
		FROM all_constraints ac
		JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
		JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
		WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type = 'R'
		ORDER BY ac.constraint_name, rcc.position`,
		indexes: `SELECT i.index_name, i.uniqueness, ic.column_name
		FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
		WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY i.index_name, ic.column_position`,
	}
}
