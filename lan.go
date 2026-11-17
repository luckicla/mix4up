package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Conectar el móvil (misma WiFi). Apagado hasta que se pide: el servidor
// normal solo escucha en 127.0.0.1. «Conectar un móvil» abre una segunda
// puerta en la red de casa, con muchas menos rutas, y enseña un QR con un
// código de un solo uso. El móvil lo cambia por una clave larga y desde
// entonces sincroniza el registro (lo visto, dónde te quedaste, listas,
// ocultos), «Seguir aquí» y, si quiere, los colores.

const lanPort = 47824

type pairedDevice struct {
	Name  string `json:"name"`
	Hash  string `json:"hash"`
	Added int64  `json:"added"`
	Seen  int64  `json:"seen"`
}

var lan_ struct {
	sync.Mutex
	ln      net.Listener
	code    string
	codeExp time.Time
	fails   int
	devices []pairedDevice
	ver     int64 // sube cuando el móvil cambió algo: la página del PC se refresca
}

// los ajustes que son «el aspecto» (se copian si el móvil lo pide)
var lookKeys = []string{"theme", "accent", "accent2", "radius", "density", "font", "cardStyle", "wallpaper", "lookVer"}

func (s *server) devicesPath() string { return filepath.Join(s.dataDir, "moviles.json") }

func (s *server) lanInit() {
	readJSON(s.devicesPath(), &lan_.devices)
	if len(lan_.devices) > 0 {
		if err := s.lanStart(); err != nil {
			logf("lan: %v", err)
		}
	}
}

func (s *server) lanSaveDevices() { writeJSON(s.devicesPath(), lan_.devices) }

func (s *server) lanStart() error {
	if lan_.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", lanPort))
	if err != nil {
		return err
	}
	lan_.ln = ln
	go http.Serve(ln, s.lanRoutes())
	logf("lan: escuchando en %d", lanPort)
	return nil
}

func (s *server) lanStop() {
	if lan_.ln != nil {
		lan_.ln.Close()
		lan_.ln = nil
	}
}

func lanIPs() []string {
	out := []string{}
	if ip := os.Getenv("MIX4UP_LAN_IP"); ip != "" {
		return []string{ip}
	}
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || !ipn.IP.IsPrivate() {
				continue
			}
			out = append(out, ipn.IP.String())
		}
	}
	for i := range out {
		if strings.HasPrefix(out[i], "192.168.") && i > 0 {
			out[0], out[i] = out[i], out[0]
			break
		}
	}
	return out
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func sixDigits() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	return fmt.Sprintf("%06d", n.Int64())
}

// /api/lan: GET estado; POST ?do=pair | cancel | forget&i=N
func (s *server) lanAPI(w http.ResponseWriter, r *http.Request) {
	lan_.Lock()
	defer lan_.Unlock()
	if r.Method == http.MethodPost {
		switch r.URL.Query().Get("do") {
		case "pair":
			if err := s.lanStart(); err != nil {
				http.Error(w, "No se pudo abrir la conexión: "+err.Error(), http.StatusInternalServerError)
				return
			}
			lan_.code, lan_.codeExp, lan_.fails = sixDigits(), time.Now().Add(10*time.Minute), 0
		case "cancel":
			lan_.code = ""
			if len(lan_.devices) == 0 {
				s.lanStop()
			}
		case "forget":
			var i int
			fmt.Sscan(r.URL.Query().Get("i"), &i)
			if i >= 0 && i < len(lan_.devices) {
				lan_.devices = append(lan_.devices[:i], lan_.devices[i+1:]...)
				s.lanSaveDevices()
			}
			if len(lan_.devices) == 0 && lan_.code == "" {
				s.lanStop()
			}
		}
	}
	code := lan_.code
	if time.Now().After(lan_.codeExp) {
		code = ""
	}
	devs := make([]map[string]any, len(lan_.devices))
	for i, d := range lan_.devices {
		devs[i] = map[string]any{"name": d.Name, "added": d.Added, "seen": d.Seen}
	}
	jsonOut(w, map[string]any{"on": lan_.ln != nil, "ips": lanIPs(), "port": lanPort, "name": hostName(),
		"code": code, "devices": devs, "ver": lan_.ver})
}

