package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// La biblioteca de vídeos de este PC: la carpeta Vídeos (y las que se añadan).

var videoExts = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv",
	".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".3gp": "video/3gpp",
	".ogv": "video/ogg", ".mts": "video/mp2t",
}

// los que el reproductor de la ventana suele poder abrir tal cual
var nativeExts = map[string]bool{".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mkv": true, ".ogv": true}

type video struct {
	ID     string  `json:"id"`
	Key    string  `json:"key"` // la misma en todos los aparatos (nombre + tamaño)
	Title  string  `json:"title"`
	File   string  `json:"file"`
	Folder string  `json:"folder"`
	Size   int64   `json:"size"`
	Mtime  int64   `json:"mtime"`
	Dur    float64 `json:"dur"`
	Ext    string  `json:"ext"`
	Native bool    `json:"native"`
	Thumb  bool    `json:"thumb"`
	path   string
}

type durEntry struct {
	Size  int64   `json:"s"`
	Mtime int64   `json:"m"`
	Dur   float64 `json:"d"`
}

type library struct {
	s       *server
	mu      sync.Mutex
	videos  []*video
	byID    map[string]*video
	scanned time.Time
	durs    map[string]durEntry
	wake    chan struct{}
}

func newLibrary(s *server) *library {
	l := &library{s: s, byID: map[string]*video{}, durs: map[string]durEntry{}, wake: make(chan struct{}, 1)}
	readJSON(filepath.Join(s.dataDir, "duraciones.json"), &l.durs)
	return l
}

func (l *library) downloadDir() string {
	if l.s.portable {
		return filepath.Join(l.s.root, "Vídeos Mix4Up")
	}
	return filepath.Join(userVideosDir(), "Mix4Up")
}

type folderList struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
}

func (l *library) folderDoc() folderList {
	var f folderList
	readJSON(filepath.Join(l.s.dataDir, "carpetas.json"), &f)
	return f
}

// las carpetas que se leen
func (l *library) folders() []string {
	base := []string{userVideosDir()}
	if l.s.portable {
		base = []string{l.s.root}
	}
	f := l.folderDoc()
	gone := map[string]bool{}
	for _, r := range f.Removed {
		gone[strings.ToLower(r)] = true
	}
	var out []string
	seen := map[string]bool{}
	for _, p := range append(append(base, f.Added...), l.downloadDir()) {
		k := strings.ToLower(filepath.Clean(p))
		if seen[k] || gone[k] {
			continue
		}
		seen[k] = true
		out = append(out, filepath.Clean(p))
	}
	return out
}

// /api/folders POST {add: ruta} | {remove: ruta}
func (l *library) foldersAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var v struct{ Add, Remove string }
		if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&v) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		f := l.folderDoc()
		if v.Add != "" {
			st, err := os.Stat(v.Add)
			if err != nil || !st.IsDir() {
				http.Error(w, "Esa carpeta no existe", http.StatusBadRequest)
				return
			}
			f.Added = append(f.Added, filepath.Clean(v.Add))
			f.Removed = without(f.Removed, v.Add)
		}
		if v.Remove != "" {
			f.Added = without(f.Added, v.Remove)
			f.Removed = append(f.Removed, filepath.Clean(v.Remove))
		}
		writeJSON(filepath.Join(l.s.dataDir, "carpetas.json"), f)
		l.rescan()
	}
	jsonOut(w, map[string]any{"folders": l.folders(), "downloads": l.downloadDir()})
}

func without(list []string, p string) []string {
	var out []string
	for _, x := range list {
		if !strings.EqualFold(filepath.Clean(x), filepath.Clean(p)) {
			out = append(out, x)
		}
	}
	return out
}

