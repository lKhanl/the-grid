// Package mcp is a tiny MCP server (stdio, newline-delimited JSON-RPC) that
// lets an AI agent see and restart the services of a running Grid. It only
// talks to the Grid's HTTP API, so the Grid must be running.
//
// Kept deliberately small (three tools, short plain-text answers) so that
// modest models handle it reliably and spend few tokens.
package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Server answers MCP requests by calling the Grid HTTP API at Base.
type Server struct {
	Base    string // e.g. http://127.0.0.1:7070
	Version string
	Client  *http.Client
	// poll interval and the grace period used to catch a crash right after "running"
	Poll  time.Duration
	Grace time.Duration
	// DefaultWait is how long restart / wait block when the agent gives no `wait`.
	// Kept under the typical 60 s tool timeout of MCP clients: a slow build (VDI)
	// must come back as "still building", not as a timeout the agent reads as a failure.
	DefaultWait time.Duration
	// Progress is how often a progress notification is sent while waiting
	// (clients that reset their timeout on progress then never give up).
	Progress time.Duration
}

func New(port int, version string) *Server {
	return &Server{
		Base:    fmt.Sprintf("http://127.0.0.1:%d", port),
		Version: version,
		Client:  &http.Client{Timeout: 30 * time.Second},
		Poll:    500 * time.Millisecond,
		Grace:   3 * time.Second,

		DefaultWait: 40 * time.Second,
		Progress:    3 * time.Second,
	}
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Serve reads requests from in until it closes and writes responses to out.
func (s *Server) Serve(in io.Reader, out io.Writer) error {
	var mu sync.Mutex
	write := func(v any) {
		b, _ := json.Marshal(v)
		mu.Lock()
		defer mu.Unlock()
		out.Write(append(b, '\n'))
	}
	notify := func(method string, params any) {
		write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	var wg sync.WaitGroup
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			write(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
			continue
		}
		if len(req.ID) == 0 { // notification: no answer
			continue
		}
		// tools/call can wait for a restart: do not block other requests
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, rerr := s.handle(req, notify)
			r := response{JSONRPC: "2.0", ID: req.ID, Result: res, Error: rerr}
			if rerr == nil && res == nil {
				r.Result = map[string]any{}
			}
			write(r)
		}()
	}
	wg.Wait()
	return sc.Err()
}

