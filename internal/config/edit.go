package config

// Editing grid.yaml from the UI. The file is edited as a YAML node tree,
// so keys and comments that the form does not touch survive. Every write
// is validated with Load before it replaces the file, and the previous
// version is kept as grid.yaml.bak.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// EnvVar keeps env order stable in JSON.
type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// SpringSpec, NodeSpec and ScriptSpec mirror the typed blocks in JSON.
type SpringSpec struct {
	Module    string   `json:"module"`
	Profiles  []string `json:"profiles"`
	JvmArgs   string   `json:"jvmArgs"`
	Args      string   `json:"args"`
	Mode      string   `json:"mode"`
	SkipTests bool     `json:"skipTests"`
	Offline   bool     `json:"offline"`
	// AlwaysBuild: no "skip the build when nothing changed"
	AlwaysBuild bool `json:"alwaysBuild"`
}

type NodeSpec struct {
	Script         string `json:"script"`
	Args           string `json:"args"`
	Install        string `json:"install"`
	PackageManager string `json:"packageManager"`
}

type ScriptSpec struct {
	File string `json:"file"`
	Args string `json:"args"`
}

type JarSpec struct {
	File    string `json:"file"`
	JvmArgs string `json:"jvmArgs"`
	Args    string `json:"args"`
}

// ServiceSpec is the editable, as-written form of a service.
type ServiceSpec struct {
	Name         string      `json:"name"`
	Group        string      `json:"group"`
	Description  string      `json:"description"`
	Type         string      `json:"type"`
	Command      string      `json:"command"`
	Spring       *SpringSpec `json:"spring,omitempty"`
	Node         *NodeSpec   `json:"node,omitempty"`
	Script       *ScriptSpec `json:"script,omitempty"`
	Jar          *JarSpec    `json:"jar,omitempty"`
	Cwd          string      `json:"cwd"`
	Shell        string      `json:"shell"`
	Runtime      []string    `json:"runtime"`
	Env          []EnvVar    `json:"env"`
	EnvFile      string      `json:"envFile"`
	Encoding     string      `json:"encoding"`
	DependsOn    []string    `json:"dependsOn"`
	ReadyPort    int         `json:"readyPort"`
	ReadyLog     string      `json:"readyLog"`
	ReadyTimeout string      `json:"readyTimeout"`
	Restart      string      `json:"restart"`
	MaxRestarts  int         `json:"maxRestarts"`
	Autostart    bool        `json:"autostart"`
	StopTimeout  string      `json:"stopTimeout"`
	URL          string      `json:"url"`
}

type rawSpec struct {
	Group       string      `yaml:"group"`
	Description string      `yaml:"description"`
	Type        string      `yaml:"type"`
	Command     string      `yaml:"command"`
	Spring      *SpringOpts `yaml:"spring"`
	Node        *NodeOpts   `yaml:"node"`
	Script      *ScriptOpts `yaml:"script"`
	Jar         *JarOpts    `yaml:"jar"`
	Cwd         string      `yaml:"cwd"`
	Shell       string      `yaml:"shell"`
	Runtime     StringList  `yaml:"runtime"`
	Env         yaml.Node   `yaml:"env"`
	EnvFile     string      `yaml:"env_file"`
	Encoding    string      `yaml:"encoding"`
	DependsOn   StringList  `yaml:"depends_on"`
	Ready       *struct {
		Port    int    `yaml:"port"`
		Log     string `yaml:"log"`
		Timeout string `yaml:"timeout"`
	} `yaml:"ready"`
	Restart     string `yaml:"restart"`
	MaxRestarts int    `yaml:"max_restarts"`
	Autostart   bool   `yaml:"autostart"`
	StopTimeout string `yaml:"stop_timeout"`
	URL         string `yaml:"url"`
}

var (
	editMu   sync.Mutex
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	ErrExist = errors.New("already exists")
)

// keyOrder is used when adding keys to a service.
var keyOrder = []string{"group", "description", "type", "cwd", "command", "spring", "node", "script", "jar", "shell", "runtime", "env", "env_file",
	"encoding", "depends_on", "ready", "restart", "max_restarts", "autostart", "stop_timeout", "url"}