func (l *library) rescan() {
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

// scanLoop: al arrancar, cuando se pide, y cada 2 minutos (vídeos nuevos, descargas).
func (l *library) scanLoop() {
	for {
		l.scan()
		select {
		case <-l.wake:
		case <-time.After(2 * time.Minute):
		}
	}
}

var skipDirs = map[string]bool{".mix4up": true, ".zentor": true, "$recycle.bin": true, "system volume information": true,
	"node_modules": true, "appdata": true, "windows": true, "program files": true, "program files (x86)": true, "library": true}

func (l *library) scan() {
	var found []*video
	n := 0
	for _, root := range l.folders() {
		filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			name := d.Name()
			if d.IsDir() {
				if p != root && (strings.HasPrefix(name, ".") || skipDirs[strings.ToLower(name)]) {
					return filepath.SkipDir
				}
				if strings.Count(strings.TrimPrefix(p, root), string(os.PathSeparator)) > 8 {
					return filepath.SkipDir
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(name))
			if videoExts[ext] == "" || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".part") {
				return nil
			}
			if n++; n > 30000 {
				return filepath.SkipAll
			}
			info, err := d.Info()
			if err != nil || info.Size() < 32<<10 {
				return nil
			}
			found = append(found, l.makeVideo(root, p, info))
			return nil
		})
	}
	// los que cuesta abrir, en un segundo plano: su duración
	l.mu.Lock()
	seen := map[string]bool{}
	var list []*video
	by := map[string]*video{}
	for _, v := range found {
		if seen[v.ID] {
			continue
		}
		seen[v.ID] = true
		list = append(list, v)
		by[v.ID] = v
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Mtime > list[j].Mtime })
	l.videos, l.byID, l.scanned = list, by, time.Now()
	l.mu.Unlock()
	l.fillDurations(list)
}

func idOf(p string) string {
	h := sha1.Sum([]byte(strings.ToLower(p)))
	return hex.EncodeToString(h[:6])
}

var cleanTitle = regexp.MustCompile(`[._]+`)

func (l *library) makeVideo(root, p string, info os.FileInfo) *video {
	name := info.Name()
	ext := strings.ToLower(filepath.Ext(name))
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	title := stem
	if !strings.Contains(stem, " ") {
		title = strings.TrimSpace(cleanTitle.ReplaceAllString(stem, " "))
	}
	folder, _ := filepath.Rel(root, filepath.Dir(p))
	if folder == "." {
		folder = filepath.Base(root)
	}
	v := &video{
		ID: idOf(p), Title: title, File: name, Folder: folder, Size: info.Size(), Mtime: info.ModTime().UnixMilli(),
		Ext: strings.TrimPrefix(ext, "."), Native: nativeExts[ext], path: p,
		Key: "lv:" + strings.ToLower(name) + "|" + strconv.FormatInt(info.Size(), 10),
	}
	v.Thumb = fileExists(filepath.Join(l.s.dataDir, "miniaturas", v.ID+".jpg"))
	l.mu.Lock()
	if d, ok := l.durs[p]; ok && d.Size == v.Size && d.Mtime == v.Mtime {
		v.Dur = d.Dur
	}
	l.mu.Unlock()
	return v
}

func (l *library) fillDurations(list []*video) {
	changed := false
	for _, v := range list {
		if v.Dur > 0 {
			continue
		}
		d := fileDuration(v.path)
		if d <= 0 && ffprobePath() != "" {
			d = probeDuration(v.path)
		}
		l.mu.Lock()
		v.Dur = d
		l.durs[v.path] = durEntry{v.Size, v.Mtime, d}
		l.mu.Unlock()
		changed = true
	}
	if changed {
		l.mu.Lock()
		// solo los que siguen existiendo
		keep := map[string]durEntry{}
		for _, v := range l.videos {
			if d, ok := l.durs[v.path]; ok {
				keep[v.path] = d
			}
		}
		l.durs = keep
		b, _ := json.Marshal(keep)
		l.mu.Unlock()
		writeAtomic(filepath.Join(l.s.dataDir, "duraciones.json"), b)
	}
}

func (l *library) get(id string) *video {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.byID[id]
}

// /api/videos (?rescan=1)
func (l *library) api(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("rescan") != "" {
		l.scan()
	}
	for i := 0; i < 100 && l.scannedAt().IsZero(); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	l.mu.Lock()
	list := make([]video, 0, len(l.videos))
	for _, v := range l.videos {
		list = append(list, *v)
	}
	l.mu.Unlock()
	jsonOut(w, map[string]any{"videos": list, "folders": l.folders(), "downloads": l.downloadDir()})
}

func (l *library) scannedAt() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.scanned
}

