package gitdiff

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func repo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		c := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=t"}, args...)...)
		c.Dir = dir
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(n, s string) { os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644) }
	run("init", "-q")
	write("a.txt", "one\ntwo\n")
	write("gone.txt", "x\n")
	write("bin.dat", "a\x00b")
	run("add", ".")
	run("commit", "-q", "-m", "first")
	write("a.txt", "one\nTWO\n")
	write("bin.dat", "a\x00c")
	write("new.txt", "fresh\n")
	write("blob.bin", "\x00\x01\x02")
	os.Remove(filepath.Join(dir, "gone.txt"))
	return dir
}

func TestFileDiffAskedForOnePath(t *testing.T) {
	dir := repo(t)
	ctx := context.Background()
	d, err := FileDiff(ctx, dir, "a.txt")
	if err != nil || !strings.Contains(d.Text, "+TWO") || d.Binary {
		t.Fatalf("modified: %v %+v", err, d)
	}
	d, err = FileDiff(ctx, dir, "new.txt")
	if err != nil || !strings.Contains(d.Text, "+fresh") {
		t.Fatalf("untracked: %v %+v", err, d)
	}
	d, err = FileDiff(ctx, dir, "gone.txt")
	if err != nil || !strings.Contains(d.Text, "-x") {
		t.Fatalf("deleted: %v %+v", err, d)
	}
	if d, err = FileDiff(ctx, dir, "bin.dat"); err != nil || !d.Binary {
		t.Fatalf("tracked binary: %v %+v", err, d)
	}
	if d, err = FileDiff(ctx, dir, "blob.bin"); err != nil || !d.Binary {
		t.Fatalf("untracked binary: %v %+v", err, d)
	}
	if _, err = FileDiff(ctx, dir, "../x"); err == nil {
		t.Fatal("path escape must fail")
	}
	if _, err = FileDiff(ctx, dir, "nothing.txt"); err == nil {
		t.Fatal("unchanged file must fail")
	}
}

func TestFileDiffStopsWithItsRequest(t *testing.T) {
	dir := repo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := FileDiff(ctx, dir, "a.txt"); err == nil {
		t.Fatal("a cancelled request must not run git")
	}
}

func TestCountUntracked(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("1\n2\n3"), 0o644)
	os.WriteFile(filepath.Join(root, "b.bin"), []byte{1, 0, 2}, 0o644)
	files := []File{{Path: "a.txt", Status: "U"}, {Path: "b.bin", Status: "U"}, {Path: "a.txt", Status: "M", Additions: 7}, {Path: "gone.txt", Status: "U"}}
	CountUntracked(root, files)
	if files[0].Additions != 3 || files[0].Binary || !files[1].Binary || files[2].Additions != 7 || files[3].Additions != 0 {
		t.Fatalf("got %+v", files)
	}

	// remembered: the file is not read again while its size and time stay the same
	p := filepath.Join(root, "a.txt")
	st, _ := os.Stat(p)
	os.WriteFile(p, []byte("1\n2\nX"), 0o644) // same size, other content
	os.Chtimes(p, st.ModTime(), st.ModTime())
	again := []File{{Path: "a.txt", Status: "U"}}
	CountUntracked(root, again)
	if again[0].Additions != 3 {
		t.Fatalf("unchanged file: got %d lines", again[0].Additions)
	}
	// ... and read again once it changed
	os.WriteFile(p, []byte("1\n2\n3\n4\n"), 0o644)
	CountUntracked(root, again)
	if again[0].Additions != 4 {
		t.Fatalf("changed file: got %d lines, want 4", again[0].Additions)
	}
}

// One call reads a limited amount; the files it left out are counted by the next calls.
func TestCountUntrackedBudget(t *testing.T) {
	root := t.TempDir()
	big := bytes.Repeat([]byte("x\n"), maxCount/2) // as large as a counted file gets
	n := countBudget/maxCount + 3
	var files []File
	for i := 0; i < n; i++ {
		name := fmt.Sprintf("f%02d.txt", i)
		os.WriteFile(filepath.Join(root, name), big, 0o644)
		files = append(files, File{Path: name, Status: "U"})
	}
	counted := func() (c int) {
		for i := range files {
			if files[i].Additions > 0 {
				c++
			}
			files[i].Additions = 0
		}
		return c
	}
	CountUntracked(root, files)
	if c := counted(); c != countBudget/maxCount {
		t.Fatalf("first call counted %d files, want %d", c, countBudget/maxCount)
	}
	CountUntracked(root, files)
	if c := counted(); c != n {
		t.Fatalf("second call: %d of %d files have a count", c, n)
	}
}
