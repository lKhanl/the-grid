//go:build db || oracle || postgres

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// ErrBusy is returned when a statement is already running in the UI session of a connection.
var ErrBusy = errors.New("a statement is still running on this connection (stop it first)")

// Column is a result column.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Result is the outcome of one statement. Cells are text (nil = NULL) so numbers keep
// every digit and the UI needs no type handling.
type Result struct {
	Kind         string      `json:"kind"` // rows | update
	Columns      []Column    `json:"columns,omitempty"`
	Rows         [][]*string `json:"rows,omitempty"`
	Truncated    bool        `json:"truncated,omitempty"` // more rows existed than maxRows
	Offset       int         `json:"offset,omitempty"`    // rows skipped before the first one returned (paging)
	RowsAffected int64       `json:"rowsAffected,omitempty"`
	Millis       int64       `json:"ms"`
	InTx         bool        `json:"inTx"` // uncommitted changes are waiting for commit / rollback
}

// outcome is what a statement goroutine reports back.
type outcome struct {
	res *Result
	err error
}

type session struct {
	mu     sync.Mutex // held while a statement runs
	conn   *sql.Conn
	tx     *sql.Tx
	cancel context.CancelFunc // stops the running statement
	// database/sql rolls a transaction back when the context it began with ends, so a
	// UI transaction gets its own long-lived one (it outlives the statement that opened it).
	txCancel context.CancelFunc
}

type pool struct {
	db   *sql.DB
	conn Conn
	d    dialect
	sess session
	cmu  sync.Mutex // guards sess.cancel
}

// Manager owns the open connections. UI statements run in one long-lived session per
// connection (so commit / rollback mean something); AI statements get their own short ones.
type Manager struct {
	Store *Store
	// Open creates the pool of a connection; replaced in tests.
	Open func(c Conn) (*sql.DB, error)
	// AITimeout is how long an AI statement may run (default 30 s).
	AITimeout time.Duration

	mu    sync.Mutex
	pools map[string]*pool
}

func NewManager(store *Store) *Manager {
	return &Manager{Store: store, Open: openConn, AITimeout: 30 * time.Second, pools: map[string]*pool{}}
}

func key(name string) string { return strings.ToLower(name) }

