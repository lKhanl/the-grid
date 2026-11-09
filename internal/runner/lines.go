package runner

import (
	"bufio"
	"bytes"
	"io"
	"unicode/utf8"
)

// maxLogLine is the longest log line kept in one piece (bytes). Output without
// a line end (a progress bar that only writes \r, one huge JSON document,
// binary data sent to stdout) would otherwise grow in memory without limit and
// then travel as one entry through the buffer, the log file and every browser.
const maxLogLine = 64 << 10

// readLines calls emit for every line of r, without its line end, until r
// ends. A line longer than max bytes arrives as several pieces. A piece never
// ends in the middle of a UTF-8 character (the cut-off start moves to the next
// piece), so a long UTF-8 line is not mistaken for cp1254 by decode. The slice
// given to emit is only valid during the call.
func readLines(r io.Reader, max int, emit func(line []byte)) {
	br := bufio.NewReaderSize(r, max)
	var carry []byte // bytes held back from the previous piece
	rest := false    // the previous piece was cut: this one continues its line
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 || len(carry) > 0 {
			line := chunk
			if len(carry) > 0 {
				line = append(carry, chunk...)
				carry = nil
			}
			cut := err == bufio.ErrBufferFull
			if cut {
				if n := heldBack(line); n > 0 {
					carry = bytes.Clone(line[len(line)-n:])
					line = line[:len(line)-n]
				}
			} else {
				line = bytes.TrimRight(line, "\r\n")
			}
			// a line that ends exactly on a cut leaves only its line end behind: not a line of its own
			if len(line) > 0 || !rest {
				emit(line)
			}
			rest = cut
		}
		if err != nil && err != bufio.ErrBufferFull {
			return
		}
	}
}

// heldBack is how many bytes at the end of a cut piece belong to the next one:
// the start of a UTF-8 character whose rest has not arrived, or a \r that may
// be the first half of a \r\n line end.
func heldBack(b []byte) int {
	if len(b) > 0 && b[len(b)-1] == '\r' {
		return 1
	}
	for i := 1; i <= utf8.UTFMax-1 && i <= len(b); i++ {
		c := b[len(b)-i]
		if c < utf8.RuneSelf {
			return 0
		}
		if utf8.RuneStart(c) {
			if utf8.FullRune(b[len(b)-i:]) {
				return 0
			}
			return i
		}
	}
	return 0
}
