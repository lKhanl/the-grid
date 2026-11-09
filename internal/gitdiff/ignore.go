package gitdiff

import (
	"path"
	"strings"
)

// Ignore holds patterns for paths the Changes view leaves out, without telling git (tracked and
// untracked files alike). The rules follow .gitignore where it matters:
//
//	*.iml          no slash: a file or folder with that name at any depth
//	tmp/           trailing slash: only a folder (everything under it)
//	src/app.yml    a slash inside: relative to the base folder (a leading / is allowed)
//	**/gen/*.java  ** spans any number of folders; * and ? stay inside one name
//
// A pattern that matches a folder hides everything under it.
type Ignore struct{ pats []ignorePat }

type ignorePat struct {
	raw     string
	segs    []string
	dirOnly bool
	any     bool // no slash: match one name at any depth
}

// NewIgnore compiles the patterns; empty lines and lines starting with # are skipped.
func NewIgnore(patterns []string) *Ignore {
	ig := &Ignore{}
	for _, raw := range patterns {
		p := strings.TrimSpace(strings.ReplaceAll(raw, `\`, "/"))
		if p == "" || strings.HasPrefix(p, "#") {
			continue
		}
		ip := ignorePat{raw: raw}
		if strings.HasSuffix(p, "/") {
			ip.dirOnly = true
			p = strings.TrimRight(p, "/")
		}
		ip.any = !strings.Contains(p, "/")
		p = strings.TrimPrefix(p, "/")
		if p == "" {
			continue
		}
		ip.segs = strings.Split(p, "/")
		ig.pats = append(ig.pats, ip)
	}
	return ig
}

// Match returns the pattern that hides rel (slash separated, relative to the base folder), or "".
func (ig *Ignore) Match(rel string) string {
	if ig == nil || rel == "" {
		return ""
	}
	segs := strings.Split(rel, "/")
	for _, p := range ig.pats {
		if p.any {
			// a single name, against every folder name, and the file name unless only folders count
			last := len(segs)
			if p.dirOnly {
				last--
			}
			for _, s := range segs[:max(last, 0)] {
				if matchName(p.segs[0], s) {
					return p.raw
				}
			}
			continue
		}
		if matchSegs(p.segs, segs, p.dirOnly) {
			return p.raw
		}
	}
	return ""
}

// matchSegs matches the pattern against the start of the path: matching a whole path, or a
// folder the path is under, counts (a folder-only pattern must leave at least one name below it).
func matchSegs(pat, segs []string, dirOnly bool) bool {
	if len(pat) == 0 {
		return !dirOnly || len(segs) > 0
	}
	if pat[0] == "**" {
		for i := 0; i <= len(segs); i++ {
			if matchSegs(pat[1:], segs[i:], dirOnly) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	if !matchName(pat[0], segs[0]) {
		return false
	}
	if len(pat) == 1 {
		return !dirOnly || len(segs) > 1
	}
	return matchSegs(pat[1:], segs[1:], dirOnly)
}

// matchName matches one file or folder name. The name itself always matches: "Hide from
// Changes" stores the path as it is, and a name such as [id] (a Next.js route folder) read
// as a pattern is a character class that does not match its own text.
func matchName(pat, name string) bool {
	if pat == name {
		return true
	}
	ok, _ := path.Match(pat, name)
	return ok
}
