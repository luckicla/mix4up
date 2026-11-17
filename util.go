package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---- registro (mix4up.log en la carpeta de datos) ----

var (
	logMu   sync.Mutex
	logFile *os.File
)

func startLog(dir string) {
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	p := filepath.Join(dir, "mix4up.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if st, err := os.Stat(p); err == nil && st.Size() > 512<<10 {
		flags |= os.O_TRUNC
	}
	logFile, _ = os.OpenFile(p, flags, 0o644)
}

func logf(format string, args ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	line := time.Now().Format("2006-01-02 15:04:05 ") + fmt.Sprintf(format, args...) + "\n"
	if logFile != nil {
		logFile.WriteString(line)
	} else {
		os.Stderr.WriteString(line)
	}
}

// ---- archivos ----

func exePath() string {
	p, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return p
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Size() > 0
}

func writeAtomic(path string, b []byte) error {
	os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(p string, v any) bool {
	b, err := os.ReadFile(p)
	return err == nil && json.Unmarshal(b, v) == nil
}

func writeJSON(p string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return writeAtomic(p, b)
}

var invalidChars = strings.NewReplacer(`<`, "_", `>`, "_", `:`, "_", `"`, "_", `/`, "_", `\`, "_", `|`, "_", `?`, "_", `*`, "_")

// cleanName: un nombre de archivo seguro en Windows.
func cleanName(n string) string {
	n = filepath.Base(strings.ReplaceAll(n, `\`, "/"))
	n = invalidChars.Replace(n)
	n = strings.Map(func(r rune) rune {
		if r < 32 {
			return -1
		}
		return r
	}, n)
	n = strings.Trim(n, " .")
	if r := []rune(n); len(r) > 150 {
		n = string(r[:140]) + filepath.Ext(n)
	}
	return n
}

// ---- red ----

var netClient = &http.Client{Timeout: 20 * time.Second}

func getJSON(u string, v any) error {
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", "Mix4Up/"+version)
	req.Header.Set("Accept", "application/json")
	r, err := netClient.Do(req)
	if err != nil {
		return err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return fmt.Errorf("%s: %s", u, r.Status)
	}
	return json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(v)
}

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

// localOnly: solo peticiones a 127.0.0.1 desde páginas de 127.0.0.1, y para
// la API, con la cookie que se le dio a la página de Mix4Up (así ninguna web
// abierta en un navegador puede usar la sesión de YouTube guardada aquí).
func (s *server) localOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		origin := r.Header.Get("Origin")
		if (host != "127.0.0.1" && host != "localhost") ||
			(origin != "" && !strings.HasPrefix(origin, "http://127.0.0.1:") && !strings.HasPrefix(origin, "http://localhost:")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		p := r.URL.Path
		open := p == "/" || p == "/index.html" || p == "/api/version" || p == "/api/quit" || !strings.Contains(p[1:], "/") && !strings.HasPrefix(p, "/api") ||
			strings.HasPrefix(p, "/css/") || strings.HasPrefix(p, "/js/") || strings.HasPrefix(p, "/img/") || strings.HasPrefix(p, "/fonts/")
		if p == "/" || p == "/index.html" {
			http.SetCookie(w, &http.Cookie{Name: "m4", Value: s.token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		}
		if !open {
			c, err := r.Cookie("m4")
			if (err != nil || c.Value != s.token) && r.URL.Query().Get("k") != s.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}
