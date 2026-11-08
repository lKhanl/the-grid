# The version comes from the VERSION file plus the git commit (stamped by Go itself).
LDFLAGS := -s -w
# Optional modules are left out by default. The Database panel:
#   make build DB=1          both drivers (go build -tags db .)
#   make build DB=oracle     Oracle only  (go build -tags oracle .)
#   make build DB=postgres   PostgreSQL only
TAGS := $(if $(filter 1 yes true,$(DB)),-tags db,$(if $(DB),-tags $(DB),))

.PHONY: web build windows linux run dev vendor test

web:            ## build the UI into web/dist (committed, so Go-only builds work)
	cd web && npm install && npm run build

build:          ## local binary
	go build $(TAGS) -ldflags "$(LDFLAGS)" -o bin/grid .

windows:        ## Windows exe for the VDI
	GOOS=windows GOARCH=amd64 go build $(TAGS) -ldflags "$(LDFLAGS)" -o bin/grid.exe .

vendor:         ## vendor Go deps so the VDI can build offline
	go mod tidy && go mod vendor

linux:          ## Linux x86-64 binary
	GOOS=linux GOARCH=amd64 go build $(TAGS) -ldflags "$(LDFLAGS)" -o bin/grid-linux .

run: build
	./bin/grid -c grid.yaml

dev:            ## API on :7070 + Vite dev server with hot reload on :5173
	go run $(TAGS) . -c grid.yaml --no-browser & cd web && npm run dev

test:           ## Go tests of every build: none, both drivers, each driver alone
	go test ./... && go test -tags db ./... && go test -tags oracle ./... && go test -tags postgres ./...