var originOK = regexp.MustCompile(`^http://(127\.0\.0\.1|localhost):\d{1,5}$`)

func (s *server) lanRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/lan/pair", s.lanPair)
	mux.HandleFunc("/lan/state", s.lanAuth(s.lanState))
	mux.HandleFunc("/lan/journal", s.lanAuth(func(w http.ResponseWriter, r *http.Request) { s.journalDoc(w, r, true) }))
	mux.HandleFunc("/lan/now", s.lanAuth(s.nowAPI))
	mux.HandleFunc("/lan/video/", s.lanAuth(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/video/" + strings.TrimPrefix(r.URL.Path, "/lan/video/")
		s.lib.serveVideo(w, r)
	}))
	mux.HandleFunc("/lan/thumb/", s.lanAuth(func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/thumb/" + strings.TrimPrefix(r.URL.Path, "/lan/thumb/")
		r.Method = http.MethodGet
		s.lib.thumb(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); originOK.MatchString(o) {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func tokenHash(t string) string { h := sha256.Sum256([]byte(t)); return hex.EncodeToString(h[:]) }

func (s *server) lanAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("t") // <video src> no manda cabeceras
		}
		h := tokenHash(tok)
		lan_.Lock()
		ok := false
		for i := range lan_.devices {
			if subtle.ConstantTimeCompare([]byte(lan_.devices[i].Hash), []byte(h)) == 1 {
				ok = true
				if time.Now().Unix()-lan_.devices[i].Seen > 60 {
					lan_.devices[i].Seen = time.Now().Unix()
					s.lanSaveDevices()
				}
			}
		}
		lan_.Unlock()
		if tok == "" || !ok {
			http.Error(w, "not paired", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func (s *server) lanPair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", http.StatusMethodNotAllowed)
		return
	}
	var v struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&v) != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	lan_.Lock()
	defer lan_.Unlock()
	if lan_.code == "" || time.Now().After(lan_.codeExp) {
		http.Error(w, "El código ha caducado. Pide uno nuevo en el PC.", http.StatusGone)
		return
	}
	if subtle.ConstantTimeCompare([]byte(lan_.code), []byte(strings.TrimSpace(v.Code))) != 1 {
		if lan_.fails++; lan_.fails >= 5 {
			lan_.code = ""
		}
		http.Error(w, "Código incorrecto", http.StatusForbidden)
		return
	}
	name := strings.TrimSpace(v.Name)
	if name == "" || len(name) > 60 {
		name = "Móvil"
	}
	tok := randomHex(32)
	var keep []pairedDevice
	for _, d := range lan_.devices {
		if !strings.EqualFold(d.Name, name) {
			keep = append(keep, d)
		}
	}
	lan_.devices = append(keep, pairedDevice{Name: name, Hash: tokenHash(tok), Added: time.Now().Unix(), Seen: time.Now().Unix()})
	lan_.code = ""
	s.lanSaveDevices()
	logf("lan: emparejado %s", name)
	jsonOut(w, map[string]string{"token": tok, "name": hostName()})
}

// /lan/state: GET lo que el móvil necesita (aspecto, vídeos del PC); PUT su aspecto
func (s *server) lanState(w http.ResponseWriter, r *http.Request) {
	setPath := filepath.Join(s.dataDir, "settings.json")
	all := map[string]json.RawMessage{}
	readJSON(setPath, &all)
	switch r.Method {
	case http.MethodGet:
		look := map[string]json.RawMessage{}
		for _, k := range lookKeys {
			if v, ok := all[k]; ok {
				look[k] = v
			}
		}
		s.lib.mu.Lock()
		vids := make([]video, 0, len(s.lib.videos))
		for _, v := range s.lib.videos {
			vids = append(vids, *v)
		}
		s.lib.mu.Unlock()
		jsonOut(w, map[string]any{"name": hostName(), "version": version, "look": look, "videos": vids})
	case http.MethodPut:
		var v struct {
			Look map[string]json.RawMessage `json:"look"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&v) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		for _, k := range lookKeys {
			if x, ok := v.Look[k]; ok && json.Valid(x) {
				all[k] = x
			}
		}
		writeJSON(setPath, all)
		lan_.Lock()
		lan_.ver++
		lan_.Unlock()
		w.WriteHeader(http.StatusNoContent)
	}
}