func loadDoc(path string) (*yaml.Node, *yaml.Node, error) {
	doc, root, err := loadRoot(path)
	if err != nil {
		return nil, nil, err
	}
	i := mapIndex(root, "services")
	if i < 0 {
		root.Content = append(root.Content, scalar("services"), &yaml.Node{Kind: yaml.MappingNode})
		i = len(root.Content) - 2
	}
	svcs := root.Content[i+1]
	if svcs.Kind != yaml.MappingNode {
		// e.g. `services:` with nothing under it
		*svcs = yaml.Node{Kind: yaml.MappingNode}
	}
	return doc, svcs, nil
}

func loadRoot(path string) (*yaml.Node, *yaml.Node, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, nil, err
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, nil, fmt.Errorf("%s: top level must be a mapping", path)
	}
	return &doc, root, nil
}

func mapIndex(m *yaml.Node, key string) int {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return i
		}
	}
	return -1
}

func scalar(v string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v} }

func intNode(v int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(v)}
}

// setKey replaces, appends (in keyOrder position) or deletes (v == nil) a key.
func setKey(m *yaml.Node, key string, v *yaml.Node) { setKeyIn(m, keyOrder, key, v) }

func setKeyIn(m *yaml.Node, order []string, key string, v *yaml.Node) {
	i := mapIndex(m, key)
	if v == nil {
		if i >= 0 {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
		}
		return
	}
	if i >= 0 {
		old := m.Content[i+1]
		v.HeadComment, v.LineComment, v.FootComment = old.HeadComment, old.LineComment, old.FootComment
		if old.Kind == v.Kind && (v.Kind == yaml.MappingNode || v.Kind == yaml.SequenceNode) {
			v.Style = old.Style
		}
		m.Content[i+1] = v
		return
	}
	// insert before the first existing key that comes later in keyOrder
	pos := len(m.Content)
	rank := indexOf(order, key)
	for j := 0; j+1 < len(m.Content); j += 2 {
		if r := indexOf(order, m.Content[j].Value); r > rank && rank >= 0 {
			pos = j
			break
		}
	}
	m.Content = append(m.Content[:pos], append([]*yaml.Node{scalar(key), v}, m.Content[pos:]...)...)
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

func strOrNil(s string) *yaml.Node {
	if s == "" {
		return nil
	}
	return scalar(s)
}

func applySpec(m *yaml.Node, s ServiceSpec) {
	setKey(m, "group", strOrNil(s.Group))
	setKey(m, "description", strOrNil(s.Description))
	setKey(m, "cwd", strOrNil(s.Cwd))
	applyType(m, s)
	setKey(m, "shell", strOrNil(s.Shell))

	switch len(s.Runtime) {
	case 0:
		setKey(m, "runtime", nil)
	case 1:
		setKey(m, "runtime", scalar(s.Runtime[0]))
	default:
		setKey(m, "runtime", flowSeq(s.Runtime))
	}

	setKey(m, "env", envNode(s.Env))
	setKey(m, "env_file", strOrNil(s.EnvFile))
	if s.Encoding == "" || s.Encoding == "auto" {
		setKey(m, "encoding", nil)
	} else {
		setKey(m, "encoding", scalar(s.Encoding))
	}
	if len(s.DependsOn) == 0 {
		setKey(m, "depends_on", nil)
	} else {
		setKey(m, "depends_on", flowSeq(s.DependsOn))
	}

	if s.ReadyPort > 0 || s.ReadyLog != "" {
		r := &yaml.Node{Kind: yaml.MappingNode, Style: yaml.FlowStyle}
		if s.ReadyPort > 0 {
			r.Content = append(r.Content, scalar("port"), intNode(s.ReadyPort))
		} else {
			r.Content = append(r.Content, scalar("log"), scalar(s.ReadyLog))
		}
		if s.ReadyTimeout != "" {
			r.Content = append(r.Content, scalar("timeout"), scalar(s.ReadyTimeout))
		}
		setKey(m, "ready", r)
	} else {
		setKey(m, "ready", nil)
	}

	if s.Restart == "" || s.Restart == "no" {
		setKey(m, "restart", nil)
		setKey(m, "max_restarts", nil)
	} else {
		setKey(m, "restart", scalar(s.Restart))
		if s.MaxRestarts > 0 {
			setKey(m, "max_restarts", intNode(s.MaxRestarts))
		} else {
			setKey(m, "max_restarts", nil)
		}
	}
	if s.Autostart {
		setKey(m, "autostart", &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: "true"})
	} else {
		setKey(m, "autostart", nil)
	}
	setKey(m, "stop_timeout", strOrNil(s.StopTimeout))
	setKey(m, "url", strOrNil(s.URL))
}