func (l *library) serveVideo(w http.ResponseWriter, r *http.Request) {
	v := l.get(strings.TrimPrefix(r.URL.Path, "/video/"))
	if v == nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(v.path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	ct := videoExts["."+v.Ext]
	if v.Ext == "mkv" {
		ct = "video/webm" // (Chromium lo abre como WebM; con su tipo real no lo intentaría)
	}
	if v.Ext == "mov" {
		ct = "video/mp4"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, "", time.UnixMilli(v.Mtime), f)
}

// /compat/<id>?t=<s>: un vídeo que la ventana no sabe abrir (AVI, WMV…), pasado
// a MP4 al vuelo con ffmpeg (se baja solo la primera vez).
func (l *library) serveCompat(w http.ResponseWriter, r *http.Request) {
	v := l.get(strings.TrimPrefix(r.URL.Path, "/compat/"))
	if v == nil {
		http.NotFound(w, r)
		return
	}
	ff := ffmpegPath()
	if ff == "" {
		ensureFFmpeg()
		if ff = ffmpegPath(); ff == "" {
			http.Error(w, "No se pudo preparar el convertidor (ffmpeg). Mira tu conexión.", http.StatusServiceUnavailable)
			return
		}
	}
	t, _ := strconv.ParseFloat(r.URL.Query().Get("t"), 64)
	args := []string{"-hide_banner", "-loglevel", "error"}
	if t > 0 {
		args = append(args, "-ss", strconv.FormatFloat(t, 'f', 2, 64))
	}
	args = append(args, "-i", v.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", "scale='min(1920,iw)':-2",
		"-c:a", "aac", "-b:a", "160k", "-ac", "2",
		"-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, ff, args...)
	hideConsole(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	n, _ := io.Copy(w, out)
	cmd.Wait()
	if n == 0 && stderr.Len() > 0 {
		logf("compat %s: %s", v.File, strings.TrimSpace(stderr.String()))
	}
}

// /thumb/<id>: la miniatura (la hace la página con un fotograma y la guarda aquí).
func (l *library) thumb(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/thumb/")
	if !playlistID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(l.s.dataDir, "miniaturas", id+".jpg")
	switch r.Method {
	case http.MethodPut:
		b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil || !bytes.HasPrefix(b, []byte{0xFF, 0xD8}) {
			http.Error(w, "jpeg", http.StatusBadRequest)
			return
		}
		writeAtomic(p, b)
		if v := l.get(id); v != nil {
			l.mu.Lock()
			v.Thumb = true
			l.mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		// sin miniatura aún: con ffmpeg (si está), un fotograma ya mismo
		if !fileExists(p) {
			if v := l.get(id); v != nil && ffmpegPath() != "" {
				l.makeThumb(v, p)
			}
		}
		if !fileExists(p) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "max-age=86400")
		http.ServeFile(w, r, p)
	}
}

var thumbSem = make(chan struct{}, 2)

func (l *library) makeThumb(v *video, p string) {
	thumbSem <- struct{}{}
	defer func() { <-thumbSem }()
	if fileExists(p) {
		return
	}
	at := 5.0
	if v.Dur > 0 {
		at = min(30, v.Dur*0.15)
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, ffmpegPath(), "-v", "error", "-ss", strconv.FormatFloat(at, 'f', 1, 64), "-i", v.path, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "-y", p+".tmp.jpg")
	hideConsole(c)
	if c.Run() == nil && fileExists(p+".tmp.jpg") {
		os.Rename(p+".tmp.jpg", p)
		l.mu.Lock()
		v.Thumb = true
		l.mu.Unlock()
	} else {
		os.Remove(p + ".tmp.jpg")
	}
}

var playlistID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ---- subtítulos: los .srt/.vtt al lado del vídeo, y los que lleva dentro ----

type subInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Lang string `json:"lang"`
}

func (l *library) subsList(w http.ResponseWriter, r *http.Request) {
	v := l.get(strings.TrimPrefix(r.URL.Path, "/api/subs/"))
	if v == nil {
		http.NotFound(w, r)
		return
	}
	jsonOut(w, l.subsOf(v))
}

func (l *library) subsOf(v *video) []subInfo {
	out := []subInfo{}
	stem := strings.TrimSuffix(filepath.Base(v.path), filepath.Ext(v.path))
	ents, _ := os.ReadDir(filepath.Dir(v.path))
	for _, e := range ents {
		n := e.Name()
		ext := strings.ToLower(filepath.Ext(n))
		if (ext != ".srt" && ext != ".vtt") || !strings.HasPrefix(strings.ToLower(n), strings.ToLower(stem)) {
			continue
		}
		lang := strings.Trim(strings.TrimSuffix(n[len(stem):], filepath.Ext(n)), ". _-")
		out = append(out, subInfo{ID: "f:" + n, Name: map[bool]string{true: "Subtítulos", false: lang}[lang == ""], Lang: lang})
	}
	if fp := ffprobePath(); fp != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		c := exec.CommandContext(ctx, fp, "-v", "error", "-select_streams", "s", "-show_entries", "stream=index,codec_name:stream_tags=language,title", "-of", "json", v.path)
		hideConsole(c)
		if b, err := c.Output(); err == nil {
			var j struct {
				Streams []struct {
					Codec string            `json:"codec_name"`
					Tags  map[string]string `json:"tags"`
				} `json:"streams"`
			}
			json.Unmarshal(b, &j)
			for i, s := range j.Streams {
				if s.Codec == "hdmv_pgs_subtitle" || s.Codec == "dvd_subtitle" || s.Codec == "dvb_subtitle" {
					continue // son imágenes, no texto
				}
				name := s.Tags["title"]
				if name == "" {
					name = s.Tags["language"]
				}
				if name == "" {
					name = fmt.Sprintf("Pista %d", i+1)
				}
				out = append(out, subInfo{ID: fmt.Sprintf("e:%d", i), Name: name + " (del vídeo)", Lang: s.Tags["language"]})
			}
		}
	}
	return out
}

// /subfile/<id>/<sub id>: como WebVTT
func (l *library) subFile(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/subfile/")
	id, sid, _ := strings.Cut(rest, "/")
	v := l.get(id)
	if v == nil {
		http.NotFound(w, r)
		return
	}
	var text string
	switch {
	case strings.HasPrefix(sid, "f:"):
		n := filepath.Base(strings.TrimPrefix(sid, "f:"))
		b, err := os.ReadFile(filepath.Join(filepath.Dir(v.path), n))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		text = string(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")))
		if strings.HasSuffix(strings.ToLower(n), ".srt") {
			text = srtToVTT(text)
		}
	case strings.HasPrefix(sid, "e:") && ffmpegPath() != "":
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		c := exec.CommandContext(ctx, ffmpegPath(), "-v", "error", "-i", v.path, "-map", "0:s:"+strings.TrimPrefix(sid, "e:"), "-f", "webvtt", "pipe:1")
		hideConsole(c)
		b, err := c.Output()
		if err != nil {
			http.Error(w, "No se pudieron sacar los subtítulos", 500)
			return
		}
		text = string(b)
	default:
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	io.WriteString(w, text)
}

var srtTime = regexp.MustCompile(`(\d{1,2}:\d{2}:\d{2}),(\d{3})`)

func srtToVTT(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return "WEBVTT\n\n" + srtTime.ReplaceAllString(s, "$1.$2")
}

func (l *library) reveal(w http.ResponseWriter, r *http.Request) {
	if v := l.get(r.URL.Query().Get("id")); v != nil && r.Method == http.MethodPost {
		revealFile(v.path)
	}
	w.WriteHeader(http.StatusNoContent)
}

// /api/delete?id= (POST): borra el archivo para siempre (la página pregunta antes)
func (l *library) deleteVideo(w http.ResponseWriter, r *http.Request) {
	v := l.get(r.URL.Query().Get("id"))
	if v == nil || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	inside := false
	for _, f := range l.folders() {
		if rel, err := filepath.Rel(f, v.path); err == nil && !strings.HasPrefix(rel, "..") {
			inside = true
		}
	}
	if !inside {
		http.Error(w, "fuera de tus carpetas", http.StatusForbidden)
		return
	}
	if err := os.Remove(v.path); err != nil {
		http.Error(w, "No se pudo borrar: "+err.Error(), 500)
		return
	}
	logf("borrado %s", v.path)
	os.Remove(filepath.Join(l.s.dataDir, "miniaturas", v.ID+".jpg"))
	l.scan()
	w.WriteHeader(http.StatusNoContent)
}

// ---- duración sin abrir el vídeo entero (MP4/MOV, MKV/WebM, AVI) ----

func fileDuration(p string) float64 {
	f, err := os.Open(p)
	if err != nil {
		return 0
	}
	defer f.Close()
	head := make([]byte, 12)
	if _, err := io.ReadFull(f, head); err != nil {
		return 0
	}
	switch {
	case bytes.Equal(head[4:8], []byte("ftyp")) || bytes.Equal(head[4:8], []byte("moov")) || bytes.Equal(head[4:8], []byte("mdat")) || bytes.Equal(head[4:8], []byte("wide")) || bytes.Equal(head[4:8], []byte("free")):
		return mp4Duration(f)
	case bytes.Equal(head[:4], []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return mkvDuration(f)
	case bytes.Equal(head[:4], []byte("RIFF")) && bytes.Equal(head[8:12], []byte("AVI ")):
		return aviDuration(f)
	}
	return 0
}

func mp4Duration(f *os.File) float64 {
	st, _ := f.Stat()
	end := st.Size()
	var findBox func(from, to int64, want string) (int64, int64)
	findBox = func(from, to int64, want string) (int64, int64) {
		pos := from
		h := make([]byte, 16)
		for pos+8 <= to {
			if _, err := f.ReadAt(h[:8], pos); err != nil {
				return -1, 0
			}
			size := int64(binary.BigEndian.Uint32(h[:4]))
			typ := string(h[4:8])
			hdr := int64(8)
			if size == 1 {
				if _, err := f.ReadAt(h[8:16], pos+8); err != nil {
					return -1, 0
				}
				size = int64(binary.BigEndian.Uint64(h[8:16]))
				hdr = 16
			} else if size == 0 {
				size = to - pos
			}
			if size < hdr {
				return -1, 0
			}
			if typ == want {
				return pos + hdr, pos + size
			}
			pos += size
		}
		return -1, 0
	}
	ms, me := findBox(0, end, "moov")
	if ms < 0 {
		return 0
	}
	hs, _ := findBox(ms, me, "mvhd")
	if hs < 0 {
		return 0
	}
	b := make([]byte, 32)
	if _, err := f.ReadAt(b, hs); err != nil {
		return 0
	}
	var scale, dur uint64
	if b[0] == 1 {
		scale = uint64(binary.BigEndian.Uint32(b[20:24]))
		dur = binary.BigEndian.Uint64(b[24:32])
	} else {
		scale = uint64(binary.BigEndian.Uint32(b[12:16]))
		dur = uint64(binary.BigEndian.Uint32(b[16:20]))
	}
	if scale == 0 {
		return 0
	}
	return float64(dur) / float64(scale)
}

func mkvDuration(f *os.File) float64 {
	buf := make([]byte, 1<<20)
	n, _ := io.ReadFull(io.NewSectionReader(f, 0, 1<<20), buf)
	buf = buf[:n]
	pos := 0
	readID := func() (uint32, bool) {
		if pos >= len(buf) {
			return 0, false
		}
		b := buf[pos]
		l := 1
		for m := byte(0x80); l <= 4 && b&m == 0; m >>= 1 {
			l++
		}
		if l > 4 || pos+l > len(buf) {
			return 0, false
		}
		var id uint32
		for i := 0; i < l; i++ {
			id = id<<8 | uint32(buf[pos+i])
		}
		pos += l
		return id, true
	}
	readSize := func() (int64, bool) {
		if pos >= len(buf) {
			return 0, false
		}
		b := buf[pos]
		l := 1
		m := byte(0x80)
		for ; l <= 8 && b&m == 0; m >>= 1 {
			l++
		}
		if l > 8 || pos+l > len(buf) {
			return 0, false
		}
		v := int64(b & (m - 1))
		all := v == int64(m-1)
		for i := 1; i < l; i++ {
			v = v<<8 | int64(buf[pos+i])
			all = all && buf[pos+i] == 0xFF
		}
		pos += l
		if all {
			return -1, true // tamaño desconocido
		}
		return v, true
	}
	scale := 1000000.0
	dur := 0.0
	for pos < len(buf) {
		id, ok := readID()
		if !ok {
			break
		}
		size, ok := readSize()
		if !ok {
			break
		}
		switch id {
		case 0x18538067, 0x1549A966: // Segment, Info: se entra
			continue
		case 0x2AD7B1: // TimecodeScale
			var v uint64
			for i := int64(0); i < size && pos+int(i) < len(buf); i++ {
				v = v<<8 | uint64(buf[pos+int(i)])
			}
			scale = float64(v)
		case 0x4489: // Duration
			if size == 4 && pos+4 <= len(buf) {
				dur = float64(math.Float32frombits(binary.BigEndian.Uint32(buf[pos:])))
			} else if size == 8 && pos+8 <= len(buf) {
				dur = math.Float64frombits(binary.BigEndian.Uint64(buf[pos:]))
			}
		case 0x1F43B675: // Cluster: ya no hay más cabecera
			if dur > 0 {
				return dur * scale / 1e9
			}
			return 0
		}
		if size < 0 {
			break
		}
		pos += int(size)
	}
	if dur > 0 {
		return dur * scale / 1e9
	}
	return 0
}

func aviDuration(f *os.File) float64 {
	b := make([]byte, 8192)
	n, _ := f.ReadAt(b, 0)
	i := bytes.Index(b[:n], []byte("avih"))
	if i < 0 || i+8+20 > n {
		return 0
	}
	d := b[i+8:]
	us := binary.LittleEndian.Uint32(d[0:4])
	frames := binary.LittleEndian.Uint32(d[16:20])
	return float64(us) * float64(frames) / 1e6
}

func probeDuration(p string) float64 {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, ffprobePath(), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p)
	hideConsole(c)
	b, err := c.Output()
	if err != nil {
		return 0
	}
	d, _ := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	return d
}
