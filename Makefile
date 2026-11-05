# The version comes from the VERSION file plus the git commit (stamped by Go itself).
LDFLAGS := -s -w

.PHONY: web build windows run dev vendor

web:            ## build the UI into web/dist (committed, so Go-only builds work)
	cd web && npm install && npm run build

build:          ## local binary
	go build -ldflags "$(LDFLAGS)" -o bin/grid .

windows:        ## Windows exe for the VDI
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/grid.exe .

vendor:         ## vendor Go deps so the VDI can build offline
	go mod tidy && go mod vendor

run: build
	./bin/grid -c grid.yaml

dev:            ## API on :7070 + Vite dev server with hot reload on :5173
	go run . -c grid.yaml --no-browser & cd web && npm run dev
