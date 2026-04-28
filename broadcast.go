package main

import (
	"sync"
)

// Broadcaster reads from a PTY once and fans out to all connected WebSocket clients
type Broadcaster struct {
	mu       sync.Mutex
	clients  map[int]chan []byte
	nextID   int
	running  bool
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{
		clients: make(map[int]chan []byte),
	}
}

func (b *Broadcaster) Subscribe() (int, chan []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.nextID
	b.nextID++
	ch := make(chan []byte, 64)
	b.clients[id] = ch
	return id, ch
}

func (b *Broadcaster) Unsubscribe(id int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if ch, ok := b.clients[id]; ok {
		close(ch)
		delete(b.clients, id)
	}
}

// CloseAll drops every subscriber so existing WS goroutines unblock and
// return. Used by the runtime switch path so old WS clients receive close
// frames and reconnect against the new active runtime.
func (b *Broadcaster) CloseAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.clients {
		close(ch)
		delete(b.clients, id)
	}
}

func (b *Broadcaster) broadcast(data []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.clients {
		select {
		case ch <- append([]byte(nil), data...): // copy data
		default:
			// Client too slow, drop
			close(ch)
			delete(b.clients, id)
		}
	}
}

func (b *Broadcaster) Start(pty *platformPTY, onExit func()) {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return
	}
	b.running = true
	b.mu.Unlock()

	// Wrap onExit in sync.Once so an explicit teardown (e.g. runtime switch)
	// followed by the PTY-EOF path does not double-invoke cleanup and
	// double-delete from the sessions/broadcasters maps.
	var once sync.Once
	fire := func() {
		if onExit != nil {
			once.Do(onExit)
		}
	}

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				b.broadcast(buf[:n])
			}
			if err != nil {
				b.broadcast([]byte("\r\n[Session ended]"))
				fire()
				return
			}
		}
	}()
}
