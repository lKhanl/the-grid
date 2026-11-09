//go:build db || oracle || postgres

// Package db is Grid's small database client: saved connections, an Oracle
// driver (pure Go, no Oracle client needed), a SQL session with commit and
// rollback, schema browsing, and the guarded access used by MCP.
package db

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// MCP access levels of a connection.
const (
	MCPOff       = "off"       // the AI does not see the connection
	MCPReadOnly  = "readonly"  // SELECT / WITH only, in a read-only transaction (default)
	MCPReadWrite = "readwrite" // the AI may also run INSERT / UPDATE / DDL
)

// Connection modes (Oracle).
const (
	ModeService = "service" // host + port + service name
	ModeSID     = "sid"     // host + port + SID
	ModeTNS     = "tns"     // a full (DESCRIPTION=...) or an alias from tnsnames.ora
)

// Conn is a saved connection. Passwords are stored as plain text in
// ~/.grid/connections.json (readable by this user only).
type Conn struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`           // oracle | postgres
	Mode       string `json:"mode,omitempty"` // Oracle: service | sid | tns
	Host       string `json:"host,omitempty"`
	Port       int    `json:"port,omitempty"`
	Service    string `json:"service,omitempty"`
	SID        string `json:"sid,omitempty"`
	TNS        string `json:"tns,omitempty"`      // descriptor, or an alias looked up in tnsnames.ora
	TNSAdmin   string `json:"tnsAdmin,omitempty"` // folder with tnsnames.ora (default: $TNS_ADMIN)
	Database   string `json:"database,omitempty"` // Postgres: the database name
	SSLMode    string `json:"sslMode,omitempty"`  // Postgres: disable | allow | prefer (default) | require | verify-ca | verify-full
	User       string `json:"user"`
	Password   string `json:"password,omitempty"`
	AutoCommit bool   `json:"autoCommit"`
	MCP        string `json:"mcp"`
}

// View is a Conn as the UI sees it: never with the password.
type View struct {
	Conn
	Password    string `json:"-"`
	HasPassword bool   `json:"hasPassword"`
	Connected   bool   `json:"connected"`
	InTx        bool   `json:"inTx"` // uncommitted changes in the UI session
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$`)

// Normalize fills defaults and validates.
func (c *Conn) Normalize() error {
	c.Name = strings.TrimSpace(c.Name)
	if !nameRe.MatchString(c.Name) {
		return errors.New("name: letters, digits, space, _ . - (1-64 characters, starting with a letter or digit)")
	}
	if c.Kind == "" {
		c.Kind = defaultKind()
	}
	d, err := dialectOf(c.Kind)
	if err != nil {
		return err
	}
	c.Host, c.Service, c.SID = strings.TrimSpace(c.Host), strings.TrimSpace(c.Service), strings.TrimSpace(c.SID)
	c.TNS, c.TNSAdmin, c.User = strings.TrimSpace(c.TNS), strings.TrimSpace(c.TNSAdmin), strings.TrimSpace(c.User)
	if err := d.normalize(c); err != nil {
		return err
	}
	if c.User == "" {
		return errors.New("user is required")
	}
	switch c.MCP {
	case "":
		c.MCP = MCPReadOnly
	case MCPOff, MCPReadOnly, MCPReadWrite:
	default:
		return fmt.Errorf("mcp %q: use off, readonly or readwrite", c.MCP)
	}
	return nil
}

// Where is the connection's address for display, e.g. "db:1521/ORCLPDB1" or "db:5432/orders".
func (c Conn) Where() string {
	switch {
	case c.Kind == KindPostgres:
		return fmt.Sprintf("%s:%d/%s", c.Host, c.Port, c.Database)
	case c.Mode == ModeSID:
		return fmt.Sprintf("%s:%d SID %s", c.Host, c.Port, c.SID)
	case c.Mode == ModeTNS:
		return "TNS " + c.TNS
	}
	return fmt.Sprintf("%s:%d/%s", c.Host, c.Port, c.Service)
}

