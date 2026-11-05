// The Grid: run, watch and restart all your local services from one place.
// "Programs" (services) live on the grid; you start, stop and read them here.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/lKhanl/the-grid/internal/config"
	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/server"
	"github.com/lKhanl/the-grid/internal/term"
	"github.com/lKhanl/the-grid/web"
)

const defaultPort = 7070

const usage = `The Grid %s

Usage:
  grid [serve] [-c grid.yaml] [-p 7070] [--no-browser]
  grid status                  list services and their state     (alias: programs)
  grid start   <target>        target = service, group or "all"  (alias: rez)
  grid stop    <target>                                          (alias: derezz)
  grid restart <target>
  grid eol                     stop everything                   ("end of line")
  grid logs    <service> [-n 200] [-f]
  grid reload                  re-read grid.yaml
  grid runtimes [-c file]      check configured java/node/script runtimes

Client commands talk to a running server on -p (or $GRID_PORT).
`

func main() {
	args := os.Args[1:]
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(args)
	case "status", "ls", "ps", "programs":
		err = status(args)
	case "start", "stop", "restart", "clear":
		err = action(cmd, args)
	case "rez":
		err = action("start", args)
	case "derezz", "derez":
		err = action("stop", args)
	case "eol", "end-of-line":
		err = action("stop", append([]string{"all"}, args...))
	case "logs":
		err = logs(args)
	case "reload":
		err = reload(args)
	case "runtimes":
		err = runtimes(args)
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		fmt.Printf(usage, version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func envPort() int {
	if p, err := strconv.Atoi(os.Getenv("GRID_PORT")); err == nil && p > 0 {
		return p
	}
	return defaultPort
}

func serve(args []string) error {
	fset := flag.NewFlagSet("serve", flag.ExitOnError)
	cfgPath := fset.String("c", "grid.yaml", "config file")
	port := fset.Int("p", envPort(), "HTTP port (listens on 127.0.0.1 only)")
	noBrowser := fset.Bool("no-browser", false, "do not open the browser")
	fset.Parse(args)
	if fset.NArg() > 0 {
		*cfgPath = fset.Arg(0)
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%v\ncreate a grid.yaml (see grid.example.yaml) or pass -c <file>", err)
		}
		return err
	}
	runner.Version = version
	m := runner.NewManager(cfg)

	ui, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("cannot listen on port %d (already running? try -p): %w", *port, err)
	}
	var terms *term.Manager
	terms = term.NewManager(func() { m.Hub.Publish(runner.Event{Type: "terms", Terms: terms.List()}) })
	srv := &http.Server{Handler: server.New(m, terms, ui), ReadHeaderTimeout: 10 * time.Second}
	url := fmt.Sprintf("http://localhost:%d", *port)
	fmt.Printf("THE GRID %s\n  config : %s\n  ui     : %s\n  %d programs on the grid. Ctrl+C: end of line (stops everything).\n",
		version, cfg.Path, url, len(cfg.Services))

	go srv.Serve(ln)
	m.Autostart()
	if !*noBrowser {
		openBrowser(url)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Println("\nstopping all services ...")
	done := make(chan struct{})
	go func() { terms.Shutdown(); m.Shutdown(); close(done) }()
	select {
	case <-done:
	case <-sig:
		fmt.Println("forced exit")
	case <-time.After(30 * time.Second):
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	return nil
}

func openBrowser(url string) {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		c = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		c = exec.Command("open", url)
	default:
		c = exec.Command("xdg-open", url)
	}
	c.Start()
}

// ---- client commands ----

func clientFlags(name string, args []string) (*flag.FlagSet, *int) {
	fset := flag.NewFlagSet(name, flag.ExitOnError)
	port := fset.Int("p", envPort(), "server port")
	return fset, port
}

// parseInterspersed lets flags appear after positional args (logs api -n 50).
func parseInterspersed(fset *flag.FlagSet, args []string) []string {
	var pos []string
	for {
		fset.Parse(args)
		args = fset.Args()
		if len(args) == 0 {
			return pos
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func api(port int, method, path string) (*http.Response, error) {
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set(server.CSRFHeader, "cli")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("no The Grid on port %d (%w)", port, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		var e struct{ Error string }
		b, _ := io.ReadAll(resp.Body)
		if json.Unmarshal(b, &e) == nil && e.Error != "" {
			return nil, errors.New(e.Error)
		}
		return nil, fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return resp, nil
}

func status(args []string) error {
	fset, port := clientFlags("status", args)
	asJSON := fset.Bool("json", false, "print JSON")
	fset.Parse(args)
	resp, err := api(*port, "GET", "/api/state")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var st runner.State
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return err
	}
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(st)
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "SERVICE\tGROUP\tSTATUS\tPID\tUPTIME\tURL")
	for _, s := range st.Services {
		pid, up := "-", "-"
		if s.PID > 0 {
			pid = strconv.Itoa(s.PID)
		}
		if s.StartedAt > 0 {
			up = time.Since(time.UnixMilli(s.StartedAt)).Round(time.Second).String()
		}
		stat := string(s.Status)
		if s.ExitCode != nil && (s.Status == runner.Crashed || s.Status == runner.Exited) {
			stat += fmt.Sprintf(" (%d)", *s.ExitCode)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", s.Name, dash(s.Group), stat, pid, up, dash(s.URL))
	}
	return tw.Flush()
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func action(name string, args []string) error {
	fset, port := clientFlags(name, args)
	pos := parseInterspersed(fset, args)
	if len(pos) == 0 {
		return fmt.Errorf("usage: grid %s <service|group|all>", name)
	}
	for _, t := range pos {
		resp, err := api(*port, "POST", "/api/do/"+t+"/"+name)
		if err != nil {
			return err
		}
		resp.Body.Close()
		fmt.Printf("%s %s: ok\n", name, t)
	}
	return nil
}

func reload(args []string) error {
	fset, port := clientFlags("reload", args)
	fset.Parse(args)
	resp, err := api(*port, "POST", "/api/reload")
	if err != nil {
		return err
	}
	resp.Body.Close()
	fmt.Println("config reloaded")
	return nil
}

func logs(args []string) error {
	fset, port := clientFlags("logs", args)
	n := fset.Int("n", 200, "number of lines")
	follow := fset.Bool("f", false, "follow new lines")
	raw := fset.Bool("raw", false, "keep ANSI colors")
	pos := parseInterspersed(fset, args)
	if len(pos) != 1 {
		return errors.New("usage: grid logs <service> [-n 200] [-f]")
	}
	svc := pos[0]
	q := "?tail=" + strconv.Itoa(*n)
	if *raw {
		q += "&raw=1"
	}
	resp, err := api(*port, "GET", "/api/services/"+svc+"/logs"+q)
	if err != nil {
		return err
	}
	io.Copy(os.Stdout, resp.Body)
	resp.Body.Close()
	if !*follow {
		return nil
	}
	resp, err = api(*port, "GET", "/api/events")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var e runner.Event
		if json.Unmarshal([]byte(line), &e) != nil || e.Type != "log" || e.Service != svc || e.Entry == nil {
			continue
		}
		text := e.Entry.Line
		if !*raw {
			text = runner.StripANSI(text)
		}
		if e.Entry.Stream == "sys" {
			text = "[runner] " + text
		}
		fmt.Println(text)
	}
	return sc.Err()
}

// runtimes checks every configured runtime and prints its real version.
func runtimes(args []string) error {
	fset := flag.NewFlagSet("runtimes", flag.ExitOnError)
	cfgPath := fset.String("c", "grid.yaml", "config file")
	fset.Parse(args)
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	if len(cfg.RuntimeOrder) == 0 {
		fmt.Println("no runtimes defined; services use java/mvn/node from the system PATH")
		return nil
	}
	used := map[string][]string{}
	for _, s := range cfg.Services {
		for _, r := range s.Runtime {
			used[r] = append(used[r], s.Name)
		}
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "RUNTIME\tTYPE\tSTATUS\tVERSION\tUSED BY\tHOME")
	for _, name := range cfg.RuntimeOrder {
		rt := cfg.Runtimes[name]
		status, ver := "ok", "-"
		if err := rt.Check(); err != nil {
			status = "MISSING: " + err.Error()
		} else if v := rt.Version(); v != "" {
			ver = v
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", name, rt.Type, status, ver, dash(strings.Join(used[name], ",")), rt.Home)
	}
	return tw.Flush()
}