func boolNode(v bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(v)}
}

// block builds a mapping from key/value pairs, skipping nil values.
func block(kv ...any) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode}
	for i := 0; i+1 < len(kv); i += 2 {
		if v, ok := kv[i+1].(*yaml.Node); ok && v != nil {
			m.Content = append(m.Content, scalar(kv[i].(string)), v)
		}
	}
	if len(m.Content) == 0 {
		return nil
	}
	if len(m.Content) <= 6 {
		m.Style = yaml.FlowStyle
	}
	return m
}

// applyType writes `type` and the matching block, and removes the others.
func applyType(m *yaml.Node, s ServiceSpec) {
	t := strings.TrimSpace(s.Type)
	if t == "" {
		t = TypeCustom
	}
	if t == TypeCustom {
		setKey(m, "type", nil)
		setKey(m, "command", scalar(s.Command))
	} else {
		setKey(m, "type", scalar(t))
		setKey(m, "command", nil)
	}
	var spring, node, script, jar *yaml.Node
	switch t {
	case TypeSpring:
		o := s.Spring
		if o == nil {
			o = &SpringSpec{SkipTests: true}
		}
		var profiles *yaml.Node
		if len(o.Profiles) > 0 {
			profiles = flowSeq(o.Profiles)
		}
		var mode, skip, offline, always *yaml.Node
		if o.Mode == "run" {
			mode = scalar("run")
		}
		if !o.SkipTests {
			skip = boolNode(false)
		}
		if o.Offline {
			offline = boolNode(true)
		}
		if o.AlwaysBuild {
			always = boolNode(true)
		}
		spring = block("module", strOrNil(o.Module), "profiles", profiles, "jvm_args", strOrNil(o.JvmArgs),
			"args", strOrNil(o.Args), "mode", mode, "skip_tests", skip, "offline", offline, "always_build", always)
		if spring == nil {
			spring = &yaml.Node{Kind: yaml.MappingNode, Style: yaml.FlowStyle}
		}
	case TypeNode:
		o := s.Node
		if o == nil {
			o = &NodeSpec{}
		}
		var install, pm *yaml.Node
		if o.Install != "" && o.Install != "if-changed" {
			install = scalar(o.Install)
		}
		if o.PackageManager != "" && o.PackageManager != "auto" {
			pm = scalar(o.PackageManager)
		}
		node = block("script", strOrNil(o.Script), "args", strOrNil(o.Args), "install", install, "package_manager", pm)
	case TypeScript:
		o := s.Script
		if o == nil {
			o = &ScriptSpec{}
		}
		script = block("file", strOrNil(o.File), "args", strOrNil(o.Args))
	case TypeJar:
		o := s.Jar
		if o == nil {
			o = &JarSpec{}
		}
		jar = block("file", strOrNil(o.File), "jvm_args", strOrNil(o.JvmArgs), "args", strOrNil(o.Args))
	}
	setKey(m, "spring", spring)
	setKey(m, "node", node)
	setKey(m, "script", script)
	setKey(m, "jar", jar)
}

func flowSeq(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode, Style: yaml.FlowStyle}
	for _, it := range items {
		n.Content = append(n.Content, scalar(it))
	}
	return n
}

// writeValidated encodes doc, checks it with Load and atomically replaces path.
func writeValidated(path string, doc *yaml.Node) error {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return err
	}
	enc.Close()
	pretty := spaceOut(buf.Bytes())
	buf.Reset()
	buf.Write(pretty)
	tmp := path + ".tmp" // same directory, so relative paths validate correctly
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	if _, err := Load(tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if old, err := os.ReadFile(path); err == nil {
		os.WriteFile(path+".bak", old, 0o644)
	}
	return os.Rename(tmp, path)
}

