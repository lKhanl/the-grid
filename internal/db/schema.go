//go:build db || oracle || postgres

package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// TableRef is one table or view in a listing.
type TableRef struct {
	Schema  string `json:"schema"`
	Name    string `json:"name"`
	Type    string `json:"type"` // TABLE | VIEW | MATERIALIZED VIEW
	Comment string `json:"comment,omitempty"`
}

// ColumnInfo describes one column of a table.
type ColumnInfo struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // e.g. VARCHAR2(40), NUMBER(10,2)
	Nullable bool   `json:"nullable"`
	PK       bool   `json:"pk,omitempty"`
	Comment  string `json:"comment,omitempty"`
}

// KeyInfo is a unique or foreign key.
type KeyInfo struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Ref     string   `json:"ref,omitempty"` // foreign keys: OWNER.TABLE(COL, ...)
}

// IndexInfo is an index.
type IndexInfo struct {
	Name    string   `json:"name"`
	Unique  bool     `json:"unique"`
	Columns []string `json:"columns"`
}

// TableInfo is the full description of one table or view.
type TableInfo struct {
	Schema      string       `json:"schema"`
	Name        string       `json:"name"`
	Type        string       `json:"type"`
	Comment     string       `json:"comment,omitempty"`
	Columns     []ColumnInfo `json:"columns"`
	PrimaryKey  []string     `json:"primaryKey,omitempty"`
	Unique      []KeyInfo    `json:"unique,omitempty"`
	ForeignKeys []KeyInfo    `json:"foreignKeys,omitempty"`
	Indexes     []IndexInfo  `json:"indexes,omitempty"`
}

const metaTimeout = 30 * time.Second