// get returns the (lazily opened) pool of a saved connection.
func (m *Manager) get(name string) (*pool, error) {
	c, ok := m.Store.Get(name)
	if !ok {
		return nil, fmt.Errorf("unknown connection %q", name)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.pools[key(name)]; ok {
		p.conn.MCP = c.MCP // keep the access level current without reconnecting
		return p, nil
	}
	dl, err := dialectOf(c.Kind)
	if err != nil {
		return nil, err
	}
	d, err := m.Open(c)
	if err != nil {
		return nil, err
	}
	p := &pool{db: d, conn: c, d: dl}
	m.pools[key(name)] = p
	return p, nil
}

// Forget closes the open connection called name (after it was edited or deleted).
func (m *Manager) Forget(name string) {
	m.mu.Lock()
	p := m.pools[key(name)]
	delete(m.pools, key(name))
	m.mu.Unlock()
	if p != nil {
		p.close()
	}
}

func (p *pool) close() {
	p.cmu.Lock()
	if p.sess.cancel != nil {
		p.sess.cancel()
	}
	p.cmu.Unlock()
	p.sess.mu.Lock()
	p.resetSession()
	p.sess.mu.Unlock()
	p.db.Close()
}

// endTx forgets the finished transaction. Caller holds mu.
func (s *session) endTx() {
	s.tx = nil
	if s.txCancel != nil {
		s.txCancel()
		s.txCancel = nil
	}
}

// resetSession drops the UI session (rolls back whatever is open). Caller holds sess.mu.
func (p *pool) resetSession() {
	if p.sess.tx != nil {
		p.sess.tx.Rollback()
		p.sess.endTx()
	}
	if p.sess.conn != nil {
		p.sess.conn.Close()
		p.sess.conn = nil
	}
}

// Close closes everything.
func (m *Manager) Close() {
	m.mu.Lock()
	ps := m.pools
	m.pools = map[string]*pool{}
	m.mu.Unlock()
	for _, p := range ps {
		p.close()
	}
}

// Views lists the saved connections with their live state.
func (m *Manager) Views() []View {
	var out []View
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.Store.List() {
		v := View{Conn: c, HasPassword: c.Password != ""}
		v.Conn.Password = ""
		if p, ok := m.pools[key(c.Name)]; ok {
			v.Connected = true
			if p.sess.mu.TryLock() {
				v.InTx = p.sess.tx != nil
				p.sess.mu.Unlock()
			}
		}
		out = append(out, v)
	}
	return out
}

// Test connects with c (not saved) and reports who we are and the server version.
// A draft without a password uses the stored one of the connection called existing.
func (m *Manager) Test(ctx context.Context, c Conn, existing string) (string, error) {
	if c.Name == "" {
		c.Name = "test"
	}
	if err := c.Normalize(); err != nil {
		return "", err
	}
	if c.Password == "" && existing != "" {
		if old, ok := m.Store.Get(existing); ok {
			c.Password = old.Password
		}
	}
	d, err := m.Open(c)
	if err != nil {
		return "", err
	}
	defer d.Close()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := d.PingContext(ctx); err != nil {
		return "", err
	}
	dl, err := dialectOf(c.Kind)
	if err != nil {
		return "", err
	}
	return dl.hello(ctx, d)
}

type runner interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Run executes sql in the UI session of the connection.
func (m *Manager) Run(ctx context.Context, name, text string, maxRows, offset int, timeout time.Duration) (*Result, error) {
	p, err := m.get(name)
	if err != nil {
		return nil, err
	}
	if !p.sess.mu.TryLock() {
		return nil, ErrBusy
	}
	defer p.sess.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	p.cmu.Lock()
	p.sess.cancel = cancel
	p.cmu.Unlock()
	defer func() {
		p.cmu.Lock()
		p.sess.cancel = nil
		p.cmu.Unlock()
	}()

	if p.sess.conn == nil {
		c, err := p.db.Conn(ctx)
		if err != nil {
			return nil, err
		}
		p.sess.conn = c
	}
	d := p.d
	text = d.prepare(text)
	if text == "" {
		return nil, errors.New("empty statement")
	}
	start := time.Now()
	if ctl := d.txControl(text); strings.HasPrefix(ctl, "BEGIN") { // Postgres: BEGIN typed in the editor
		if p.sess.tx == nil {
			if err := p.beginTx(); err != nil {
				p.resetIfBroken(err)
				return nil, err
			}
			if opts := strings.TrimSpace(strings.TrimPrefix(ctl, "BEGIN")); opts != "" { // BEGIN ISOLATION LEVEL ...
				if _, err := p.sess.tx.ExecContext(ctx, "SET TRANSACTION "+opts); err != nil {
					p.sess.tx.Rollback()
					p.sess.endTx()
					return nil, err
				}
			}
		}
		return &Result{Kind: "update", Millis: time.Since(start).Milliseconds(), InTx: true}, nil
	} else if ctl != "" { // COMMIT / ROLLBACK typed in the editor
		if tx := p.sess.tx; tx != nil {
			defer p.sess.endTx()
			var err error
			if ctl == "COMMIT" {
				err = tx.Commit()
			} else {
				err = tx.Rollback()
			}
			if err != nil {
				return nil, err
			}
		}
		return &Result{Kind: "update", Millis: time.Since(start).Milliseconds()}, nil
	}
	var r runner = p.sess.conn
	if p.sess.tx != nil {
		r = p.sess.tx
	}
	rows := d.returnsRows(text)
	if !d.isRead(text) && !d.noTx(text) && !p.conn.AutoCommit && p.sess.tx == nil {
		if err := p.beginTx(); err != nil {
			p.resetIfBroken(err)
			return nil, err
		}
		r = p.sess.tx
	}
	hadTx := p.sess.tx != nil
	savepoint := hadTx && d.stmtSavepoint(text)
	if savepoint {
		if _, err := p.sess.tx.ExecContext(ctx, "SAVEPOINT grid_stmt"); err != nil {
			p.resetIfBroken(err)
			return nil, err
		}
	}

	// The statement runs in its own goroutine so that Stop and the timeout answer at once even
	// when the driver cannot interrupt the server (go-ora cannot on Windows: the break only
	// arrives when the statement ends). A statement given up on is abandoned with its connection.
	done := make(chan outcome, 1)
	go func() {
		var o outcome
		if rows {
			o.res, o.err = query(ctx, d, r, text, maxRows, offset)
		} else {
			o.res, o.err = exec(ctx, r, text)
		}
		done <- o
	}()
	var o outcome
	select {
	case o = <-done:
	case <-ctx.Done():
		select {
		case o = <-done: // finished at the very same moment
		default:
			p.abandon(done)
			lost := ""
			if hadTx {
				lost = "; uncommitted changes were rolled back"
			}
			if ctx.Err() == context.DeadlineExceeded {
				return nil, fmt.Errorf("stopped after %s (timeout); the database may still be finishing the statement%s", timeout, lost)
			}
			return nil, errors.New("stopped; the database may still be finishing the statement" + lost)
		}
	}
	res, err := o.res, o.err
	if err != nil {
		if savepoint && p.sess.tx != nil && ctx.Err() == nil {
			// undo only this statement; the transaction stays usable (Postgres would refuse
			// everything until a rollback otherwise)
			if _, rerr := p.sess.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT grid_stmt"); rerr != nil {
				p.resetIfBroken(rerr)
			}
		}
		p.resetIfBroken(err)
		lost := ""
		if hadTx && p.sess.tx == nil {
			lost = "; the session was reset and uncommitted changes were rolled back"
		}
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("stopped after %s (timeout)%s", timeout, lost)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, errors.New("stopped" + lost)
		}
		return nil, err
	}
	if savepoint && p.sess.tx != nil {
		p.sess.tx.ExecContext(ctx, "RELEASE SAVEPOINT grid_stmt")
	}
	if d.implicitCommit(text) && p.sess.tx != nil { // Oracle committed everything with the DDL
		p.sess.tx.Commit()
		p.sess.endTx()
	}
	res.Millis = time.Since(start).Milliseconds()
	res.InTx = p.sess.tx != nil
	return res, nil
}