// ReadSpec returns a service exactly as written in the file.
func ReadSpec(path, name string) (ServiceSpec, error) {
	editMu.Lock()
	defer editMu.Unlock()
	_, svcs, err := loadDoc(path)
	if err != nil {
		return ServiceSpec{}, err
	}
	i := mapIndex(svcs, name)
	if i < 0 {
		return ServiceSpec{}, fmt.Errorf("service %q not found", name)
	}
	var r rawSpec
	if err := svcs.Content[i+1].Decode(&r); err != nil {
		return ServiceSpec{}, err
	}
	s := ServiceSpec{
		Name: name, Group: r.Group, Description: r.Description, Type: r.Type, Command: r.Command, Cwd: r.Cwd,
		Shell: r.Shell, Runtime: r.Runtime, EnvFile: r.EnvFile, Encoding: r.Encoding,
		DependsOn: r.DependsOn, Restart: r.Restart, MaxRestarts: r.MaxRestarts,
		Autostart: r.Autostart, StopTimeout: r.StopTimeout, URL: r.URL,
	}
	if r.Ready != nil {
		s.ReadyPort, s.ReadyLog, s.ReadyTimeout = r.Ready.Port, r.Ready.Log, r.Ready.Timeout
	}
	s.Env = envFromNode(&r.Env)
	if s.Type == "" {
		s.Type = TypeCustom
	}
	if o := r.Spring; o != nil {
		s.Spring = &SpringSpec{Module: o.Module, Profiles: o.Profiles, JvmArgs: o.JvmArgs, Args: o.Args,
			Mode: o.Mode, SkipTests: o.SkipTests == nil || *o.SkipTests, Offline: o.Offline, AlwaysBuild: o.AlwaysBuild}
	}
	if o := r.Node; o != nil {
		s.Node = &NodeSpec{Script: o.Script, Args: o.Args, Install: o.Install, PackageManager: o.PackageManager}
	}
	if o := r.Script; o != nil {
		s.Script = &ScriptSpec{File: o.File, Args: o.Args}
	}
	if o := r.Jar; o != nil {
		s.Jar = &JarSpec{File: o.File, JvmArgs: o.JvmArgs, Args: o.Args}
	}
	return s, nil
}

// SaveService creates (oldName == "") or updates a service. Renames also
// update depends_on references in other services.
func SaveService(path, oldName string, s ServiceSpec) error {
	if !nameRe.MatchString(s.Name) {
		return fmt.Errorf("invalid name %q: use letters, digits, '.', '_' or '-'", s.Name)
	}
	editMu.Lock()
	defer editMu.Unlock()
	doc, svcs, err := loadDoc(path)
	if err != nil {
		return err
	}
	var m *yaml.Node
	if oldName == "" {
		if mapIndex(svcs, s.Name) >= 0 {
			return fmt.Errorf("service %q %w", s.Name, ErrExist)
		}
		m = &yaml.Node{Kind: yaml.MappingNode}
		svcs.Content = append(svcs.Content, scalar(s.Name), m)
	} else {
		i := mapIndex(svcs, oldName)
		if i < 0 {
			return fmt.Errorf("service %q not found", oldName)
		}
		if s.Name != oldName {
			if mapIndex(svcs, s.Name) >= 0 {
				return fmt.Errorf("service %q %w", s.Name, ErrExist)
			}
			svcs.Content[i].Value = s.Name
			renameDeps(svcs, oldName, s.Name)
		}
		m = svcs.Content[i+1]
		if m.Kind != yaml.MappingNode {
			*m = yaml.Node{Kind: yaml.MappingNode}
		}
	}
	applySpec(m, s)
	return writeValidated(path, doc)
}

func renameDeps(svcs *yaml.Node, from, to string) {
	for i := 1; i < len(svcs.Content); i += 2 {
		m := svcs.Content[i]
		if j := mapIndex(m, "depends_on"); j >= 0 {
			d := m.Content[j+1]
			if d.Kind == yaml.ScalarNode && d.Value == from {
				d.Value = to
			}
			for _, it := range d.Content {
				if it.Value == from {
					it.Value = to
				}
			}
		}
	}
}

// DeleteService removes a service unless another one depends on it.
func DeleteService(path, name string) error {
	editMu.Lock()
	defer editMu.Unlock()
	doc, svcs, err := loadDoc(path)
	if err != nil {
		return err
	}
	i := mapIndex(svcs, name)
	if i < 0 {
		return fmt.Errorf("service %q not found", name)
	}
	for j := 0; j+1 < len(svcs.Content); j += 2 {
		if j == i {
			continue
		}
		var r rawSpec
		svcs.Content[j+1].Decode(&r)
		if indexOf(r.DependsOn, name) >= 0 {
			return fmt.Errorf("%q depends on %q; remove that dependency first", svcs.Content[j].Value, name)
		}
	}
	svcs.Content = append(svcs.Content[:i], svcs.Content[i+2:]...)
	return writeValidated(path, doc)
}