// Store keeps the saved connections in one JSON file.
type Store struct {
	mu    sync.Mutex
	file  string
	conns []Conn
}

type storeFile struct {
	Connections []Conn `json:"connections"`
}

// OpenStore loads dir/connections.json (a missing or corrupt file means "none").
func OpenStore(dir string) *Store {
	s := &Store{file: filepath.Join(dir, "connections.json")}
	if b, err := os.ReadFile(s.file); err == nil {
		var f storeFile
		if json.Unmarshal(b, &f) == nil {
			s.conns = f.Connections
		}
	}
	return s
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(storeFile{Connections: s.conns}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// Reload re-reads the file, after it was edited outside the Grid (by hand or by an agent).
// A missing file means no connections; a corrupt or invalid one is an error and changes nothing.
// It returns the names that were added, removed or changed.
func (s *Store) Reload() (added, removed, changed []string, err error) {
	var f storeFile
	b, err := os.ReadFile(s.file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return nil, nil, nil, err
	default:
		if err := json.Unmarshal(b, &f); err != nil {
			return nil, nil, nil, fmt.Errorf("%s: %w", s.file, err)
		}
	}
	seen := map[string]bool{}
	for i := range f.Connections {
		c := &f.Connections[i]
		if err := c.Normalize(); err != nil {
			return nil, nil, nil, fmt.Errorf("connection %q: %w", c.Name, err)
		}
		if seen[strings.ToLower(c.Name)] {
			return nil, nil, nil, fmt.Errorf("two connections are called %q", c.Name)
		}
		seen[strings.ToLower(c.Name)] = true
	}
	s.mu.Lock()
	old := map[string]Conn{}
	for _, c := range s.conns {
		old[strings.ToLower(c.Name)] = c
	}
	s.conns = f.Connections
	s.mu.Unlock()
	for _, c := range f.Connections {
		prev, ok := old[strings.ToLower(c.Name)]
		switch {
		case !ok:
			added = append(added, c.Name)
		case !reflect.DeepEqual(prev, c):
			changed = append(changed, c.Name)
		}
		delete(old, strings.ToLower(c.Name))
	}
	for _, c := range old {
		removed = append(removed, c.Name)
	}
	sort.Strings(added)
	sort.Strings(removed)
	sort.Strings(changed)
	return added, removed, changed, nil
}

// List returns the connections sorted by name.
func (s *Store) List() []Conn {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]Conn(nil), s.conns...)
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// Get returns a connection by name (case-insensitive).
func (s *Store) Get(name string) (Conn, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		if strings.EqualFold(c.Name, name) {
			return c, true
		}
	}
	return Conn{}, false
}

// Put adds a connection, or replaces the one called old (rename allowed).
// An empty password keeps the stored one.
func (s *Store) Put(old string, c Conn) (Conn, error) {
	if err := c.Normalize(); err != nil {
		return c, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idx := -1
	for i, e := range s.conns {
		if old != "" && strings.EqualFold(e.Name, old) {
			idx = i
		} else if strings.EqualFold(e.Name, c.Name) {
			return c, fmt.Errorf("a connection called %q already exists", c.Name)
		}
	}
	if old != "" && idx < 0 {
		return c, fmt.Errorf("unknown connection %q", old)
	}
	if idx >= 0 {
		if c.Password == "" {
			c.Password = s.conns[idx].Password
		}
		s.conns[idx] = c
	} else {
		s.conns = append(s.conns, c)
	}
	return c, s.save()
}

// Delete forgets a connection.
func (s *Store) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, e := range s.conns {
		if strings.EqualFold(e.Name, name) {
			s.conns = append(s.conns[:i], s.conns[i+1:]...)
			return s.save()
		}
	}
	return fmt.Errorf("unknown connection %q", name)
}
