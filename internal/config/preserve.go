package config

// Keeping the user's formatting when the UI writes grid.yaml.
//
// yaml.v3 re-encodes the whole file in its own style: `{ a: 1 }` becomes
// `{a: 1}`, aligned trailing comments lose their alignment and blank lines go.
// preserveLayout instead walks the old and the new tree side by side and
// copies every entry whose value did not change straight from the original
// text. Only the entries that really changed are encoded, so saving a form
// without changes leaves the file byte for byte as it was.

import (
	"bytes"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
)

// preserveLayout returns the text of newDoc laid out like orig, or ok=false
// when it cannot do that safely (the caller then encodes newDoc as a whole).
func preserveLayout(orig []byte, newDoc *yaml.Node) (out []byte, ok bool) {
	if bytes.Contains(orig, []byte("\t")) || bytes.Contains(orig, []byte("\r")) {
		return nil, false // keep the merge simple: spaces and \n only
	}
	var oldDoc yaml.Node
	if err := yaml.Unmarshal(orig, &oldDoc); err != nil || oldDoc.Kind != yaml.DocumentNode || len(oldDoc.Content) != 1 {
		return nil, false
	}
	if newDoc.Kind != yaml.DocumentNode || len(newDoc.Content) != 1 {
		return nil, false
	}
	oldRoot, newRoot := oldDoc.Content[0], newDoc.Content[0]
	if !isBlockMapping(oldRoot) || newRoot.Kind != yaml.MappingNode {
		return nil, false
	}

	lines := strings.Split(strings.TrimSuffix(string(orig), "\n"), "\n")
	m := merger{lines: lines}
	m.mapping(oldRoot, newRoot, 0, len(lines), 0, true)
	if m.failed {
		return nil, false
	}
	res := strings.Join(trimBlankTail(m.out), "\n") + "\n"

	// the merge must mean exactly what the edited tree means
	var got yaml.Node
	if err := yaml.Unmarshal([]byte(res), &got); err != nil || !sameValue(&got, newDoc) {
		return nil, false
	}
	return []byte(res), true
}

type merger struct {
	lines  []string
	out    []string
	failed bool
}

// chunk is the original text of one mapping entry: its head comments, the
// key line and the value, then the blank lines that follow it.
type chunk struct {
	key, val  *yaml.Node
	start     int // first line (head comments included)
	keyLine   int // line of the key
	end       int // end of the entry, trailing blank lines excluded
	trailing  int // blank lines after the entry
	spaceNext bool
}

// mapping writes the entries of newM, using the original lines [lo, hi) that
// hold oldM. indent is the column of oldM's keys.
func (m *merger) mapping(oldM, newM *yaml.Node, lo, hi, indent int, spacedDefault bool) {
	chunks := m.chunks(oldM, lo, hi)
	if m.failed {
		return
	}
	if len(chunks) > 0 {
		indent = chunks[0].key.Column - 1
	}
	// the text before the first entry (file header, ...)
	prefixEnd := hi
	if len(chunks) > 0 {
		prefixEnd = chunks[0].start
	}
	m.out = append(m.out, m.lines[lo:prefixEnd]...)
	if len(chunks) == 0 {
		// nothing to anchor to: emit every entry as new
		prefixEnd = trimBlankEnd(m.lines, lo, hi)
		m.out = m.out[:len(m.out)-(hi-prefixEnd)]
	}

	// entries separated by blank lines (top level, services) stay that way
	spaced := spacedDefault
	if len(chunks) > 1 {
		spaced = false
		for _, c := range chunks[:len(chunks)-1] {
			if c.trailing > 0 {
				spaced = true
			}
		}
	}

	byKey := map[string]*chunk{}
	for i := range chunks {
		byKey[chunks[i].key.Value] = &chunks[i]
	}
	lastTrailing := 0
	if len(chunks) > 0 {
		lastTrailing = chunks[len(chunks)-1].trailing
	} else {
		lastTrailing = hi - prefixEnd
	}

	prevFlexible := false // the previous entry did not bring its own blank lines
	for j := 0; j+1 < len(newM.Content); j += 2 {
		k, v := newM.Content[j], newM.Content[j+1]
		c := byKey[k.Value]
		isNew := c == nil
		if j > 0 && spaced && (prevFlexible || isNew) && !endsBlank(m.out) {
			m.out = append(m.out, "")
		}
		if isNew {
			m.out = append(m.out, encodeEntry(k, v, indent, nil, nil)...)
			prevFlexible = true
			continue
		}
		delete(byKey, k.Value) // a key written twice is encoded the second time
		m.entry(c, k, v)
		if c == &chunks[len(chunks)-1] {
			prevFlexible = true
		} else {
			m.out = append(m.out, make([]string, c.trailing)...)
			prevFlexible = c.trailing == 0
		}
	}
	m.out = append(m.out, make([]string, lastTrailing)...)
}

