package runner

// Log files: every line a service logs is also appended (colours removed)
// to <grid home>/logs/<workspace>/<service>.log, so the history survives a
// restart of the Grid. Each service uses at most MaxLogFileBytes on disk:
// the current file and the previous one (.1), half of the limit each.

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// MaxLogFileBytes is the disk space one service's log files may take.
const MaxLogFileBytes = 10 << 20

const (
	logFlushEvery = time.Second
	logIdleClose  = 30 * time.Second // close idle files so they can be opened / deleted freely (Windows)
)

type logFile struct {
	path string
	f    *os.File
	w    *bufio.Writer
	size int64
	last time.Time
}

// fileLogs owns every open log file of the manager.
type fileLogs struct {
	mu      sync.Mutex
	root    string // where files go now; "" = off
	home    string // configured folder
	off     bool   // turned off in Settings
	files   map[string]*logFile
	stop    chan struct{}
	failed  map[string]bool // paths that could not be opened (reported once)
	onError func(path string, err error)
}

func newFileLogs() *fileLogs {
	return &fileLogs{files: map[string]*logFile{}, failed: map[string]bool{}, onError: func(path string, err error) {
		fmt.Fprintf(os.Stderr, "log file %s: %v\n", path, err)
	}}
}

// setRoot sets the folder of the log files ("" = none).
func (l *fileLogs) setRoot(dir string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.home = dir
	l.applyLocked()
}

// setEnabled turns writing to files on or off (the folder is kept).
func (l *fileLogs) setEnabled(on bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.off = !on
	l.applyLocked()
}

func (l *fileLogs) enabled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.off
}

func (l *fileLogs) applyLocked() {
	dir := l.home
	if l.off {
		dir = ""
	}
	if dir == l.root {
		return
	}
	l.closeAllLocked()
	l.root = dir
	if dir != "" && l.stop == nil {
		l.stop = make(chan struct{})
		go l.flusher(l.stop)
	}
}

func (l *fileLogs) rootDir() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.root
}

func (l *fileLogs) flusher(stop chan struct{}) {
	t := time.NewTicker(logFlushEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			l.mu.Lock()
			for p, f := range l.files {
				f.w.Flush()
				if now.Sub(f.last) > logIdleClose {
					f.f.Close()
					delete(l.files, p)
				}
			}
			l.mu.Unlock()
		}
	}
}

// close flushes and closes every file and stops the flusher.
func (l *fileLogs) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeAllLocked()
	if l.stop != nil {
		close(l.stop)
		l.stop = nil
	}
}

func (l *fileLogs) closeAllLocked() {
	for p, f := range l.files {
		f.w.Flush()
		f.f.Close()
		delete(l.files, p)
	}
}

// path is where a service's log goes ("" when log files are off).
func (l *fileLogs) path(wsKey, service string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.root == "" || wsKey == "" {
		return ""
	}
	return filepath.Join(l.root, wsKey, service+".log")
}

func (l *fileLogs) write(wsKey, service string, e Entry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.root == "" || wsKey == "" {
		return
	}
	p := filepath.Join(l.root, wsKey, service+".log")
	line := formatFileLine(e)
	f := l.files[p]
	if f != nil && f.size+int64(len(line)) > MaxLogFileBytes/2 {
		f.w.Flush()
		f.f.Close()
		delete(l.files, p)
		os.Rename(p, p+".1") // replaces the previous .1
		f = nil
	}
	if f == nil {
		var err error
		if f, err = openLogFile(p); err != nil {
			if !l.failed[p] && l.onError != nil {
				l.failed[p] = true
				go l.onError(p, err)
			}
			return
		}
		delete(l.failed, p)
		l.files[p] = f
		if f.size+int64(len(line)) > MaxLogFileBytes/2 && f.size > 0 {
			// an old, already full file: rotate it before the first write
			f.f.Close()
			delete(l.files, p)
			os.Rename(p, p+".1")
			if f, err = openLogFile(p); err != nil {
				return
			}
			l.files[p] = f
		}
	}
	n, _ := f.w.WriteString(line)
	f.size += int64(n)
	f.last = time.Now()
}

func openLogFile(p string) (*logFile, error) {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	var size int64
	if st, err := f.Stat(); err == nil {
		size = st.Size()
	}
	return &logFile{path: p, f: f, w: bufio.NewWriterSize(f, 32*1024), size: size, last: time.Now()}, nil
}

func formatFileLine(e Entry) string {
	var b strings.Builder
	b.WriteString(time.UnixMilli(e.Time).Format("2006-01-02 15:04:05.000"))
	b.WriteByte(' ')
	b.WriteString(e.Stream)
	b.WriteString(strings.Repeat(" ", max(1, 4-len(e.Stream))))
	b.WriteString(StripANSI(e.Line))
	b.WriteByte('\n')
	return b.String()
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// workspaceKey names the log folder of a workspace: its folder name plus a
// short hash of the config path, so two "api" workspaces don't mix.
func workspaceKey(cfgPath string) string {
	if cfgPath == "" {
		return ""
	}
	abs, err := filepath.Abs(cfgPath)
	if err != nil {
		abs = cfgPath
	}
	sum := sha1.Sum([]byte(filepath.Clean(abs)))
	name := unsafeName.ReplaceAllString(filepath.Base(filepath.Dir(abs)), "_")
	if name == "" || name == "." || name == "_" {
		name = "workspace"
	}
	return name + "-" + hex.EncodeToString(sum[:])[:8]
}
