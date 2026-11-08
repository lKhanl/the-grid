//go:build !db && !oracle && !postgres

package main

import "net/http"

// Default build: no optional modules. Build with -tags db for the Database panel (both drivers),
// or -tags oracle / -tags postgres for one.

func modules() ([]func(*http.ServeMux), func()) { return nil, func() {} }