// ---- runtimes ----

// RuntimeSpec is the editable form of a runtime.
type RuntimeSpec struct {
	Name string   `json:"name"`
	Type string   `json:"type"`
	Home string   `json:"home"`
	Bin  string   `json:"bin"`
	Env  []EnvVar `json:"env"`
}

var runtimeKeyOrder = []string{"type", "home", "bin", "env"}

// runtimesNode returns the `runtimes` mapping, creating it above `services`.
func runtimesNode(root *yaml.Node, create bool) *yaml.Node {
	if i := mapIndex(root, "runtimes"); i >= 0 {
		n := root.Content[i+1]
		if n.Kind != yaml.MappingNode {
			if !create {
				return nil
			}
			*n = yaml.Node{Kind: yaml.MappingNode}
		}
		return n
	}
	if !create {
		return nil
	}
	n := &yaml.Node{Kind: yaml.MappingNode}
	pos := len(root.Content)
	if i := mapIndex(root, "services"); i >= 0 {
		pos = i
	}
	root.Content = append(root.Content[:pos], append([]*yaml.Node{scalar("runtimes"), n}, root.Content[pos:]...)...)
	return n
}

func envFromNode(n *yaml.Node) []EnvVar {
	var out []EnvVar
	if n != nil && n.Kind == yaml.MappingNode {
		for j := 0; j+1 < len(n.Content); j += 2 {
			out = append(out, EnvVar{Key: n.Content[j].Value, Value: n.Content[j+1].Value})
		}
	}
	return out
}

func envNode(env []EnvVar) *yaml.Node {
	if len(env) == 0 {
		return nil
	}
	n := &yaml.Node{Kind: yaml.MappingNode}
	if len(env) <= 3 {
		n.Style = yaml.FlowStyle
	}
	for _, kv := range env {
		n.Content = append(n.Content, scalar(kv.Key), scalar(kv.Value))
	}
	return n
}

// ReadRuntime returns a runtime as written; the type is filled in when implicit.
func ReadRuntime(path, name string) (RuntimeSpec, error) {
	editMu.Lock()
	defer editMu.Unlock()
	_, root, err := loadRoot(path)
	if err != nil {
		return RuntimeSpec{}, err
	}
	rts := runtimesNode(root, false)
	i := -1
	if rts != nil {
		i = mapIndex(rts, name)
	}
	if i < 0 {
		return RuntimeSpec{}, fmt.Errorf("runtime %q not found", name)
	}
	var r struct {
		Type string    `yaml:"type"`
		Home string    `yaml:"home"`
		Bin  string    `yaml:"bin"`
		Env  yaml.Node `yaml:"env"`
	}
	if err := rts.Content[i+1].Decode(&r); err != nil {
		return RuntimeSpec{}, err
	}
	typ := strings.ToLower(r.Type)
	if typ == "" {
		typ = inferType(name)
	}
	return RuntimeSpec{Name: name, Type: typ, Home: r.Home, Bin: r.Bin, Env: envFromNode(&r.Env)}, nil
}

