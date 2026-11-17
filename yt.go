package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// La cuenta de YouTube: las cookies de la sesión (solo en este aparato, en la
// carpeta de datos; nunca salen de aquí salvo hacia youtube.com). Con ellas:
//   - la página pregunta a YouTube lo mismo que pregunta su web (InnerTube):
//     inicio, suscripciones, historial, relacionados… (/api/yt/i/<punto>).
//     Mix4Up solo pasa la pregunta y la respuesta, añadiendo la sesión.
//   - yt-dlp las usa para ver vídeos con restricción de edad, listas privadas, etc.

const ytUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
const ytOrigin = "https://www.youtube.com"

type ytCookie struct {
	Domain  string `json:"domain"`
	Path    string `json:"path"`
	Secure  bool   `json:"secure"`
	Expires int64  `json:"expires"`
	Name    string `json:"name"`
	Value   string `json:"value"`
}

type ytAccount struct {
	s       *server
	mu      sync.Mutex
	cookies []ytCookie
	saveT   *time.Timer
	cfgMu   sync.Mutex
	cfgAt   time.Time
	cfgVal  map[string]any
}

var ytHTTP = &http.Client{Timeout: 20 * time.Second}

func newYT(s *server) *ytAccount {
	a := &ytAccount{s: s}
	a.load()
	ytVisitor = func() string {
		a.cfgMu.Lock()
		defer a.cfgMu.Unlock()
		if a.cfgVal != nil {
			v, _ := a.cfgVal["visitorData"].(string)
			return v
		}
		return ""
	}
	ytCookieFile = func() string {
		if a.connected() {
			return a.file()
		}
		return ""
	}
	return a
}

func (a *ytAccount) file() string { return filepath.Join(a.s.dataDir, "youtube-cookies.txt") }

// cookies.txt (el formato de Netscape que entiende yt-dlp)
func (a *ytAccount) load() {
	b, err := os.ReadFile(a.file())
	if err != nil {
		return
	}
	list := parseNetscape(b)
	a.mu.Lock()
	a.cookies = list
	a.mu.Unlock()
}

func parseNetscape(b []byte) []ytCookie {
	var list []ytCookie
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.HasPrefix(line, "#HttpOnly_") {
			line = strings.TrimPrefix(line, "#HttpOnly_")
		} else if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		p := strings.Split(line, "\t")
		if len(p) < 7 {
			continue
		}
		exp, _ := strconv.ParseInt(p[4], 10, 64)
		list = append(list, ytCookie{Domain: p[0], Path: p[2], Secure: strings.EqualFold(p[3], "TRUE"), Expires: exp, Name: p[5], Value: p[6]})
	}
	return list
}

func (a *ytAccount) saveLocked() error {
	var b bytes.Buffer
	b.WriteString("# Netscape HTTP Cookie File\n# Mix4Up: tu sesión de YouTube. No compartas este archivo.\n")
	for _, c := range a.cookies {
		sub := "FALSE"
		if strings.HasPrefix(c.Domain, ".") {
			sub = "TRUE"
		}
		sec := "FALSE"
		if c.Secure {
			sec = "TRUE"
		}
		path := c.Path
		if path == "" {
			path = "/"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", c.Domain, sub, path, sec, c.Expires, c.Name, c.Value)
	}
	os.MkdirAll(a.s.dataDir, 0o755)
	tmp := a.file() + ".tmp"
	if err := os.WriteFile(tmp, b.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.file())
}

func (a *ytAccount) value(name string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now().Unix()
	for _, c := range a.cookies {
		if c.Name == name && strings.HasSuffix(c.Domain, "youtube.com") && (c.Expires == 0 || c.Expires > now) {
			return c.Value
		}
	}
	return ""
}

func (a *ytAccount) connected() bool {
	return a.value("SAPISID") != "" || a.value("__Secure-3PAPISID") != ""
}

// la cabecera Cookie para www.youtube.com
func (a *ytAccount) header() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now().Unix()
	var parts []string
	seen := map[string]bool{}
	for _, c := range a.cookies {
		d := strings.TrimPrefix(c.Domain, ".")
		if (d != "youtube.com" && d != "www.youtube.com") || (c.Expires != 0 && c.Expires < now) || seen[c.Name] {
			continue
		}
		seen[c.Name] = true
		parts = append(parts, c.Name+"="+c.Value)
	}
	if !seen["SOCS"] {
		parts = append(parts, "SOCS=CAI") // sin la página de «aceptar cookies» de Europa
	}
	return strings.Join(parts, "; ")
}

