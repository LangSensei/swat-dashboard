BINARY := swat-dashboard

ifeq ($(OS),Windows_NT)
	BINARY := $(BINARY).exe
endif

.PHONY: build run clean test lint

build:
	go build -o $(BINARY) .

run: build
	./$(BINARY)

clean:
	$(RM) $(BINARY)

test:
	go test ./...

lint:
	go vet ./...
