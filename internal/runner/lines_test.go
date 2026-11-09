package runner

import (
	"io"
	"strings"
	"testing"
	"unicode/utf8"
)

func linesOf(in string, max int) []string {
	var out []string
	readLines(strings.NewReader(in), max, func(b []byte) { out = append(out, string(b)) })
	return out
}

func TestReadLinesPlain(t *testing.T) {
	got := linesOf("one\r\ntwo\n\nlast", 64)
	want := []string{"one", "two", "", "last"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got := linesOf("", 64); len(got) != 0 {
		t.Fatalf("empty input: got %q", got)
	}
}

func TestReadLinesCutsLongLines(t *testing.T) {
	long := strings.Repeat("x", 1000)
	got := linesOf(long+"\nnext\n", 64)
	if len(got) < 1000/64 || got[len(got)-1] != "next" {
		t.Fatalf("got %d pieces, last %q", len(got), got[len(got)-1])
	}
	for _, p := range got {
		if len(p) > 64+utf8.UTFMax {
			t.Fatalf("piece of %d bytes", len(p))
		}
	}
	if strings.Join(got[:len(got)-1], "") != long {
		t.Fatal("the pieces do not add up to the line")
	}
}

// A cut must not split a character: a piece that is not valid UTF-8 would be read as cp1254.
func TestReadLinesKeepsCharactersWhole(t *testing.T) {
	for _, pad := range []string{"", "a", "ab", "abc"} {
		long := pad + strings.Repeat("ğüş€😀", 200)
		got := linesOf(long+"\r\n", 32)
		for _, p := range got {
			if !utf8.ValidString(p) {
				t.Fatalf("pad %q: piece is not valid UTF-8: %q", pad, p)
			}
		}
		if strings.Join(got, "") != long {
			t.Fatalf("pad %q: the pieces do not add up to the line", pad)
		}
	}
}

// \r\n falling exactly on a cut must not leave an empty extra line.
func TestReadLinesLineEndOnTheCut(t *testing.T) {
	got := linesOf(strings.Repeat("x", 31)+"\r\nnext\n", 32)
	if len(got) != 2 || got[0] != strings.Repeat("x", 31) || got[1] != "next" {
		t.Fatalf("got %q", got)
	}
	got = linesOf(strings.Repeat("x", 32)+"\nnext\n\nend", 32)
	if len(got) != 4 || got[1] != "next" || got[2] != "" || got[3] != "end" {
		t.Fatalf("got %q", got)
	}
}

// An endless line must be handed over piece by piece, not collected.
func TestReadLinesEndlessLine(t *testing.T) {
	pr, pw := io.Pipe()
	go func() {
		b := []byte(strings.Repeat("=", 4096))
		for i := 0; i < 2048; i++ { // 8 MB, no line end
			pw.Write(b)
		}
		pw.Close()
	}()
	total, biggest := 0, 0
	readLines(pr, maxLogLine, func(b []byte) {
		total += len(b)
		biggest = max(biggest, len(b))
	})
	if total != 8<<20 || biggest > maxLogLine+utf8.UTFMax {
		t.Fatalf("total %d, biggest piece %d", total, biggest)
	}
}