// SaveRuntime creates (oldName == "") or updates a runtime. Renames also
// update the `runtime:` references of services.
func SaveRuntime(path, oldName string, s RuntimeSpec) error {
	s.Name, s.Home, s.Bin = strings.TrimSpace(s.Name), strings.TrimSpace(s.Home), strings.TrimSpace(s.Bin)
	s.Type = strings.ToLower(strings.TrimSpace(s.Type))
	if !nameRe.MatchString(s.Name) {
		return fmt.Errorf("invalid name %q: use letters, digits, '.', '_' or '-'", s.Name)
	}
	if _, ok := runtimeTypes[s.Type]; !ok {
		return fmt.Errorf("type must be java, node or script")
	}
	if s.Home == "" {
		return fmt.Errorf("home folder is required")
	}
	editMu.Lock()
	defer editMu.Unlock()
	doc, root, err := loadRoot(path)
	if err != nil {
		return err
	}
	rts := runtimesNode(root, true)
	var m *yaml.Node
	if oldName == "" {
		if mapIndex(rts, s.Name) >= 0 {
			return fmt.Errorf("runtime %q %w", s.Name, ErrExist)
		}
		m = &yaml.Node{Kind: yaml.MappingNode}
		rts.Content = append(rts.Content, scalar(s.Name), m)
	} else {
		i := mapIndex(rts, oldName)
		if i < 0 {
			return fmt.Errorf("runtime %q not found", oldName)
		}
		if s.Name != oldName {
			if mapIndex(rts, s.Name) >= 0 {
				return fmt.Errorf("runtime %q %w", s.Name, ErrExist)
			}
			rts.Content[i].Value = s.Name
			if _, svcs, err := servicesOf(root); err == nil {
				renameRuntimeRefs(svcs, oldName, s.Name)
			}
		}
		m = rts.Content[i+1]
		if m.Kind != yaml.MappingNode {
			*m = yaml.Node{Kind: yaml.MappingNode}
		}
	}
	// Write `type` only when the name doesn't already imply it (or it was explicit).
	if mapIndex(m, "type") >= 0 || inferType(s.Name) != s.Type {
		setKeyIn(m, runtimeKeyOrder, "type", scalar(s.Type))
	}
	setKeyIn(m, runtimeKeyOrder, "home", scalar(s.Home))
	setKeyIn(m, runtimeKeyOrder, "bin", strOrNil(s.Bin))
	var env []EnvVar
	for _, kv := range s.Env {
		if strings.TrimSpace(kv.Key) != "" {
			env = append(env, EnvVar{strings.TrimSpace(kv.Key), kv.Value})
		}
	}
	setKeyIn(m, runtimeKeyOrder, "env", envNode(env))
	return writeValidated(path, doc)
}

func servicesOf(root *yaml.Node) (int, *yaml.Node, error) {
	i := mapIndex(root, "services")
	if i < 0 || root.Content[i+1].Kind != yaml.MappingNode {
		return -1, nil, errors.New("no services")
	}
	return i, root.Content[i+1], nil
}

func renameRuntimeRefs(svcs *yaml.Node, from, to string) {
	for i := 1; i < len(svcs.Content); i += 2 {
		m := svcs.Content[i]
		if j := mapIndex(m, "runtime"); j >= 0 {
			r := m.Content[j+1]
			if r.Kind == yaml.ScalarNode && r.Value == from {
				r.Value = to
			}
			for _, it := range r.Content {
				if it.Value == from {
					it.Value = to
				}
			}
		}
	}
}

// removeRuntimeRefs drops a runtime from every service's `runtime:` list.
func removeRuntimeRefs(svcs *yaml.Node, name string) {
	for i := 1; i < len(svcs.Content); i += 2 {
		m := svcs.Content[i]
		j := mapIndex(m, "runtime")
		if j < 0 {
			continue
		}
		r := m.Content[j+1]
		switch r.Kind {
		case yaml.ScalarNode:
			if r.Value == name {
				setKey(m, "runtime", nil)
			}
		case yaml.SequenceNode:
			var keep []*yaml.Node
			for _, it := range r.Content {
				if it.Value != name {
					keep = append(keep, it)
				}
			}
			switch len(keep) {
			case 0:
				setKey(m, "runtime", nil)
			case 1:
				setKey(m, "runtime", scalar(keep[0].Value))
			default:
				r.Content = keep
			}
		}
	}
}

// runtimeUsers lists the services that use a runtime.
func runtimeUsers(svcs *yaml.Node, name string) []string {
	var users []string
	for j := 0; j+1 < len(svcs.Content); j += 2 {
		var r struct {
			Runtime StringList `yaml:"runtime"`
		}
		svcs.Content[j+1].Decode(&r)
		if indexOf(r.Runtime, name) >= 0 {
			users = append(users, svcs.Content[j].Value)
		}
	}
	return users
}

// DeleteRuntime removes a runtime. If services still use it, it fails
// unless detach is set, in which case it is removed from those services too.
func DeleteRuntime(path, name string, detach bool) error {
	editMu.Lock()
	defer editMu.Unlock()
	doc, root, err := loadRoot(path)
	if err != nil {
		return err
	}
	rts := runtimesNode(root, false)
	i := -1
	if rts != nil {
		i = mapIndex(rts, name)
	}
	if i < 0 {
		return fmt.Errorf("runtime %q not found", name)
	}
	if _, svcs, err := servicesOf(root); err == nil {
		if users := runtimeUsers(svcs, name); len(users) > 0 {
			if !detach {
				return fmt.Errorf("%q is used by %s; remove it from those services first", name, strings.Join(users, ", "))
			}
			removeRuntimeRefs(svcs, name)
		}
	}
	rts.Content = append(rts.Content[:i], rts.Content[i+2:]...)
	if len(rts.Content) == 0 {
		j := mapIndex(root, "runtimes")
		root.Content = append(root.Content[:j], root.Content[j+2:]...)
	}
	return writeValidated(path, doc)
}