// lo que YouTube cambia en la sesión (Set-Cookie) se guarda
func (a *ytAccount) absorb(resp *http.Response) {
	cs := resp.Cookies()
	if len(cs) == 0 || !a.connected() {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	changed := false
	for _, c := range cs {
		if c.Name == "" {
			continue
		}
		dom := c.Domain
		if dom == "" {
			dom = ".youtube.com"
		} else if !strings.HasPrefix(dom, ".") {
			dom = "." + dom
		}
		if !strings.HasSuffix(dom, "youtube.com") {
			continue
		}
		exp := int64(0)
		if !c.Expires.IsZero() {
			exp = c.Expires.Unix()
		}
		if c.MaxAge < 0 {
			exp = 1
		}
		found := false
		for i := range a.cookies {
			if a.cookies[i].Name == c.Name && strings.TrimPrefix(a.cookies[i].Domain, ".") == strings.TrimPrefix(dom, ".") {
				if a.cookies[i].Value != c.Value {
					a.cookies[i].Value, a.cookies[i].Expires = c.Value, exp
					changed = true
				}
				found = true
			}
		}
		if !found {
			a.cookies = append(a.cookies, ytCookie{Domain: dom, Path: "/", Secure: true, Expires: exp, Name: c.Name, Value: c.Value})
			changed = true
		}
	}
	if changed {
		if a.saveT != nil {
			a.saveT.Stop()
		}
		a.saveT = time.AfterFunc(2*time.Second, func() {
			a.mu.Lock()
			a.saveLocked()
			a.mu.Unlock()
		})
	}
}

// SAPISIDHASH: la firma con la que la web de YouTube dice «soy yo» (como yt-dlp)
func (a *ytAccount) auth(userSession string) string {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	var out []string
	sign := func(scheme, sid string) {
		if sid == "" {
			return
		}
		parts := []string{}
		if userSession != "" {
			parts = append(parts, userSession)
		}
		parts = append(parts, ts, sid, ytOrigin)
		h := sha1.Sum([]byte(strings.Join(parts, " ")))
		v := ts + "_" + hex.EncodeToString(h[:])
		if userSession != "" {
			v += "_u"
		}
		out = append(out, scheme+" "+v)
	}
	sapisid := a.value("SAPISID")
	if sapisid == "" {
		sapisid = a.value("__Secure-3PAPISID")
	}
	sign("SAPISIDHASH", sapisid)
	sign("SAPISID1PHASH", a.value("__Secure-1PAPISID"))
	sign("SAPISID3PHASH", a.value("__Secure-3PAPISID"))
	return strings.Join(out, " ")
}

// ---- /api/yt/cookies: POST (la ventana de «Conectar con YouTube»), DELETE (desconectar) ----

func (a *ytAccount) cookiesAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost, http.MethodPut:
		b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var list []ytCookie
		var raw []struct {
			Name     string  `json:"name"`
			Value    string  `json:"value"`
			Domain   string  `json:"domain"`
			Path     string  `json:"path"`
			Secure   bool    `json:"secure"`
			HostOnly bool    `json:"hostOnly"`
			Exp      float64 `json:"expirationDate"`
		}
		if json.Unmarshal(b, &raw) == nil {
			for _, c := range raw {
				d := c.Domain
				if !c.HostOnly && !strings.HasPrefix(d, ".") {
					d = "." + d
				}
				if !strings.HasSuffix(d, "youtube.com") && !strings.HasSuffix(d, "google.com") {
					continue
				}
				list = append(list, ytCookie{Domain: d, Path: c.Path, Secure: c.Secure, Expires: int64(c.Exp), Name: c.Name, Value: c.Value})
			}
		} else {
			list = parseNetscape(b) // un cookies.txt de otro sitio
		}
		a.mu.Lock()
		a.cookies = list
		err = a.saveLocked()
		a.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		a.cfgMu.Lock()
		a.cfgAt = time.Time{}
		a.cfgMu.Unlock()
		ytdl.mu.Lock()
		ytdl.cache = map[string]*ytInfo{}
		ytdl.mu.Unlock()
		logf("yt: cuenta conectada (%d cookies)", len(list))
	case http.MethodDelete:
		a.mu.Lock()
		a.cookies = nil
		os.Remove(a.file())
		a.mu.Unlock()
		a.cfgMu.Lock()
		a.cfgAt = time.Time{}
		a.cfgMu.Unlock()
		logf("yt: cuenta desconectada")
	}
	jsonOut(w, map[string]any{"connected": a.connected()})
}

func (a *ytAccount) account(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, map[string]any{"connected": a.connected()})
}

// ---- /api/yt/cfg: la versión de la web de YouTube y el «visitante» (para InnerTube) ----

