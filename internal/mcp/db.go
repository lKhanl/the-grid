//go:build db || oracle || postgres

package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lKhanl/the-grid/internal/db"
)

// Database tools: the AI sees only the connections marked as shared in the Grid, and the
// Grid itself enforces read-only access (these tools just pass the request on).

const (
	maxCellLen    = 120
	maxDBText     = 12000
	defaultDBRows = 50
	maxDBRows     = 500
)

// dbInstructions is appended to the server instructions.
const dbInstructions = " Databases the user shared are reachable with db_list, db_tables, db_describe and db_query (read-only; always describe a table before querying it)."

// callDB runs a database tool; ok is false when name is not one.
func (s *Server) callDB(name string, args map[string]any) (text string, ok bool, err error) {
	switch name {
	case "db_list":
		text, err = s.dbList()
	case "db_tables":
		text, err = s.dbTables(str(args, "connection"), str(args, "schema"), str(args, "search"))
	case "db_describe":
		text, err = s.dbDescribe(str(args, "connection"), str(args, "schema"), str(args, "table"))
	case "db_query":
		text, err = s.dbQuery(str(args, "connection"), str(args, "sql"), intArg(args, "max_rows", defaultDBRows, 1, maxDBRows), false)
	case "db_execute":
		text, err = s.dbQuery(str(args, "connection"), str(args, "sql"), defaultDBRows, true)
	default:
		return "", false, nil
	}
	return text, true, err
}

var dbTools = []map[string]any{
	{
		"name":        "db_list",
		"description": "List the database connections shared with you (name, where, user, and whether you may change data). Start here.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
	},
	{
		"name":        "db_tables",
		"description": "Find tables and views of a connection. Without schema: the connection's own schema; schema=* searches every user schema. search is a name fragment (case-insensitive, * wildcard).",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"connection": map[string]any{"type": "string", "description": "connection name, see db_list"},
				"schema":     map[string]any{"type": "string", "description": "schema (owner); default the connection's own, * for all"},
				"search":     map[string]any{"type": "string", "description": "part of a table name"},
			},
			"required": []string{"connection"},
		},
	},
	{
		"name":        "db_describe",
		"description": "Columns (type, null, primary key, comment), keys and indexes of one table or view. Use before writing a query.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"connection": map[string]any{"type": "string", "description": "connection name, see db_list"},
				"table":      map[string]any{"type": "string", "description": "table or view name"},
				"schema":     map[string]any{"type": "string", "description": "schema (owner); default the connection's own"},
			},
			"required": []string{"connection", "table"},
		},
	},
	{
		"name":        "db_query",
		"description": "Run one SELECT (or WITH) statement and get the rows as text. Read-only: nothing is changed. Always limit the result yourself (WHERE, FETCH FIRST n ROWS ONLY); at most max_rows rows come back.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"connection": map[string]any{"type": "string", "description": "connection name, see db_list"},
				"sql":        map[string]any{"type": "string", "description": "one SELECT / WITH statement"},
				"max_rows":   map[string]any{"type": "integer", "description": "default 50, max 500"},
			},
			"required": []string{"connection", "sql"},
		},
	},
	{
		"name":        "db_execute",
		"description": "Run one statement that changes data or structure (INSERT, UPDATE, DELETE, DDL) and commit it. Only works on connections whose owner allowed read & write for AI (see db_list). Think twice: there is no undo.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"connection": map[string]any{"type": "string", "description": "connection name, see db_list"},
				"sql":        map[string]any{"type": "string", "description": "one statement"},
			},
			"required": []string{"connection", "sql"},
		},
	},
}

func (s *Server) post(path string, body any) ([]byte, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", s.Base+path, bytes.NewReader(b))
	req.Header.Set("X-Grid", "mcp")
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("The Grid is not running at %s (start it with: grid)", s.Base)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct{ Error string }
		if json.Unmarshal(out, &e) == nil && e.Error != "" {
			return nil, fmt.Errorf("%s", e.Error)
		}
		return nil, fmt.Errorf("%s", resp.Status)
	}
	return out, nil
}

