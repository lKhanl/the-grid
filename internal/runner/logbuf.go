package runner

import (
	"regexp"
	"sync"
	"time"
	"unicode/utf8"
)

// Entry is one log line.
type Entry struct {
	Seq    uint64 `json:"seq"`
	Time   int64  `json:"t"` // unix millis
	Stream string `json:"s"` // out | err | sys
	Line   string `json:"line"`
}

// LogBuffer keeps the last N lines of a service.
type LogBuffer struct {
	mu      sync.Mutex
	max     int
	next    uint64
	entries []Entry
}

func NewLogBuffer(max int) *LogBuffer { return &LogBuffer{max: max} }

func (b *LogBuffer) Add(stream, line string) Entry {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.next++
	e := Entry{Seq: b.next, Time: time.Now().UnixMilli(), Stream: stream, Line: line}
	b.entries = append(b.entries, e)
	if len(b.entries) > b.max+b.max/4 {
		b.entries = append([]Entry(nil), b.entries[len(b.entries)-b.max:]...)
	}
	return e
}

// SetMax changes the limit; a lower one drops the oldest lines right away.
func (b *LogBuffer) SetMax(n int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.max = n
	if len(b.entries) > n {
		b.entries = append([]Entry(nil), b.entries[len(b.entries)-n:]...)
	}
}

func (b *LogBuffer) Tail(n int) []Entry {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n <= 0 || n > len(b.entries) {
		n = len(b.entries)
	}
	if n > b.max { // the slack above max only exists to avoid copying on every line
		n = b.max
	}
	return append([]Entry(nil), b.entries[len(b.entries)-n:]...)
}

func (b *LogBuffer) Clear() {
	b.mu.Lock()
	b.entries = nil
	b.mu.Unlock()
}

var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]`)

// StripANSI removes terminal escape sequences.
func StripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

// cp1254 (Windows Turkish) bytes 0x80-0x9F. 0xA0-0xFF is Latin-1 except six Turkish letters.
var cp1254Low = [32]rune{
	0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0xFFFD, 0xFFFD,
	0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0xFFFD, 0x0178,
}

func cp1254Rune(b byte) rune {
	switch {
	case b < 0x80:
		return rune(b)
	case b < 0xA0:
		return cp1254Low[b-0x80]
	}
	switch b {
	case 0xD0:
		return 'Ğ'
	case 0xDD:
		return 'İ'
	case 0xDE:
		return 'Ş'
	case 0xF0:
		return 'ğ'
	case 0xFD:
		return 'ı'
	case 0xFE:
		return 'ş'
	}
	return rune(b)
}

// decode turns raw process output into a UTF-8 string.
// "auto" keeps valid UTF-8 as is and falls back to cp1254 otherwise.
func decode(b []byte, enc string) string {
	if enc == "utf-8" || (enc == "auto" && utf8.Valid(b)) {
		return string(b)
	}
	out := make([]rune, len(b))
	for i, c := range b {
		out[i] = cp1254Rune(c)
	}
	return string(out)
}
