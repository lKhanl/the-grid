package gitdiff

import (
	"context"
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
