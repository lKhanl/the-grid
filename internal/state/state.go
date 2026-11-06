// Package state keeps per-user, per-machine Grid state (recent workspaces,
// the last opened one) under ~/.grid, apart from the workspace definitions
// (grid.yaml files) which live with their projects.
package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const maxRecent = 20

// Workspace is a remembered grid.yaml.
type Workspace struct {
	Path       string `json:"path"`
	Name       string `json:"name,omitempty"`
	LastOpened int64  `json:"lastOpened"` // unix millis
}

type data struct {
	Workspaces []Workspace `json:"workspaces"`
	Last       string      `json:"last,omitempty"`
	LogLines   int         `json:"logLines,omitempty"` // log history per service; 0 = default
}

// Store reads and writes ~/.grid/state.json. Safe for concurrent use.
type Store struct {
	mu   sync.Mutex
	file string
}

// Dir is the Grid home: $GRID_HOME, else ~/.grid.
func Dir() (string, error) {
	if d := os.Getenv("GRID_HOME"); d != "" {
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".grid"), nil
}

// Open returns the store in the default Grid home.
func Open() (*Store, error) {
	d, err := Dir()
	if err != nil {
		return nil, err
	}
	return OpenAt(d), nil
}

// OpenAt returns a store whose state.json lives in dir.
func OpenAt(dir string) *Store { return &Store{file: filepath.Join(dir, "state.json")} }

func (s *Store) load() data {
	var d data
	b, err := os.ReadFile(s.file)
	if err == nil {
		json.Unmarshal(b, &d) // a corrupt file just means "no history"
	}
	return d
}

func (s *Store) save(d data) error {
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// LogLines is the saved log history size, or 0 if none was chosen.
func (s *Store) LogLines() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load().LogLines
}

// SetLogLines saves the log history size.
func (s *Store) SetLogLines(n int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.load()
	d.LogLines = n
	return s.save(d)
}

// Touch records path as just opened (most recent, and the "last" workspace).
func (s *Store) Touch(path, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.load()
	out := []Workspace{{Path: path, Name: name, LastOpened: time.Now().UnixMilli()}}
	for _, w := range d.Workspaces {
		if w.Path != path {
			out = append(out, w)
		}
	}
	if len(out) > maxRecent {
		out = out[:maxRecent]
	}
	d.Workspaces, d.Last = out, path
	return s.save(d)
}

// Remove forgets a workspace (the file itself is untouched).
func (s *Store) Remove(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.load()
	var out []Workspace
	for _, w := range d.Workspaces {
		if w.Path != path {
			out = append(out, w)
		}
	}
	d.Workspaces = out
	if d.Last == path {
		d.Last = ""
	}
	return s.save(d)
}

// Recent lists remembered workspaces, most recently opened first. Entries
// whose file no longer exists are skipped.
func (s *Store) Recent() []Workspace {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Workspace{}
	for _, w := range s.load().Workspaces {
		if _, err := os.Stat(w.Path); err == nil {
			out = append(out, w)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].LastOpened > out[j].LastOpened })
	return out
}

// Last is the most recently opened workspace that still exists, if any.
func (s *Store) Last() (string, bool) {
	s.mu.Lock()
	p := s.load().Last
	s.mu.Unlock()
	if p == "" {
		return "", false
	}
	if _, err := os.Stat(p); err != nil {
		return "", false
	}
	return p, true
}