var (
	topKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*:`)
	svcKeyRe = regexp.MustCompile(`^  [A-Za-z0-9][A-Za-z0-9._-]*:`)
)

// spaceOut restores the blank lines yaml.v3 drops: one before every
// top-level section and before every service (and its leading comments).
func spaceOut(b []byte) []byte {
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	inServices := false
	firstService := true
	var out []string
	for i, line := range lines {
		blank := false
		switch {
		case topKeyRe.MatchString(line):
			inServices = strings.HasPrefix(line, "services:")
			firstService = true
			blank = i > 0
		case inServices && svcKeyRe.MatchString(line):
			blank = !firstService
			firstService = false
		}
		if blank {
			// put the blank line above the comments that belong to this key
			j := len(out)
			indent := len(line) - len(strings.TrimLeft(line, " "))
			for j > 0 && strings.HasPrefix(strings.TrimLeft(out[j-1], " "), "#") &&
				len(out[j-1])-len(strings.TrimLeft(out[j-1], " ")) == indent {
				j--
			}
			if j > 0 && strings.TrimSpace(out[j-1]) != "" {
				out = append(out[:j], append([]string{""}, out[j:]...)...)
			}
		}
		out = append(out, line)
	}
	return []byte(strings.Join(out, "\n") + "\n")
}

// ResolvePath resolves p like the config does (env vars, ~, relative to dir).
func ResolvePath(dir, p string) string { return resolvePath(dir, p) }

// PreviewSpec returns the build and run commands a spec would produce.
func PreviewSpec(dir string, s ServiceSpec) (build, run string, err error) {
	svc := Service{Name: s.Name, Type: s.Type, Command: s.Command, Cwd: s.Cwd}
	if svc.Cwd == "" {
		svc.Cwd = dir
	} else {
		svc.Cwd = resolvePath(dir, svc.Cwd)
	}
	if o := s.Spring; o != nil {
		skip := o.SkipTests
		svc.Spring = &SpringOpts{Module: o.Module, Profiles: o.Profiles, JvmArgs: o.JvmArgs, Args: o.Args,
			Mode: o.Mode, SkipTests: &skip, Offline: o.Offline, AlwaysBuild: o.AlwaysBuild}
	}
	if o := s.Node; o != nil {
		svc.Node = &NodeOpts{Script: o.Script, Args: o.Args, Install: o.Install, PackageManager: o.PackageManager}
	}
	if o := s.Script; o != nil {
		svc.Script = &ScriptOpts{File: o.File, Args: o.Args}
	}
	if o := s.Jar; o != nil {
		svc.Jar = &JarOpts{File: o.File, JvmArgs: o.JvmArgs, Args: o.Args}
	}
	if err := normalizeType(&svc); err != nil {
		return "", "", err
	}
	build, run = svc.Preview()
	return build, run, nil
}

// ReorderServices rewrites the order of the services mapping. names must list
// every service exactly once. Comments travel with their service.
func ReorderServices(path string, names []string) error {
	editMu.Lock()
	defer editMu.Unlock()
	doc, svcs, err := loadDoc(path)
	if err != nil {
		return err
	}
	if len(names)*2 != len(svcs.Content) {
		return fmt.Errorf("order must list all %d services", len(svcs.Content)/2)
	}
	pairs := map[string][2]*yaml.Node{}
	for i := 0; i+1 < len(svcs.Content); i += 2 {
		pairs[svcs.Content[i].Value] = [2]*yaml.Node{svcs.Content[i], svcs.Content[i+1]}
	}
	out := make([]*yaml.Node, 0, len(svcs.Content))
	for _, n := range names {
		p, ok := pairs[n]
		if !ok {
			return fmt.Errorf("unknown or repeated service %q", n)
		}
		delete(pairs, n)
		out = append(out, p[0], p[1])
	}
	svcs.Content = out
	return writeValidated(path, doc)
}