var (
	reClientVer = regexp.MustCompile(`"INNERTUBE_CLIENT_VERSION":"([^"]+)"`)
	reVisitor   = regexp.MustCompile(`"VISITOR_DATA":"([^"]+)"`)
	reLoggedIn  = regexp.MustCompile(`"LOGGED_IN":(true|false)`)
	reDataSync  = regexp.MustCompile(`"DATASYNC_ID":"([^"]*)"`)
	reHL        = regexp.MustCompile(`"HL":"([^"]+)"`)
	reGL        = regexp.MustCompile(`"GL":"([^"]+)"`)
)

func (a *ytAccount) getCfg(force bool) map[string]any {
	a.cfgMu.Lock()
	defer a.cfgMu.Unlock()
	if !force && a.cfgVal != nil && time.Since(a.cfgAt) < time.Hour {
		return a.cfgVal
	}
	req, _ := http.NewRequest("GET", ytOrigin+"/?hl=es&gl=ES", nil)
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Accept-Language", "es-ES,es;q=0.9")
	req.Header.Set("Cookie", a.header())
	cfg := map[string]any{"clientVersion": "2.20251114.01.00", "visitorData": "", "loggedIn": false, "hl": "es", "gl": "ES", "ok": false}
	resp, err := ytHTTP.Do(req)
	if err == nil {
		defer resp.Body.Close()
		a.absorb(resp)
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 6<<20))
		if m := reClientVer.FindSubmatch(b); m != nil {
			cfg["clientVersion"] = string(m[1])
			cfg["ok"] = true
		}
		if m := reVisitor.FindSubmatch(b); m != nil {
			cfg["visitorData"] = string(m[1])
		}
		if m := reLoggedIn.FindSubmatch(b); m != nil {
			cfg["loggedIn"] = string(m[1]) == "true"
		}
		if m := reDataSync.FindSubmatch(b); m != nil {
			cfg["dataSync"] = string(m[1])
		}
		if m := reGL.FindSubmatch(b); m != nil {
			cfg["gl"] = string(m[1])
		}
		if m := reHL.FindSubmatch(b); m != nil {
			cfg["hl"] = string(m[1])
		}
	} else {
		cfg["error"] = "Sin conexión con YouTube"
	}
	cfg["connected"] = a.connected()
	if cfg["ok"] == true {
		a.cfgVal, a.cfgAt = cfg, time.Now()
	}
	return cfg
}

func (a *ytAccount) cfg(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, a.getCfg(r.URL.Query().Get("fresh") != ""))
}

// el id de la sesión dentro de la cuenta (para la firma, como yt-dlp)
func (a *ytAccount) userSession() string {
	c := a.getCfg(false)
	ds, _ := c["dataSync"].(string)
	if ds == "" {
		return ""
	}
	first, second, _ := strings.Cut(ds, "||")
	if second != "" {
		return second
	}
	return first
}

var innertubeOK = map[string]bool{"browse": true, "next": true, "search": true, "guide": true, "player": true,
	"like/like": true, "like/removelike": true, "like/dislike": true, "subscription/subscribe": true,
	"subscription/unsubscribe": true, "browse/edit_playlist": true, "playlist/create": true,
	"account/account_menu": true, "feedback": true, "navigation/resolve_url": true, "music/get_search_suggestions": false}