func (s *Server) handle(req request, notify func(string, any)) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		if p.ProtocolVersion == "" {
			p.ProtocolVersion = "2024-11-05"
		}
		return map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "grid", "version": s.Version},
			"instructions":    "Controls the services of The Grid. Use restart after changing a service's code, then read the log tail it returns (only what that start produced). To look into a problem use logs with level=error, grep or since_restart instead of reading many lines; describe tells where a service lives and how it runs. Builds can be slow: if restart says the service is still building or starting, that is NOT a failure; call wait (never restart again) until it is running.",
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
			Meta      struct {
				ProgressToken json.RawMessage `json:"progressToken"`
			} `json:"_meta"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcError{-32602, "bad params"}
		}
		var progress func(string)
		if len(p.Meta.ProgressToken) > 0 && string(p.Meta.ProgressToken) != "null" {
			n := 0
			progress = func(msg string) {
				n++
				notify("notifications/progress", map[string]any{"progressToken": p.Meta.ProgressToken, "progress": n, "message": msg})
			}
		}
		text, err := s.call(p.Name, p.Arguments, progress)
		if err != nil {
			return toolResult(err.Error(), true), nil
		}
		return toolResult(text, false), nil
	}
	return nil, &rpcError{-32601, "method not found: " + req.Method}
}

func toolResult(text string, isErr bool) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}, "isError": isErr}
}

var tools = []map[string]any{
	{
		"name":        "status",
		"description": "List the services of The Grid with their state (running, building, crashed, stopped...).",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
	},
	{
		"name":        "logs",
		"description": "Last lines of a service's log (colors removed). To save tokens, filter instead of reading everything: level=error shows only errors and exceptions, grep a regex, since_restart only what the latest start produced.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"service":       map[string]any{"type": "string", "description": "service name, see status"},
				"lines":         map[string]any{"type": "integer", "description": "how many lines (default 100, max 500)"},
				"level":         map[string]any{"type": "string", "enum": []string{"error", "warn"}, "description": "only lines that look like errors (ERROR, FATAL, exceptions, 'Caused by', FAILED) or, with warn, also warnings"},
				"grep":          map[string]any{"type": "string", "description": "only lines matching this regular expression (case-insensitive)"},
				"since_restart": map[string]any{"type": "boolean", "description": "only lines since the latest start / restart (build output included), no old crashes"},
				"context":       map[string]any{"type": "integer", "description": "with level / grep: also show this many lines after each match, e.g. 5 for a stack trace (default 0, max 20)"},
			},
			"required": []string{"service"},
		},
	},
	{
		"name":        "describe",
		"description": "Everything known about one service: state, folder, build and run command, URL, readiness check, dependencies, runtimes.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"service": map[string]any{"type": "string", "description": "service name, see status"},
			},
			"required": []string{"service"},
		},
	},
	{
		"name":        "restart",
		"description": "Restart a service (or start / stop it), wait until it is running or has failed, and return the result with the last log lines. Use after changing code. Slow builds: if the answer says STILL BUILDING / STARTING, it is not a failure; call wait, do not restart again.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"service": map[string]any{"type": "string", "description": "service name, see status"},
				"action":  map[string]any{"type": "string", "enum": []string{"restart", "start", "stop"}, "description": "default restart"},
				"wait":    map[string]any{"type": "integer", "description": "max seconds to wait (default 40)"},
			},
			"required": []string{"service"},
		},
	},
	{
		"name":        "wait",
		"description": "Keep waiting for a service that restart reported as still building or starting. Returns when it is running or has failed, with the last log lines.",
		"inputSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"service": map[string]any{"type": "string", "description": "service name, see status"},
				"wait":    map[string]any{"type": "integer", "description": "max seconds to wait (default 40)"},
			},
			"required": []string{"service"},
		},
	},
}

func (s *Server) call(name string, args map[string]any, progress func(string)) (string, error) {
	switch name {
	case "status":
		return s.status()
	case "logs":
		svc, _ := args["service"].(string)
		f := logFilter{
			lines:   intArg(args, "lines", 100, 1, 500),
			context: intArg(args, "context", 0, 0, 20),
		}
		f.level, _ = args["level"].(string)
		f.grep, _ = args["grep"].(string)
		f.sinceRestart, _ = args["since_restart"].(bool)
		return s.logs(svc, f)
	case "describe":
		svc, _ := args["service"].(string)
		return s.describe(svc)
	case "restart":
		svc, _ := args["service"].(string)
		action, _ := args["action"].(string)
		if action == "" {
			action = "restart"
		}
		return s.restart(svc, action, s.waitArg(args), progress)
	case "wait":
		svc, _ := args["service"].(string)
		return s.waitTool(svc, s.waitArg(args), progress)
	}
	return "", fmt.Errorf("unknown tool %q", name)
}

// waitArg is the wait budget: the agent's `wait` seconds, else DefaultWait.
func (s *Server) waitArg(args map[string]any) time.Duration {
	if _, ok := args["wait"]; !ok {
		return s.DefaultWait
	}
	return time.Duration(intArg(args, "wait", int(s.DefaultWait/time.Second), 1, 600)) * time.Second
}

func intArg(args map[string]any, key string, def, min, max int) int {
	n := def
	switch v := args[key].(type) {
	case float64:
		n = int(v)
	case string:
		fmt.Sscanf(v, "%d", &n)
	}
	if n < min {
		n = min
	}
	if n > max {
		n = max
	}
	return n
}

// ---- Grid API ----

type info struct {
	Name        string   `json:"name"`
	Group       string   `json:"group"`
	Description string   `json:"description"`
	Status      string   `json:"status"`
	PID         int      `json:"pid"`
	ExitCode    *int     `json:"exitCode"`
	StartedAt   int64    `json:"startedAt"`
	Restarts    int      `json:"restarts"`
	Type        string   `json:"type"`
	Build       string   `json:"build"`
	Command     string   `json:"command"`
	Cwd         string   `json:"cwd"`
	URL         string   `json:"url"`
	DependsOn   []string `json:"dependsOn"`
	Ready       string   `json:"ready"`
	Runtimes    []string `json:"runtimes"`
}

func (s *Server) get(path string) ([]byte, error) { return s.do("GET", path) }

func (s *Server) do(method, path string) ([]byte, error) {
	req, _ := http.NewRequest(method, s.Base+path, nil)
	req.Header.Set("X-Grid", "mcp")
	resp, err := s.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("The Grid is not running at %s (start it with: grid)", s.Base)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e struct{ Error string }
		if json.Unmarshal(b, &e) == nil && e.Error != "" {
			return nil, errors.New(e.Error)
		}
		return nil, fmt.Errorf("%s", resp.Status)
	}
	return b, nil
}

func (s *Server) services() ([]info, error) {
	b, err := s.get("/api/state")
	if err != nil {
		return nil, err
	}
	var st struct{ Services []info }
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return st.Services, nil
}

func (s *Server) find(name string) (*info, error) {
	list, err := s.services()
	if err != nil {
		return nil, err
	}
	var names []string
	for i := range list {
		if list[i].Name == name {
			return &list[i], nil
		}
		names = append(names, list[i].Name)
	}
	sort.Strings(names)
	return nil, fmt.Errorf("unknown service %q. Services: %s", name, strings.Join(names, ", "))
}

func (s *Server) status() (string, error) {
	list, err := s.services()
	if err != nil {
		return "", err
	}
	if len(list) == 0 {
		return "No services.", nil
	}
	var b strings.Builder
	for _, v := range list {
		fmt.Fprintf(&b, "%s: %s", v.Name, label(v))
		if inProgress(v.Status) && v.StartedAt > 0 {
			fmt.Fprintf(&b, " (for %ds)", int(time.Since(time.UnixMilli(v.StartedAt)).Seconds()))
		}
		if v.Type != "" && v.Type != "custom" {
			fmt.Fprintf(&b, " [%s]", v.Type)
		}
		if v.URL != "" {
			fmt.Fprintf(&b, " %s", v.URL)
		}
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n"), nil
}

func inProgress(status string) bool {
	return status == "starting" || status == "building"
}

func label(v info) string {
	if (v.Status == "crashed" || v.Status == "exited") && v.ExitCode != nil {
		return fmt.Sprintf("%s (exit %d)", v.Status, *v.ExitCode)
	}
	return v.Status
}

const (
	maxLineLen = 400
	maxLogText = 8000
)

// fetch returns up to n plain log lines (colors removed by the Grid).
func (s *Server) fetch(service string, n int, sinceStart bool) ([]string, error) {
	q := fmt.Sprintf("/api/services/%s/logs?tail=%d", url.PathEscape(service), n)
	if sinceStart {
		q += "&since=start"
	}
	b, err := s.get(q)
	if err != nil {
		return nil, err
	}
	text := strings.TrimRight(string(b), "\n")
	if text == "" {
		return nil, nil
	}
	return strings.Split(text, "\n"), nil
}

// shorten joins lines into one answer that stays small: long lines are cut, and
// when everything is still too long only the newest part is kept.
func shorten(lines []string) string {
	out := make([]string, len(lines))
	for i, l := range lines {
		if len(l) > maxLineLen {
			l = l[:maxLineLen] + " ..."
		}
		out[i] = l
	}
	text := strings.Join(out, "\n")
	if len(text) > maxLogText { // keep the newest part
		text = "... (older lines cut)\n" + text[len(text)-maxLogText:]
	}
	return text
}

// tail returns the last n log lines (since the latest start if asked), shortened.
func (s *Server) tail(service string, n int, sinceStart bool) (string, error) {
	lines, err := s.fetch(service, n, sinceStart)
	if err != nil {
		return "", err
	}
	return shorten(lines), nil
}

type logFilter struct {
	lines        int
	level, grep  string
	sinceRestart bool
	context      int
}

var (
	errorRe = regexp.MustCompile(`(?i)(\b(error|fatal|severe|panic|failed|failure)\b|exception\b|caused by:)`)
	warnRe  = regexp.MustCompile(`(?i)\bwarn(ing)?\b`)
)

// matcher builds the line test of a filter; nil means "no filter".
func (f logFilter) matcher() (func(string) bool, error) {
	var tests []func(string) bool
	switch f.level {
	case "":
	case "error":
		tests = append(tests, errorRe.MatchString)
	case "warn":
		tests = append(tests, func(l string) bool { return errorRe.MatchString(l) || warnRe.MatchString(l) })
	default:
		return nil, fmt.Errorf("level must be error or warn")
	}
	if f.grep != "" {
		re, err := regexp.Compile("(?i)" + f.grep)
		if err != nil {
			return nil, fmt.Errorf("grep is not a valid regular expression: %v", err)
		}
		tests = append(tests, re.MatchString)
	}
	if len(tests) == 0 {
		return nil, nil
	}
	return func(l string) bool {
		for _, t := range tests {
			if !t(l) {
				return false
			}
		}
		return true
	}, nil
}

// filterLines keeps the matching lines (plus `context` lines after each), newest `limit` of them.
func filterLines(lines []string, match func(string) bool, context, limit int) (out []string, matches int) {
	keep := make([]bool, len(lines))
	for i, l := range lines {
		if match(l) {
			matches++
			for k := i; k <= i+context && k < len(lines); k++ {
				keep[k] = true
			}
		}
	}
	gap := false
	for i, l := range lines {
		if !keep[i] {
			gap = true
			continue
		}
		if gap && context > 0 && len(out) > 0 { // like grep -A: a "--" between separate groups
			out = append(out, "--")
		}
		gap = false
		out = append(out, l)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	if len(out) > 0 && out[0] == "--" {
		out = out[1:]
	}
	return out, matches
}

func (s *Server) logs(service string, f logFilter) (string, error) {
	if _, err := s.find(service); err != nil {
		return "", err
	}
	match, err := f.matcher()
	if err != nil {
		return "", err
	}
	if match == nil { // plain tail
		text, err := s.tail(service, f.lines, f.sinceRestart)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) == "" {
			return "(no log lines yet)", nil
		}
		return text, nil
	}
	// a filter looks through the whole history the Grid keeps, not just the last lines
	all, err := s.fetch(service, 100000, f.sinceRestart)
	if err != nil {
		return "", err
	}
	out, matches := filterLines(all, match, f.context, f.lines)
	where := "in the log"
	if f.sinceRestart {
		where = "since the latest start"
	}
	if matches == 0 {
		return fmt.Sprintf("No matching lines %s (%d lines checked).", where, len(all)), nil
	}
	head := fmt.Sprintf("%d matching lines %s", matches, where)
	if matches > f.lines {
		head += fmt.Sprintf(" (showing the last %d)", f.lines)
	}
	return head + ":\n" + shorten(out), nil
}

func (s *Server) describe(service string) (string, error) {
	v, err := s.find(service)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", v.Name, label(*v))
	if inProgress(v.Status) && v.StartedAt > 0 {
		fmt.Fprintf(&b, " (for %ds)", int(time.Since(time.UnixMilli(v.StartedAt)).Seconds()))
	}
	line := func(k, val string) {
		if strings.TrimSpace(val) != "" {
			fmt.Fprintf(&b, "\n%s: %s", k, val)
		}
	}
	line("type", v.Type)
	line("group", v.Group)
	line("description", v.Description)
	line("folder", v.Cwd)
	line("build", v.Build)
	line("run", v.Command)
	line("url", v.URL)
	line("ready when", v.Ready)
	line("depends on", strings.Join(v.DependsOn, ", "))
	line("runtimes", strings.Join(v.Runtimes, ", "))
	if v.PID > 0 {
		line("pid", fmt.Sprint(v.PID))
	}
	if v.Restarts > 0 {
		line("auto restarts", fmt.Sprint(v.Restarts))
	}
	return b.String(), nil
}

func (s *Server) restart(service, action string, wait time.Duration, progress func(string)) (string, error) {
	switch action {
	case "restart", "start", "stop":
	default:
		return "", fmt.Errorf("action must be restart, start or stop")
	}
	before, err := s.find(service)
	if err != nil {
		return "", err
	}
	if _, err := s.do("POST", fmt.Sprintf("/api/do/%s/%s", url.PathEscape(service), action)); err != nil {
		return "", err
	}
	return s.report(service, action, before.StartedAt, wait, progress), nil
}

// waitTool keeps waiting for a service that is already starting (after restart timed out).
func (s *Server) waitTool(service string, wait time.Duration, progress func(string)) (string, error) {
	cur, err := s.find(service)
	if err != nil {
		return "", err
	}
	return s.report(service, "wait", cur.StartedAt, wait, progress), nil
}

func (s *Server) report(service, action string, oldStart int64, wait time.Duration, progress func(string)) string {
	final, outcome := s.waitFor(service, action, oldStart, wait, progress)
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", service, outcome)
	if final != nil && !inProgress(final.Status) {
		fmt.Fprintf(&b, " (status: %s)", label(*final))
	}
	if action != "stop" {
		if t, err := s.tail(service, 40, true); err == nil && strings.TrimSpace(t) != "" {
			b.WriteString("\n--- last log lines ---\n" + t)
		}
	}
	return b.String()
}

// waitFor polls until the service is up, has failed, or the time is over.
func (s *Server) waitFor(service, action string, oldStart int64, max time.Duration, progress func(string)) (*info, string) {
	start := time.Now()
	deadline := start.Add(max)
	time.Sleep(s.Poll) // let the action take effect before reading the state
	var runningSince time.Time
	var lastProgress time.Time
	for {
		cur, err := s.find(service)
		if err != nil {
			return nil, "could not read state: " + err.Error()
		}
		switch cur.Status {
		case "stopped", "exited", "crashed":
			if action == "stop" {
				return cur, "stopped"
			}
			return cur, "FAILED, it is not running"
		case "running":
			if action == "stop" {
				break
			}
			if cur.StartedAt != oldStart || action != "restart" {
				// no readiness check means "running" starts at once: wait a bit to catch an early crash
				if runningSince.IsZero() {
					runningSince = time.Now()
				}
				if time.Since(runningSince) >= s.Grace {
					return cur, "running"
				}
			}
		}
		if time.Now().After(deadline) {
			secs := int(time.Since(start).Round(time.Second) / time.Second)
			if inProgress(cur.Status) {
				return cur, fmt.Sprintf("STILL %s after %ds. This is NOT a failure, the service is just slow. Call the wait tool to keep waiting; do not restart it again.",
					strings.ToUpper(cur.Status), secs)
			}
			return cur, fmt.Sprintf("not ready after %ds", secs)
		}
		if progress != nil && time.Since(lastProgress) >= s.Progress {
			lastProgress = time.Now()
			progress(fmt.Sprintf("%s: %s, %ds", service, cur.Status, int(time.Since(start)/time.Second)))
		}
		time.Sleep(s.Poll)
	}
}
