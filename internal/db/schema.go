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

// CurrentSchema is the schema the connection's user works in.
func (m *Manager) CurrentSchema(ctx context.Context, name string) (string, error) {
	var s string
	err := m.queryAll(ctx, name, `SELECT sys_context('USERENV','CURRENT_SCHEMA') FROM dual`, nil, func(r *sql.Rows) error { return r.Scan(&s) })
	return s, err
}

// Schemas lists the schemas that hold user objects (Oracle's own ones are left out unless all is set).
func (m *Manager) Schemas(ctx context.Context, name string, all bool) ([]string, error) {
	q := `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`
	if all {
		q = `SELECT username FROM all_users ORDER BY username`
	}
	out := []string{}
	err := m.queryAll(ctx, name, q, nil, func(r *sql.Rows) error {
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
	if schema == "" {
		s, err := m.CurrentSchema(ctx, name)
		if err != nil {
			return nil, false, err
		}
		schema = s
	}
	where := `o.owner = :1`
	args := []any{schema, likePattern(search)}
	if schema == "*" {
		where = `o.owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N')`
		args = []any{likePattern(search)}
	}
	q := `SELECT o.owner, o.object_name, o.object_type, tc.comments
	      FROM all_objects o LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
	      WHERE ` + where + ` AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')
	      AND o.object_name LIKE ` + map[bool]string{true: ":1", false: ":2"}[schema == "*"] + `
	      ORDER BY o.owner, o.object_name`
	var out []TableRef
	truncated := false
	err := m.queryAll(ctx, name, q, args, func(r *sql.Rows) error {
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
	if schema == "" {
		s, err := m.CurrentSchema(ctx, name)
		if err != nil {
			return nil, err
		}
		schema = s
	}
	info, err := m.describeExact(ctx, name, schema, table)
	if err == nil && len(info.Columns) == 0 && table != strings.ToUpper(table) {
		info, err = m.describeExact(ctx, name, schema, strings.ToUpper(table)) // unquoted names are upper case
	}
	if err == nil && len(info.Columns) == 0 {
		return nil, fmt.Errorf("table or view %s.%s not found (or no access)", schema, table)
	}
	return info, err
}

func (m *Manager) describeExact(ctx context.Context, name, schema, table string) (*TableInfo, error) {
	info := &TableInfo{Schema: schema, Name: table, Columns: []ColumnInfo{}}
	args := []any{schema, table}

	err := m.queryAll(ctx, name, `SELECT o.object_type, tc.comments FROM all_objects o
		LEFT JOIN all_tab_comments tc ON tc.owner = o.owner AND tc.table_name = o.object_name
		WHERE o.owner = :1 AND o.object_name = :2 AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') AND ROWNUM = 1`, args,
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

	err = m.queryAll(ctx, name, `SELECT c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale, c.nullable, cc.comments
		FROM all_tab_columns c LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id`, args,
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
	err = m.queryAll(ctx, name, `SELECT ac.constraint_name, ac.constraint_type, acc.column_name
		FROM all_constraints ac JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
		WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type IN ('P','U','R')
		ORDER BY ac.constraint_name, acc.position`, args,
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
	err = m.queryAll(ctx, name, `SELECT ac.constraint_name, rc.owner, rc.table_name, rcc.column_name
		FROM all_constraints ac
		JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
		JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
		WHERE ac.owner = :1 AND ac.table_name = :2 AND ac.constraint_type = 'R'
		ORDER BY ac.constraint_name, rcc.position`, args,
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
	err = m.queryAll(ctx, name, `SELECT i.index_name, i.uniqueness, ic.column_name
		FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
		WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY i.index_name, ic.column_position`, args,
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