// /api/yt/i/<punto> (POST, el cuerpo tal como lo espera YouTube)
func (a *ytAccount) innertube(w http.ResponseWriter, r *http.Request) {
	ep := strings.TrimPrefix(r.URL.Path, "/api/yt/i/")
	if r.Method != http.MethodPost || !innertubeOK[ep] {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil || !json.Valid(body) {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	cfg := a.getCfg(false)
	req, _ := http.NewRequest("POST", ytOrigin+"/youtubei/v1/"+ep+"?prettyPrint=false", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", ytUA)
	req.Header.Set("Origin", ytOrigin)
	req.Header.Set("Referer", ytOrigin+"/")
	req.Header.Set("X-Origin", ytOrigin)
	req.Header.Set("Accept-Language", "es-ES,es;q=0.9")
	req.Header.Set("X-Youtube-Client-Name", "1")
	if v, _ := cfg["clientVersion"].(string); v != "" {
		req.Header.Set("X-Youtube-Client-Version", v)
	}
	if v, _ := cfg["visitorData"].(string); v != "" {
		req.Header.Set("X-Goog-Visitor-Id", v)
	}
	req.Header.Set("Cookie", a.header())
	if a.connected() {
		req.Header.Set("Authorization", a.auth(a.userSession()))
		req.Header.Set("X-Goog-AuthUser", "0")
	}
	resp, err := ytHTTP.Do(req)
	if err != nil {
		http.Error(w, "Sin conexión con YouTube", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	a.absorb(resp)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, io.LimitReader(resp.Body, 24<<20))
}

// ---- /api/yt/list?u=<url>&end=<n>: una lista con yt-dlp (por si la web cambia) ----

var listOK = regexp.MustCompile(`^(https://(www|m)\.youtube\.com/[\w/@.?=&%-]+|:yt(rec|subs|history|watchlater|fav)|ytsearch\d{1,3}:.+)$`)

func (s *server) ytList(w http.ResponseWriter, r *http.Request) {
	u := r.URL.Query().Get("u")
	if !listOK.MatchString(u) {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}
	end, _ := strconv.Atoi(r.URL.Query().Get("end"))
	if end <= 0 || end > 300 {
		end = 60
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	if start <= 0 {
		start = 1
	}
	args := append(ytBaseArgs(), "--flat-playlist", "-J", "--playlist-items", fmt.Sprintf("%d:%d", start, end), "--extractor-args", "youtubetab:approximate_date", "--", u)
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	out, err := ytRun(ctx, args...)
	if err != nil {
		http.Error(w, friendly(err), http.StatusBadGateway)
		return
	}
	var j struct {
		Title   string `json:"title"`
		Entries []struct {
			ID        string  `json:"id"`
			URL       string  `json:"url"`
			Title     string  `json:"title"`
			Duration  float64 `json:"duration"`
			Channel   string  `json:"channel"`
			Uploader  string  `json:"uploader"`
			ChannelID string  `json:"channel_id"`
			Views     int64   `json:"view_count"`
			Live      string  `json:"live_status"`
			IEKey     string  `json:"ie_key"`
			Timestamp int64   `json:"timestamp"`
			Thumbs    []struct {
				URL    string `json:"url"`
				Width  int    `json:"width"`
				Height int    `json:"height"`
			} `json:"thumbnails"`
		} `json:"entries"`
	}
	json.Unmarshal(out, &j)
	type item struct {
		ID, URL, Title, Channel, ChannelID, Thumb, Live string
		Duration                                        float64
		Views, Timestamp                                int64
		Vertical                                        bool
	}
	list := []item{}
	for _, e := range j.Entries {
		it := item{ID: e.ID, URL: e.URL, Title: e.Title, Channel: e.Channel, ChannelID: e.ChannelID, Duration: e.Duration, Views: e.Views, Live: e.Live, Timestamp: e.Timestamp}
		if it.Channel == "" {
			it.Channel = e.Uploader
		}
		for _, t := range e.Thumbs {
			it.Thumb = t.URL
			it.Vertical = t.Height > t.Width && t.Width > 0
		}
		list = append(list, it)
	}
	jsonOut(w, map[string]any{"title": j.Title, "entries": list})
}

// ---- /api/yt/watched?id= (POST): que el vídeo cuente en tu historial de YouTube
// (así sus recomendaciones aprenden de lo que ves en Mix4Up) ----

func (s *server) ytWatched(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if r.Method != http.MethodPost || !ytVideoID.MatchString(id) {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	if !s.yt.connected() {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		args := append(ytBaseArgs(), "--mark-watched", "--simulate", "--no-playlist", "--", "https://www.youtube.com/watch?v="+id)
		if _, err := ytRun(ctx, args...); err != nil {
			logf("yt: marcar visto %s: %v", id, err)
		}
	}()
	w.WriteHeader(http.StatusNoContent)
}

// /api/yt/suggest?q=: lo que YouTube sugiere mientras escribes
func (s *server) ytSuggest(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 200 {
		jsonOut(w, []string{})
		return
	}
	u := "https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=es&gl=es&q=" + url.QueryEscape(q)
	req, _ := http.NewRequest("GET", u, nil)
	req.Header.Set("User-Agent", ytUA)
	resp, err := ytHTTP.Do(req)
	if err != nil {
		jsonOut(w, []string{})
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	// window.google.ac.h(["q",[["sugerencia",0,[…]],…],{…}])
	out := []string{}
	if i, j := bytes.IndexByte(b, '('), bytes.LastIndexByte(b, ')'); i >= 0 && j > i {
		var arr []json.RawMessage
		if json.Unmarshal(b[i+1:j], &arr) == nil && len(arr) > 1 {
			var list [][]json.RawMessage
			json.Unmarshal(arr[1], &list)
			for _, it := range list {
				var s string
				if len(it) > 0 && json.Unmarshal(it[0], &s) == nil && s != "" {
					out = append(out, s)
				}
			}
		}
	}
	jsonOut(w, out)
}