func (s *Server) dbList() (string, error) {
	b, err := s.get("/api/ai/db")
	if err != nil {
		return "", err
	}
	var list []db.View
	if err := json.Unmarshal(b, &list); err != nil {
		return "", err
	}
	if len(list) == 0 {
		return "No database connections are shared with AI. In the Grid: Database panel, edit a connection, set \"MCP access\" to read-only.", nil
	}
	var out strings.Builder
	for _, v := range list {
		where := v.Where()
		if len(where) > 60 { // a full TNS descriptor
			where = where[:60] + "..."
		}
		access := "read-only"
		if v.MCP == db.MCPReadWrite {
			access = "read & write"
		}
		fmt.Fprintf(&out, "%s: %s %s as %s, %s\n", v.Name, v.Kind, where, v.User, access)
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

func (s *Server) dbTables(conn, schema, search string) (string, error) {
	q := url.Values{"schema": {schema}, "q": {search}, "limit": {"200"}}
	b, err := s.get(fmt.Sprintf("/api/ai/db/%s/tables?%s", url.PathEscape(conn), q.Encode()))
	if err != nil {
		return "", err
	}
	var r struct {
		Tables    []db.TableRef `json:"tables"`
		Truncated bool          `json:"truncated"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return "", err
	}
	if len(r.Tables) == 0 {
		return "No tables or views found. Try a shorter search, or schema=* to look in every schema.", nil
	}
	var out strings.Builder
	for _, t := range r.Tables {
		fmt.Fprintf(&out, "%s.%s (%s)", t.Schema, t.Name, strings.ToLower(t.Type))
		if t.Comment != "" {
			out.WriteString(" - " + oneLine(t.Comment, 100))
		}
		out.WriteByte('\n')
	}
	if r.Truncated {
		out.WriteString("... more exist: narrow the search.\n")
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

func (s *Server) dbDescribe(conn, schema, table string) (string, error) {
	q := url.Values{"schema": {schema}, "table": {table}}
	b, err := s.get(fmt.Sprintf("/api/ai/db/%s/describe?%s", url.PathEscape(conn), q.Encode()))
	if err != nil {
		return "", err
	}
	var t db.TableInfo
	if err := json.Unmarshal(b, &t); err != nil {
		return "", err
	}
	var out strings.Builder
	fmt.Fprintf(&out, "%s.%s (%s)", t.Schema, t.Name, strings.ToLower(t.Type))
	if t.Comment != "" {
		out.WriteString(" - " + oneLine(t.Comment, 150))
	}
	out.WriteString("\ncolumns:\n")
	for _, c := range t.Columns {
		fmt.Fprintf(&out, "  %s %s", c.Name, c.Type)
		if !c.Nullable {
			out.WriteString(" NOT NULL")
		}
		if c.PK {
			out.WriteString(" PK")
		}
		if c.Comment != "" {
			out.WriteString(" - " + oneLine(c.Comment, 100))
		}
		out.WriteByte('\n')
	}
	for _, k := range t.Unique {
		fmt.Fprintf(&out, "unique %s: (%s)\n", k.Name, strings.Join(k.Columns, ", "))
	}
	for _, k := range t.ForeignKeys {
		fmt.Fprintf(&out, "foreign key %s: (%s) -> %s\n", k.Name, strings.Join(k.Columns, ", "), k.Ref)
	}
	for _, ix := range t.Indexes {
		u := ""
		if ix.Unique {
			u = " unique"
		}
		fmt.Fprintf(&out, "index %s%s: (%s)\n", ix.Name, u, strings.Join(ix.Columns, ", "))
	}
	return strings.TrimRight(out.String(), "\n"), nil
}

func (s *Server) dbQuery(conn, sql string, maxRows int, write bool) (string, error) {
	b, err := s.post(fmt.Sprintf("/api/ai/db/%s/query", url.PathEscape(conn)), map[string]any{"sql": sql, "maxRows": maxRows, "write": write})
	if err != nil {
		return "", err
	}
	var r db.Result
	if err := json.Unmarshal(b, &r); err != nil {
		return "", err
	}
	if r.Kind == "update" {
		return fmt.Sprintf("%d rows affected, committed (%d ms).", r.RowsAffected, r.Millis), nil
	}
	return renderRows(&r), nil
}

// renderRows draws a result as small plain text: header, rows, and a footer that says
// whether everything is there.
func renderRows(r *db.Result) string {
	if len(r.Rows) == 0 {
		return fmt.Sprintf("0 rows (%d ms). Columns: %s", r.Millis, colNames(r))
	}
	var out strings.Builder
	out.WriteString(colNames(r) + "\n")
	shown := 0
	for _, row := range r.Rows {
		cells := make([]string, len(row))
		for i, c := range row {
			if c == nil {
				cells[i] = "NULL"
			} else {
				cells[i] = oneLine(*c, maxCellLen)
			}
		}
		line := strings.Join(cells, " | ") + "\n"
		if out.Len()+len(line) > maxDBText {
			break
		}
		out.WriteString(line)
		shown++
	}
	switch {
	case shown < len(r.Rows):
		fmt.Fprintf(&out, "... only %d of %d rows fit; select fewer columns or add a WHERE.", shown, len(r.Rows))
	case r.Truncated:
		fmt.Fprintf(&out, "... first %d rows; more exist. Add a WHERE or aggregate.", shown)
	default:
		fmt.Fprintf(&out, "%d rows (%d ms).", shown, r.Millis)
	}
	return out.String()
}

func colNames(r *db.Result) string {
	names := make([]string, len(r.Columns))
	for i, c := range r.Columns {
		names[i] = c.Name
	}
	return strings.Join(names, " | ")
}

// oneLine keeps a cell on one line and cuts it to n characters.
func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "..."
	}
	return s
}
