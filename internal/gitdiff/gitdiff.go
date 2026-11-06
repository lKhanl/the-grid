// Package gitdiff reads the local changes of a git working tree (read-only):
// the changed files and a unified diff per file, like IntelliJ's Local Changes.
package gitdiff

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	emptyTree  = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
	maxDiff    = 2 << 20 // bytes of diff text sent to the UI
	maxCount   = 2 << 20 // untracked files bigger than this are not line-counted
	gitTimeout = 20 * time.Second
)

// File is one changed file.
type File struct {
	Path      string `json:"path"`   // slash separated, relative to the repo root
	Status    string `json:"status"` // M modified, A added, D deleted, U untracked
	Staged    bool   `json:"staged"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary,omitempty"`
}

// Changes is the state of one working tree against HEAD.
type Changes struct {
	Branch string `json:"branch"`
	Files  []File `json:"files"`
}

// Diff is the unified diff of a single file.
type Diff struct {
	Text      string `json:"diff"`
	Binary    bool   `json:"binary,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

func git(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	c := exec.CommandContext(ctx, "git", append([]string{"-c", "core.quotepath=false", "-c", "color.ui=false"}, args...)...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var out, errb bytes.Buffer
	c.Stdout, c.Stderr = &out, &errb
	err := c.Run()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return out.Bytes(), fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(errb.String()))
		}
		if errors.Is(err, exec.ErrNotFound) {
			return nil, errors.New("git was not found on PATH")
		}
		return nil, err
	}
	return out.Bytes(), nil
}

// Root returns the top-level folder of the repository containing dir ("" if none).
func Root(dir string) (string, error) {
	out, err := git(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return filepath.Clean(strings.TrimSpace(string(out))), nil
}

// Branch returns the current branch (or a short commit id when detached).
func Branch(root string) string {
	if out, err := git(root, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		if b := strings.TrimSpace(string(out)); b != "" {
			return b
		}
	}
	if out, err := git(root, "rev-parse", "--short", "HEAD"); err == nil {
		return "(" + strings.TrimSpace(string(out)) + ")"
	}
	return "(no commits)"
}

func base(root string) string {
	if _, err := git(root, "rev-parse", "--verify", "-q", "HEAD"); err != nil {
		return emptyTree
	}
	return "HEAD"
}

// Status lists every changed file (staged, unstaged and untracked) against HEAD.
func Status(root string) (Changes, error) {
	res := Changes{Branch: Branch(root), Files: []File{}}
	out, err := git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
	if err != nil {
		return res, err
	}
	byPath := map[string]*File{}
	for _, rec := range strings.Split(string(out), "\x00") {
		if len(rec) < 4 {
			continue
		}
		x, y, p := rec[0], rec[1], rec[3:]
		f := &File{Path: p, Staged: x != ' ' && x != '?'}
		switch {
		case x == '?' && y == '?':
			f.Status = "U"
		case x == 'D' || y == 'D':
			f.Status = "D"
		case x == 'A':
			f.Status = "A"
		default:
			f.Status = "M"
		}
		byPath[p] = f
	}
	nums, err := git(root, "diff", base(root), "--numstat", "-z", "--no-renames")
	if err == nil {
		for _, rec := range strings.Split(string(nums), "\x00") {
			parts := strings.SplitN(rec, "\t", 3)
			if len(parts) != 3 {
				continue
			}
			f := byPath[parts[2]]
			if f == nil {
				continue
			}
			if parts[0] == "-" {
				f.Binary = true
				continue
			}
			f.Additions, _ = strconv.Atoi(parts[0])
			f.Deletions, _ = strconv.Atoi(parts[1])
		}
	}
	for _, f := range byPath {
		if f.Status == "U" {
			f.Additions, f.Binary = countLines(filepath.Join(root, filepath.FromSlash(f.Path)))
		}
		res.Files = append(res.Files, *f)
	}
	sort.Slice(res.Files, func(i, j int) bool { return res.Files[i].Path < res.Files[j].Path })
	return res, nil
}

func countLines(path string) (lines int, binary bool) {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || st.Size() > maxCount {
		return 0, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	head := b
	if len(head) > 8000 {
		head = head[:8000]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return 0, true
	}
	lines = bytes.Count(b, []byte{'\n'})
	if len(b) > 0 && b[len(b)-1] != '\n' {
		lines++
	}
	return lines, false
}

// FileDiff returns the unified diff of one file against HEAD. rel must be a
// path inside the repository, as listed by Status.
func FileDiff(root, rel string) (Diff, error) {
	rel = filepath.ToSlash(rel)
	if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "\x00") {
		return Diff{}, errors.New("bad path")
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return Diff{}, errors.New("bad path")
		}
	}
	st, err := Status(root)
	if err != nil {
		return Diff{}, err
	}
	var file *File
	for i := range st.Files {
		if st.Files[i].Path == rel {
			file = &st.Files[i]
			break
		}
	}
	if file == nil {
		return Diff{}, errors.New("file has no changes")
	}
	if file.Binary {
		return Diff{Binary: true}, nil
	}
	var out []byte
	if file.Status == "U" {
		// --no-index exits with 1 when the files differ.
		out, err = git(root, "diff", "--no-index", "--no-color", "-U6", "--", os.DevNull, rel)
		if err != nil && len(out) == 0 {
			return Diff{}, err
		}
	} else {
		out, err = git(root, "diff", base(root), "--no-color", "--no-renames", "-U6", "--", rel)
		if err != nil {
			return Diff{}, err
		}
	}
	d := Diff{}
	if len(out) > maxDiff {
		out, d.Truncated = out[:maxDiff], true
	}
	d.Text = string(out)
	return d, nil
}