// entry writes one entry that exists in the original text.
func (m *merger) entry(c *chunk, k, v *yaml.Node) {
	if k.Value == c.key.Value && sameValue(c.val, v) {
		m.out = append(m.out, m.lines[c.start:c.end]...)
		return
	}
	head := m.lines[c.start:c.keyLine]
	if isBlockMapping(c.val) && v.Kind == yaml.MappingNode && c.val.Line > c.key.Line {
		// recurse: only the changed keys inside are rewritten
		m.out = append(m.out, head...)
		m.out = append(m.out, m.lines[c.keyLine])
		m.mapping(c.val, v, c.keyLine+1, c.end, c.key.Column-1+2, false)
		m.out = trimBlankTail(m.out)
		return
	}
	// rewrite the entry; keep its head comments and the comments after it
	valEnd := c.end
	for valEnd > c.keyLine+1 && isCommentOrBlank(m.lines[valEnd-1]) {
		valEnd--
	}
	tail := m.lines[valEnd:c.end]
	m.out = append(m.out, head...)
	m.out = append(m.out, encodeEntry(k, v, c.key.Column-1, c.key, c.val)...)
	m.out = append(m.out, tail...)
}

func (m *merger) chunks(mp *yaml.Node, lo, hi int) []chunk {
	var cs []chunk
	for i := 0; i+1 < len(mp.Content); i += 2 {
		k := mp.Content[i]
		if k.Kind != yaml.ScalarNode || k.Line < 1 || k.Line-1 < lo || k.Line-1 >= hi {
			m.failed = true
			return nil
		}
		kl := k.Line - 1
		start := kl
		ind := k.Column - 1
		for start-1 >= lo && isComment(m.lines[start-1]) && indentOf(m.lines[start-1]) == ind {
			if len(cs) > 0 && start-1 <= cs[len(cs)-1].keyLine {
				break
			}
			start--
		}
		cs = append(cs, chunk{key: k, val: mp.Content[i+1], start: start, keyLine: kl})
	}
	for i := range cs {
		end := hi
		if i+1 < len(cs) {
			end = cs[i+1].start
		}
		body := trimBlankEnd(m.lines, cs[i].keyLine+1, end)
		cs[i].end, cs[i].trailing = body, end-body
	}
	return cs
}

// encodeEntry encodes `key: value` at the given indent. When the entry
// replaces an old one, its comments come from the original text (head and
// trailing lines), so only the line comment is carried over here.
func encodeEntry(k, v *yaml.Node, indent int, oldK, oldV *yaml.Node) []string {
	kc, vc := *k, *v
	if oldK != nil {
		kc.HeadComment, kc.FootComment, vc.HeadComment = "", "", ""
		if kc.LineComment == "" && vc.LineComment == "" {
			kc.LineComment, vc.LineComment = oldK.LineComment, oldV.LineComment
		}
		vc = *stripFoot(&vc)
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{&kc, &vc}}); err != nil {
		return nil // impossible for trees that came from yaml; the final check catches it
	}
	enc.Close()
	pad := strings.Repeat(" ", indent)
	var out []string
	for _, l := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		if l != "" {
			l = pad + l
		}
		out = append(out, l)
	}
	return out
}

// stripFoot returns a copy of n without foot comments, which stay in the
// original text after the entry.
func stripFoot(n *yaml.Node) *yaml.Node {
	c := *n
	c.FootComment = ""
	if len(n.Content) > 0 {
		c.Content = make([]*yaml.Node, len(n.Content))
		for i, ch := range n.Content {
			c.Content[i] = stripFoot(ch)
		}
	}
	return &c
}

// sameValue reports whether two nodes mean the same, key order included;
// style and comments do not count.
func sameValue(a, b *yaml.Node) bool {
	for a.Kind == yaml.AliasNode && a.Alias != nil {
		a = a.Alias
	}
	for b.Kind == yaml.AliasNode && b.Alias != nil {
		b = b.Alias
	}
	if a.Kind != b.Kind || len(a.Content) != len(b.Content) {
		return false
	}
	if a.Kind == yaml.ScalarNode {
		var x, y any
		if a.Decode(&x) != nil || b.Decode(&y) != nil {
			return false
		}
		return reflect.DeepEqual(x, y)
	}
	for i := range a.Content {
		if !sameValue(a.Content[i], b.Content[i]) {
			return false
		}
	}
	return true
}

func isBlockMapping(n *yaml.Node) bool {
	return n.Kind == yaml.MappingNode && n.Style&yaml.FlowStyle == 0
}

func isComment(l string) bool { return strings.HasPrefix(strings.TrimLeft(l, " "), "#") }

func isCommentOrBlank(l string) bool { return strings.TrimSpace(l) == "" || isComment(l) }

func indentOf(l string) int { return len(l) - len(strings.TrimLeft(l, " ")) }

func endsBlank(out []string) bool { return len(out) == 0 || strings.TrimSpace(out[len(out)-1]) == "" }

func trimBlankEnd(lines []string, lo, hi int) int {
	for hi > lo && strings.TrimSpace(lines[hi-1]) == "" {
		hi--
	}
	return hi
}

func trimBlankTail(out []string) []string {
	return out[:trimBlankEnd(out, 0, len(out))]
}