// queryAll runs a metadata query on a pooled connection and hands every row to fn.
func (m *Manager) queryAll(ctx context.Context, name, q string, args []any, fn func(*sql.Rows) error) error {
	p, err := m.get(name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, metaTimeout)
	defer cancel()
	rows, err := p.db.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// dialectFor is the dialect of a saved connection.
func (m *Manager) dialectFor(name string) (dialect, error) {
	p, err := m.get(name)
	if err != nil {
		return nil, err
	}
	return p.d, nil
}

// CurrentSchema is the schema the connection's user works in.
func (m *Manager) CurrentSchema(ctx context.Context, name string) (string, error) {
	d, err := m.dialectFor(name)
	if err != nil {
		return "", err
	}
	var s string
	err = m.queryAll(ctx, name, d.currentSchemaSQL(), nil, func(r *sql.Rows) error { return r.Scan(&s) })
	return s, err
}

// Schemas lists the schemas that hold user objects (the database's own ones are left out unless all is set).
func (m *Manager) Schemas(ctx context.Context, name string, all bool) ([]string, error) {
	d, err := m.dialectFor(name)
	if err != nil {
		return nil, err
	}
	q := d.schemasSQL(all)
	out := []string{}
	err = m.queryAll(ctx, name, q, nil, func(r *sql.Rows) error {
		var s string
		if err := r.Scan(&s); err != nil {
			return err
		}
		out = append(out, s)
		return nil
	})
	return out, err
}

// likePattern turns a search word into an upper-case LIKE pattern ("*" and "%" are wildcards).
func likePattern(q string) string {
	q = strings.ToUpper(strings.TrimSpace(q))
	q = strings.ReplaceAll(q, "*", "%")
	if q == "" {
		return "%"
	}
	if !strings.Contains(q, "%") {
		q = "%" + q + "%"
	}
	return q
}

// Tables lists tables and views. schema "" means the user's current schema, "*" all user schemas.
func (m *Manager) Tables(ctx context.Context, name, schema, search string, limit int) ([]TableRef, bool, error) {
	d, err := m.dialectFor(name)
	if err != nil {
		return nil, false, err
	}
	if schema == "" {
		s, err := m.CurrentSchema(ctx, name)
		if err != nil {
			return nil, false, err
		}
		schema = s
	}
	args := []any{schema, likePattern(search)}
	if schema == "*" {
		args = []any{likePattern(search)}
	}
	q := d.tablesSQL(schema == "*")
	var out []TableRef
	truncated := false
	err = m.queryAll(ctx, name, q, args, func(r *sql.Rows) error {
		if len(out) >= limit {
			truncated = true
			return nil
		}
		var t TableRef
		var c sql.NullString
		if err := r.Scan(&t.Schema, &t.Name, &t.Type, &c); err != nil {
			return err
		}
		t.Comment = c.String
		out = append(out, t)
		return nil
	})
	return out, truncated, err
}

func typeName(dt string, charLen, prec, scale sql.NullInt64) string {
	switch dt {
	case "VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR":
		if charLen.Valid && charLen.Int64 > 0 {
			return fmt.Sprintf("%s(%d)", dt, charLen.Int64)
		}
	case "NUMBER":
		if prec.Valid && prec.Int64 > 0 {
			if scale.Valid && scale.Int64 != 0 {
				return fmt.Sprintf("NUMBER(%d,%d)", prec.Int64, scale.Int64)
			}
			return fmt.Sprintf("NUMBER(%d)", prec.Int64)
		}
	}
	return dt
}

// Describe returns columns, keys and indexes of one table or view.
func (m *Manager) Describe(ctx context.Context, name, schema, table string) (*TableInfo, error) {
	d, err := m.dialectFor(name)
	if err != nil {
		return nil, err
	}
	if schema == "" {
		s, err := m.CurrentSchema(ctx, name)
		if err != nil {
			return nil, err
		}
		schema = s
	}
	info, err := m.describeExact(ctx, name, d.meta(), schema, table)
	if f := d.foldName(table); err == nil && len(info.Columns) == 0 && table != f {
		info, err = m.describeExact(ctx, name, d.meta(), schema, f) // unquoted names: upper case in Oracle, lower in Postgres
	}
	if err == nil && len(info.Columns) == 0 {
		return nil, fmt.Errorf("table or view %s.%s not found (or no access)", schema, table)
	}
	return info, err
}

func (m *Manager) describeExact(ctx context.Context, name string, q metaSQL, schema, table string) (*TableInfo, error) {
	info := &TableInfo{Schema: schema, Name: table, Columns: []ColumnInfo{}}
	args := []any{schema, table}

	err := m.queryAll(ctx, name, q.object, args,
		func(r *sql.Rows) error {
			var c sql.NullString
			if err := r.Scan(&info.Type, &c); err != nil {
				return err
			}
			info.Comment = c.String
			return nil
		})
	if err != nil {
		return nil, err
	}

	err = m.queryAll(ctx, name, q.columns, args,
		func(r *sql.Rows) error {
			var col ColumnInfo
			var dt string
			var cl, pr, sc sql.NullInt64
			var nullable string
			var cm sql.NullString
			if err := r.Scan(&col.Name, &dt, &cl, &pr, &sc, &nullable, &cm); err != nil {
				return err
			}
			col.Type, col.Nullable, col.Comment = typeName(dt, cl, pr, sc), nullable == "Y", cm.String
			info.Columns = append(info.Columns, col)
			return nil
		})
	if err != nil || len(info.Columns) == 0 {
		return info, err
	}

	// primary / unique / foreign keys
	type keyKey struct{ name, typ string }
	order := []keyKey{}
	cols := map[keyKey][]string{}
	err = m.queryAll(ctx, name, q.keys, args,
		func(r *sql.Rows) error {
			var n, t, c string
			if err := r.Scan(&n, &t, &c); err != nil {
				return err
			}
			k := keyKey{n, t}
			if _, ok := cols[k]; !ok {
				order = append(order, k)
			}
			cols[k] = append(cols[k], c)
			return nil
		})
	if err != nil {
		return nil, err
	}
	refs := map[string]string{} // foreign key -> OWNER.TABLE(COLS)
	refCols := map[string][]string{}
	refTable := map[string]string{}
	err = m.queryAll(ctx, name, q.fkRefs, args,
		func(r *sql.Rows) error {
			var n, o, t, c string
			if err := r.Scan(&n, &o, &t, &c); err != nil {
				return err
			}
			refTable[n] = o + "." + t
			refCols[n] = append(refCols[n], c)
			return nil
		})
	if err != nil {
		return nil, err
	}
	for n, t := range refTable {
		refs[n] = fmt.Sprintf("%s(%s)", t, strings.Join(refCols[n], ", "))
	}
	pk := map[string]bool{}
	for _, k := range order {
		switch k.typ {
		case "P":
			info.PrimaryKey = cols[k]
			for _, c := range cols[k] {
				pk[c] = true
			}
		case "U":
			info.Unique = append(info.Unique, KeyInfo{Name: k.name, Columns: cols[k]})
		case "R":
			info.ForeignKeys = append(info.ForeignKeys, KeyInfo{Name: k.name, Columns: cols[k], Ref: refs[k.name]})
		}
	}
	for i := range info.Columns {
		info.Columns[i].PK = pk[info.Columns[i].Name]
	}

	// indexes
	idx := map[string]*IndexInfo{}
	var idxOrder []string
	err = m.queryAll(ctx, name, q.indexes, args,
		func(r *sql.Rows) error {
			var n, u, c string
			if err := r.Scan(&n, &u, &c); err != nil {
				return err
			}
			ix, ok := idx[n]
			if !ok {
				ix = &IndexInfo{Name: n, Unique: u == "UNIQUE"}
				idx[n] = ix
				idxOrder = append(idxOrder, n)
			}
			ix.Columns = append(ix.Columns, c)
			return nil
		})
	if err != nil {
		return nil, err
	}
	for _, n := range idxOrder {
		info.Indexes = append(info.Indexes, *idx[n])
	}
	return info, nil
}
