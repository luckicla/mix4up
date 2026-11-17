package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type server struct {
	dataDir  string
	root     string // portable: la carpeta del .exe
	portable bool
	token    string
	lib      *library
	yt       *ytAccount
	dl       *downloads

	lastPing atomic.Int64
	pinged   atomic.Bool
	nowMu    sync.Mutex
	now      map[string]json.RawMessage // lo que se ve en cada aparato («Seguir aquí»)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(static))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// la página siempre fresca tras actualizar
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(version)) })
	mux.HandleFunc("/api/info", s.info)
	mux.HandleFunc("/api/quit", s.quit)
	mux.HandleFunc("/api/ping", s.ping)
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) { s.jsonDoc(w, r, "settings.json", 1<<20) })
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) { s.jsonDoc(w, r, "state.json", 8<<20) })
	mux.HandleFunc("/api/journal", func(w http.ResponseWriter, r *http.Request) { s.journalDoc(w, r, false) })
	mux.HandleFunc("/api/now", s.nowAPI)
	mux.HandleFunc("/api/power", s.power)
	// vídeos de aquí
	mux.HandleFunc("/api/videos", s.lib.api)
	mux.HandleFunc("/api/folders", s.lib.foldersAPI)
	mux.HandleFunc("/video/", s.lib.serveVideo)
	mux.HandleFunc("/compat/", s.lib.serveCompat)
	mux.HandleFunc("/thumb/", s.lib.thumb)
	mux.HandleFunc("/api/subs/", s.lib.subsList)
	mux.HandleFunc("/subfile/", s.lib.subFile)
	mux.HandleFunc("/api/reveal", s.lib.reveal)
	mux.HandleFunc("/api/delete", s.lib.deleteVideo)
	// YouTube
	mux.HandleFunc("/api/yt/i/", s.yt.innertube)
	mux.HandleFunc("/api/yt/cfg", s.yt.cfg)
	mux.HandleFunc("/api/yt/account", s.yt.account)
	mux.HandleFunc("/api/yt/cookies", s.yt.cookiesAPI)
	mux.HandleFunc("/api/yt/video", s.ytVideo)
	mux.HandleFunc("/api/yt/sub", s.ytSub)
	mux.HandleFunc("/api/yt/list", s.ytList)
	mux.HandleFunc("/api/yt/watched", s.ytWatched)
	mux.HandleFunc("/api/yt/suggest", s.ytSuggest)
	mux.HandleFunc("/api/yt/tools", s.ytTools)
	mux.HandleFunc("/ytstream/", s.ytStream)
	mux.HandleFunc("/api/yt/cache", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, cacheProgress(r.URL.Query().Get("id"))) })
	mux.HandleFunc("/api/download", s.dl.api)
	// el móvil
	mux.HandleFunc("/api/lan", s.lanAPI)
	return mux
}

func (s *server) info(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, map[string]any{
		"version": version, "platform": "pc", "portable": s.portable, "data": s.dataDir,
		"folders": s.lib.folders(), "downloads": s.lib.downloadDir(), "name": hostName(),
	})
}

// jsonDoc: un documento JSON pequeño en la carpeta de datos (GET lo lee, PUT/POST lo cambia).
func (s *server) jsonDoc(w http.ResponseWriter, r *http.Request, name string, max int64) {
	path := filepath.Join(s.dataDir, name)
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		b, err := os.ReadFile(path)
		if err != nil || !json.Valid(b) {
			b = []byte("{}")
		}
		w.Write(b)
	case http.MethodPut, http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, max))
		if err != nil || !json.Valid(b) {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if err := writeAtomic(path, b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) ping(w http.ResponseWriter, r *http.Request) {
	s.lastPing.Store(time.Now().UnixMilli())
	s.pinged.Store(true)
	w.WriteHeader(http.StatusNoContent)
}

// quit: un motor más nuevo (tras actualizar) ocupa el puerto.
func (s *server) quit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	if v := r.URL.Query().Get("v"); v == "" || buildNum(v) < buildNum(version) {
		http.Error(w, "newer", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	logf("otro Mix4Up (%s) ocupa el puerto: me voy", r.URL.Query().Get("v"))
	go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
}

// run: mientras la ventana siga viva. La app de escritorio cierra el motor al
// salir; esto es por si la app se cayera sin cerrarlo.
func (s *server) run() {
	start := time.Now()
	for range time.Tick(5 * time.Second) {
		now := time.Now().UnixMilli()
		switch {
		case shell && !s.pinged.Load() && time.Since(start) > 5*time.Minute:
			logf("la ventana nunca se conectó: salgo")
			return
		case shell && s.pinged.Load() && now-s.lastPing.Load() > 3*60*1000:
			logf("sin noticias de la ventana en 3 min: salgo")
			return
		}
	}
}

// /api/now: lo que se está viendo en cada aparato ({dev: {...}}), para «Seguir aquí».
func (s *server) nowAPI(w http.ResponseWriter, r *http.Request) {
	s.nowMu.Lock()
	defer s.nowMu.Unlock()
	if s.now == nil {
		s.now = map[string]json.RawMessage{}
	}
	if r.Method == http.MethodPut || r.Method == http.MethodPost {
		var v struct {
			Dev string          `json:"dev"`
			Now json.RawMessage `json:"now"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&v) == nil && v.Dev != "" && len(v.Dev) < 80 {
			s.now[v.Dev] = v.Now
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	jsonOut(w, s.now)
}

// /api/power?do=shutdown|cancel: el temporizador para dormir puede apagar el PC.
func (s *server) power(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var err error
	switch r.URL.Query().Get("do") {
	case "shutdown":
		logf("temporizador: apagando el PC")
		err = shutdownPC(false)
	case "cancel":
		err = shutdownPC(true)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func hostName() string {
	h, _ := os.Hostname()
	if h == "" {
		h = "PC"
	}
	return h
}