// beginTx opens the UI transaction. database/sql rolls a transaction back when its context
// ends, so it gets its own long-lived one. Caller holds sess.mu.
func (p *pool) beginTx() error {
	txCtx, txCancel := context.WithCancel(context.Background())
	tx, err := p.sess.conn.BeginTx(txCtx, nil)
	if err != nil {
		txCancel()
		return err
	}
	p.sess.tx, p.sess.txCancel = tx, txCancel
	return nil
}

// abandon gives up on a statement that is still running: the session is detached (so the next
// run gets a fresh connection) and the old connection is closed once the statement ends.
// Its transaction, if any, is rolled back by database/sql when the transaction context ends.
// Caller holds sess.mu.
func (p *pool) abandon(done <-chan outcome) {
	old := p.sess.conn
	p.sess.conn = nil
	p.sess.endTx()
	if old != nil {
		go func() {
			<-done
			old.Close()
		}()
	}
}

// resetIfBroken drops the session after a connection-level failure, so the next run reconnects.
func (p *pool) resetIfBroken(err error) {
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) ||
		strings.Contains(err.Error(), "closed") {
		p.resetSession()
	}
}

// Cancel stops the statement running in the UI session of name.
func (m *Manager) Cancel(name string) {
	m.mu.Lock()
	p := m.pools[key(name)]
	m.mu.Unlock()
	if p == nil {
		return
	}
	p.cmu.Lock()
	if p.sess.cancel != nil {
		p.sess.cancel()
	}
	p.cmu.Unlock()
}

// Commit / Rollback end the open transaction of the UI session.
func (m *Manager) Commit(name string) error   { return m.endTx(name, true) }
func (m *Manager) Rollback(name string) error { return m.endTx(name, false) }

func (m *Manager) endTx(name string, commit bool) error {
	m.mu.Lock()
	p := m.pools[key(name)]
	m.mu.Unlock()
	if p == nil {
		return nil
	}
	if !p.sess.mu.TryLock() {
		return ErrBusy
	}
	defer p.sess.mu.Unlock()
	tx := p.sess.tx
	if tx == nil {
		return nil
	}
	defer p.sess.endTx()
	if commit {
		return tx.Commit()
	}
	return tx.Rollback()
}

