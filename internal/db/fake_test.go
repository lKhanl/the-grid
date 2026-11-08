//go:build db || oracle || postgres

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
	"testing"
)

// ---- a fake database/sql driver that records what is sent to it ----

type fake struct {
	mu      sync.Mutex
	log     []string
	handler func(q string) ([]string, [][]driver.Value, error)
	block   chan struct{} // when set, queries wait for it (or for their context)
	// stubborn: the driver cannot interrupt a running statement (go-ora on Windows)
	stubborn bool
	closed   int
	execErr  func(q string) error // when set, statements it fails get that error
}

func (f *fake) record(s string) {
	f.mu.Lock()
	f.log = append(f.log, s)
	f.mu.Unlock()
}
func (f *fake) setBlock(ch chan struct{}, stubborn bool) {
	f.mu.Lock()
	f.block, f.stubborn = ch, stubborn
	f.mu.Unlock()
}
func (f *fake) closedCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}
func (f *fake) entries() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fake) Connect(context.Context) (driver.Conn, error) { return &fconn{f}, nil }
func (f *fake) Driver() driver.Driver                        { return nil }

type fconn struct{ f *fake }

func (c *fconn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not used") }
func (c *fconn) Close() error {
	c.f.mu.Lock()
	c.f.closed++
	c.f.mu.Unlock()
	return nil
}
func (c *fconn) Begin() (driver.Tx, error) { c.f.record("BEGIN"); return &ftx{c.f}, nil }
func (c *fconn) QueryContext(ctx context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	c.f.record("Q: " + q)
	c.f.mu.Lock()
	block, stubborn := c.f.block, c.f.stubborn
	c.f.mu.Unlock()
	if block != nil {
		if stubborn {
			<-block
		} else {
			select {
			case <-block:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	cols, vals, err := c.f.handler(q)
	if err != nil {
		return nil, err
	}
	return &frows{cols: cols, vals: vals}, nil
}
func (c *fconn) ExecContext(ctx context.Context, q string, _ []driver.NamedValue) (driver.Result, error) {
	c.f.record("X: " + q)
	if c.f.execErr != nil {
		if err := c.f.execErr(q); err != nil {
			return nil, err
		}
	}
	return driver.RowsAffected(3), nil
}

type ftx struct{ f *fake }

func (t *ftx) Commit() error   { t.f.record("COMMIT"); return nil }
func (t *ftx) Rollback() error { t.f.record("ROLLBACK"); return nil }

type frows struct {
	cols []string
	vals [][]driver.Value
	i    int
}

func (r *frows) Columns() []string { return r.cols }
func (r *frows) Close() error      { return nil }
func (r *frows) Next(dest []driver.Value) error {
	if r.i >= len(r.vals) {
		return io.EOF
	}
	copy(dest, r.vals[r.i])
	r.i++
	return nil
}

func newTestManager(t *testing.T, c Conn) (*Manager, *fake) {
	f := &fake{handler: func(q string) ([]string, [][]driver.Value, error) {
		return []string{"ID", "NAME"}, [][]driver.Value{{int64(1), "a"}, {int64(2), nil}, {int64(3), "c"}}, nil
	}}
	store := OpenStore(t.TempDir())
	if c.Host == "" {
		c.Host, c.Service, c.User = "h", "s", "u"
	}
	c.Name = "t"
	if _, err := store.Put("", c); err != nil {
		t.Fatal(err)
	}
	m := NewManager(store)
	m.Open = func(Conn) (*sql.DB, error) { return sql.OpenDB(f), nil }
	t.Cleanup(m.Close)
	return m, f
}

