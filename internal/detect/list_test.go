package detect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListYamlFiles(t *testing.T) {
	d := t.TempDir()
	for _, n := range []string{"abc.yml", "Grid.YAML", "notes.txt", ".hidden.yml"} {
		os.WriteFile(filepath.Join(d, n), nil, 0o644)
	}
	os.Mkdir(filepath.Join(d, "sub.yml"), 0o755) // a folder, not a file
	l := List(d)
	if len(l.Files) != 2 || l.Files[0] != "abc.yml" || l.Files[1] != "Grid.YAML" {
		t.Fatalf("files = %v", l.Files)
	}
	if len(l.Dirs) != 1 || l.Dirs[0].Name != "sub.yml" {
		t.Fatalf("dirs = %v", l.Dirs)
	}
}