// Disconnect rolls back anything open and closes the connection (it reopens on the next use).
func (m *Manager) Disconnect(name string) {
	m.Forget(name)
}

func query(ctx context.Context, d dialect, r runner, text string, maxRows, offset int) (*Result, error) {
	rows, err := r.QueryContext(ctx, text)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return readRows(rows, d, maxRows, offset)
}

func exec(ctx context.Context, r runner, text string) (*Result, error) {
	res, err := r.ExecContext(ctx, text)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	return &Result{Kind: "update", RowsAffected: n}, nil
}

func readRows(rows *sql.Rows, d dialect, maxRows, offset int) (*Result, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	types, _ := rows.ColumnTypes()
	out := &Result{Kind: "rows", Rows: [][]*string{}, Offset: offset}
	for i, c := range cols {
		t := ""
		if i < len(types) {
			t = types[i].DatabaseTypeName()
		}
		out.Columns = append(out.Columns, Column{Name: c, Type: t})
	}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for skipped := 0; skipped < offset; skipped++ { // paging: rows before this page are read and dropped
		if !rows.Next() {
			return out, rows.Err()
		}
	}
	for rows.Next() {
		if len(out.Rows) >= maxRows {
			out.Truncated = true
			break
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make([]*string, len(cols))
		for i, v := range vals {
			t := ""
			if i < len(out.Columns) {
				t = out.Columns[i].Type
			}
			row[i] = d.formatCell(v, t)
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// AIQuery runs one statement for an AI agent in its own short session:
// read-only connections get a READ ONLY transaction and SELECT / WITH only;
// read-write ones may run anything and the statement is committed on success.
func (m *Manager) AIQuery(ctx context.Context, name, text string, maxRows int, write bool) (*Result, error) {
	p, err := m.get(name)
	if err != nil {
		return nil, err
	}
	switch p.conn.MCP {
	case MCPOff:
		return nil, fmt.Errorf("connection %q is not shared with AI (see its MCP access setting)", name)
	case MCPReadOnly:
		if write {
			return nil, fmt.Errorf("connection %q is read-only for AI (set its MCP access to read & write to change data)", name)
		}
	}
	text = p.d.prepare(text)
	// refuse before touching the database
	if write {
		err = p.d.checkSingle(text)
	} else {
		err = p.d.checkReadOnly(text)
	}
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, m.AITimeout)
	defer cancel()
	// like Run: answer on time even when the driver cannot interrupt the server
	done := make(chan outcome, 1)
	go func() {
		res, err := m.aiRun(ctx, p, text, maxRows, write)
		done <- outcome{res, err}
	}()
	select {
	case o := <-done:
		return o.res, o.err
	case <-ctx.Done():
		select {
		case o := <-done:
			return o.res, o.err
		default:
			return nil, fmt.Errorf("stopped after %s (timeout); the database may still be finishing the statement, but its changes are rolled back", m.AITimeout)
		}
	}
}

// aiRun does the work of AIQuery on its own pooled connection.
func (m *Manager) aiRun(ctx context.Context, p *pool, text string, maxRows int, write bool) (*Result, error) {
	conn, err := p.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	start := time.Now()

	if !write {
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, "SET TRANSACTION READ ONLY"); err != nil {
			return nil, fmt.Errorf("cannot start a read-only transaction: %w", err)
		}
		res, err := query(ctx, p.d, tx, text, maxRows, 0)
		if err != nil {
			return nil, err
		}
		res.Millis = time.Since(start).Milliseconds()
		return res, nil
	}

	if p.d.noTx(text) { // e.g. VACUUM: cannot run in a transaction
		res, err := exec(ctx, conn, text)
		if err != nil {
			return nil, err
		}
		res.Millis = time.Since(start).Milliseconds()
		return res, nil
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var res *Result
	if p.d.returnsRows(text) {
		res, err = query(ctx, p.d, tx, text, maxRows, 0)
	} else {
		res, err = exec(ctx, tx, text)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	res.Millis = time.Since(start).Milliseconds()
	return res, nil
}
