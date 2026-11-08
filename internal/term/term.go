// Package term runs interactive shells in pseudo terminals for the UI.
// Sessions live in the server: reloading the page reattaches and replays
// recent output; they end when the shell exits, is closed, or grid stops.
package term

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"
)

// ptyProc is a shell attached to a pseudo terminal.
type ptyProc interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int) error
	Pid() int
	Wait() int // blocks until the shell exits; returns its exit code
	Kill()     // ends the shell and everything it started
	Hangup()   // after exit: makes pending reads finish
	Close()    // releases everything
}

const scrollback = 1 << 20 // bytes of output kept for reattaching clients

// Info is the JSON view of a session.
type Info struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Shell    string   `json:"shell"`
	Cwd      string   `json:"cwd"`
	Service  string   `json:"service,omitempty"`
	Runtimes []string `json:"runtimes,omitempty"`
	Pid      int      `json:"pid,omitempty"`
	Started  int64    `json:"started"`
	Exited   bool     `json:"exited"`
	ExitCode *int     `json:"exitCode,omitempty"`
}

// Options describe a new session.
type Options struct {
	Shell    string // executable path or name; "" = platform default
	Cwd      string
	Env      []string
	Title    string
	Service  string
	Runtimes []string
	Cols     int
	Rows     int
}

type Session struct {
	mu     sync.Mutex
	info   Info
	pty    ptyProc
	buf    []byte
	subs   map[chan []byte]struct{}
	closed chan struct{} // closed when the shell has exited and output is drained
}

// Manager owns all sessions.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	next     int
	onChange func()
}

// NewManager: onChange is called (without locks held) whenever the list changes.
func NewManager(onChange func()) *Manager {
	if onChange == nil {
		onChange = func() {}
	}
	return &Manager{sessions: map[string]*Session{}, onChange: onChange}
}

func (m *Manager) List() []Info {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]Info, 0, len(list))
	for _, s := range list {
		out = append(out, s.Info())
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Started < out[j].Started || (out[i].Started == out[j].Started && out[i].ID < out[j].ID)
	})
	return out
}

func (m *Manager) Get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *Manager) Open(o Options) (*Session, error) {
	if o.Cwd == "" {
		return nil, errors.New("no working directory")
	}
	if st, err := os.Stat(o.Cwd); err != nil || !st.IsDir() {
		return nil, fmt.Errorf("not a directory: %s", o.Cwd)
	}
	shell := o.Shell
	if shell == "" {
		shell = DefaultShell()
	}
	argv := ShellArgs(shell)
	if o.Cols <= 0 || o.Rows <= 0 {
		o.Cols, o.Rows = 120, 30
	}
	p, err := startPTY(argv, o.Cwd, o.Env, o.Cols, o.Rows)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", shell, err)
	}
	m.mu.Lock()
	m.next++
	id := strconv.Itoa(m.next)
	title := o.Title
	if title == "" {
		title = shellName(shell)
	}
	s := &Session{
		info: Info{ID: id, Title: title, Shell: shell, Cwd: o.Cwd, Service: o.Service, Runtimes: o.Runtimes,
			Pid: p.Pid(), Started: time.Now().UnixMilli()},
		pty:    p,
		subs:   map[chan []byte]struct{}{},
		closed: make(chan struct{}),
	}
	m.sessions[id] = s
	m.mu.Unlock()
	go s.run(m.onChange)
	m.onChange()
	return s, nil
}

// Close kills the shell and forgets the session.
func (m *Manager) Close(id string) bool {
	m.mu.Lock()
	s := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if s == nil {
		return false
	}
	s.kill()
	m.onChange()
	return true
}

// Shutdown kills every shell and waits (briefly) for them to go.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for id, s := range m.sessions {
		list = append(list, s)
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.kill()
	}
	deadline := time.After(3 * time.Second)
	for _, s := range list {
		select {
		case <-s.closed:
		case <-deadline:
			return
		}
	}
}

func (s *Session) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.info
	return i
}

func (s *Session) kill() {
	s.mu.Lock()
	exited := s.info.Exited
	s.mu.Unlock()
	if !exited {
		s.pty.Kill()
	}
}

func (s *Session) run(onChange func()) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		b := make([]byte, 32*1024)
		for {
			n, err := s.pty.Read(b)
			if n > 0 {
				s.emit(bytes.Clone(b[:n]))
			}
			if err != nil {
				return
			}
		}
	}()
	code := s.pty.Wait()
	s.pty.Hangup()
	select {
	case <-readDone:
	case <-time.After(2 * time.Second): // something still holds the terminal open
	}
	go s.pty.Close() // may block on Windows until the reader gives up; never stall here
	s.emit([]byte(fmt.Sprintf("\r\n\x1b[2m[process exited with code %d]\x1b[0m\r\n", code)))

	s.mu.Lock()
	s.info.Exited = true
	s.info.ExitCode = &code
	s.info.Pid = 0
	for ch := range s.subs {
		close(ch)
	}
	s.subs = nil
	s.mu.Unlock()
	close(s.closed)
	onChange()
}

func (s *Session) emit(b []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf = append(s.buf, b...)
	if len(s.buf) > scrollback {
		cut := len(s.buf) - scrollback
		// Start the kept history at a line boundary so replay does not begin mid escape sequence.
		if i := bytes.IndexByte(s.buf[cut:], '\n'); i >= 0 && i < 4096 {
			cut += i + 1
		}
		s.buf = append([]byte(nil), s.buf[cut:]...)
	}
	for ch := range s.subs {
		select {
		case ch <- b:
		default: // too slow: drop it, the client reconnects and replays
			close(ch)
			delete(s.subs, ch)
		}
	}
}

// Attach returns the history so far and a channel with everything after it.
// The channel is closed when the shell exits or the client falls behind;
// it is nil when the shell has already exited.
func (s *Session) Attach() (history []byte, ch chan []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	history = bytes.Clone(s.buf)
	if s.subs == nil {
		return history, nil
	}
	ch = make(chan []byte, 512)
	s.subs[ch] = struct{}{}
	return history, ch
}

func (s *Session) Detach(ch chan []byte) {
	if ch == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[ch]; ok {
		delete(s.subs, ch)
		close(ch)
	}
}

func (s *Session) Write(b []byte) error {
	if s.Info().Exited {
		return nil
	}
	_, err := s.pty.Write(b)
	return err
}

func (s *Session) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 || s.Info().Exited {
		return nil
	}
	return s.pty.Resize(cols, rows)
}

func shellName(shell string) string {
	base := filepath.Base(shell)
	if ext := filepath.Ext(base); ext != "" {
		base = base[:len(base)-len(ext)]
	}
	return base
}
