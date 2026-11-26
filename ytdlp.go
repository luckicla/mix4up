package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Los vídeos de YouTube se ven con el reproductor de Mix4Up (sin anuncios):
// yt-dlp dice dónde están la imagen y el sonido de cada calidad y Mix4Up se
// los pasa a la página (/ytstream/<id>/<formato>). En Windows Mix4Up baja
// yt-dlp (y deno, el motor de JavaScript que yt-dlp necesita para YouTube) en
// %LOCALAPPDATA%\Mix4Up\herramientas y lo mantiene al día: YouTube cambia a
// menudo y las versiones viejas dejan de funcionar.

type ytFormat struct {
	ID      string  `json:"id"`
	Ext     string  `json:"ext"`
	Kind    string  `json:"kind"` // "v" imagen, "a" sonido, "av" las dos
	Height  int     `json:"h,omitempty"`
	Width   int     `json:"w,omitempty"`
	FPS     float64 `json:"fps,omitempty"`
	VCodec  string  `json:"vcodec,omitempty"`
	ACodec  string  `json:"acodec,omitempty"`
	TBR     float64 `json:"tbr,omitempty"`
	Size    int64   `json:"size,omitempty"`
	Lang    string  `json:"lang,omitempty"`
	Note    string  `json:"note,omitempty"`
	HDR     bool    `json:"hdr,omitempty"`
	url     string
	headers map[string]string
	mime    string
}

type ytSubTrack struct {
	Lang string `json:"lang"`
	Name string `json:"name"`
	Auto bool   `json:"auto"`
	url  string
}

type ytInfo struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Channel     string       `json:"channel"`
	ChannelID   string       `json:"channelId"`
	Duration    float64      `json:"duration"`
	Description string       `json:"description"`
	Upload      string       `json:"upload"`
	Views       int64        `json:"views"`
	Likes       int64        `json:"likes"`
	Thumb       string       `json:"thumb"`
	Live        bool         `json:"live"`
	Width       int          `json:"width"`
	Height      int          `json:"height"`
	Chapters    []ytChapter  `json:"chapters"`
	Formats     []*ytFormat  `json:"formats"`
	Subs        []ytSubTrack `json:"subs"`
	client      int
	exp         time.Time
}

type ytChapter struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Title string  `json:"title"`
}

type ytResolver struct {
	mu         sync.Mutex
	cache      map[string]*ytInfo
	inflight   map[string]*ytCall
	fails      map[string]ytFail
	toolsMu    sync.Mutex
	checked    time.Time
	busy       atomic.Bool
	goodClient int
	version    string
}

type ytFail struct {
	err error
	at  time.Time
}

type ytCall struct {
	done chan struct{}
	info *ytInfo
	err  error
}

var ytdl = &ytResolver{cache: map[string]*ytInfo{}, inflight: map[string]*ytCall{}, fails: map[string]ytFail{}}

// las cookies de la cuenta conectada (las pone yt.go)
var ytCookieFile = func() string { return "" }

// el «visitante» de la web de YouTube (lo pone yt.go)
var ytVisitor = func() string { return "" }

var dlClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 30 * time.Second}}
var ytStreamClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 20 * time.Second, MaxIdleConnsPerHost: 8}}

var ytVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// ---- las herramientas ----

func ytToolsDir() string { return filepath.Join(toolsDir(), "yt") }

func ytdlpPath() string {
	if p := os.Getenv("MIX4UP_YTDLP"); p != "" {
		return p
	}
	d := ytToolsDir()
	if b, err := os.ReadFile(filepath.Join(d, "current")); err == nil {
		p := filepath.Join(d, filepath.FromSlash(strings.TrimSpace(string(b))), ytdlpExe)
		if fileExists(p) {
			return p
		}
	}
	if p := filepath.Join(d, ytdlpExe); fileExists(p) {
		return p
	}
	if p, err := exec.LookPath("yt-dlp"); err == nil {
		return p
	}
	return ""
}

func ytdlpCurrent() string {
	b, _ := os.ReadFile(filepath.Join(ytToolsDir(), "current"))
	return string(b)
}

func denoPath() string {
	if p := filepath.Join(ytToolsDir(), denoExe); fileExists(p) {
		return p
	}
	if p, err := exec.LookPath("deno"); err == nil {
		return p
	}
	return ""
}

// prepare: baja lo que falte y actualiza yt-dlp como mucho cada 12 horas.
func (y *ytResolver) prepare() {
	if !ytDownloadTools {
		return
	}
	y.toolsMu.Lock()
	defer y.toolsMu.Unlock()
	dir := ytToolsDir()
	os.MkdirAll(dir, 0o755)
	y.busy.Store(true)
	defer y.busy.Store(false)
	if !fileExists(filepath.Join(dir, denoExe)) {
		logf("yt: descargando deno")
		if err := fetchDeno(dir); err != nil {
			logf("yt: deno: %v", err)
		}
	}
	have := ytdlpPath() != ""
	if have && time.Since(y.checked) < 12*time.Hour {
		return
	}
	tag, err := latestTag("yt-dlp/yt-dlp")
	if err != nil {
		logf("yt: yt-dlp latest: %v", err)
		if have {
			y.checked = time.Now()
		}
		return
	}
	y.checked = time.Now()
	cur, _ := os.ReadFile(filepath.Join(dir, "current"))
	if top, _, _ := strings.Cut(strings.TrimSpace(string(cur)), "/"); have && top == "ytdlp-"+tag {
		return
	}
	logf("yt: descargando yt-dlp %s", tag)
	if err := fetchYtdlp(dir, tag); err != nil {
		logf("yt: yt-dlp %s: %v", tag, err)
		return
	}
	logf("yt: yt-dlp %s listo", tag)
	y.mu.Lock()
	y.cache = map[string]*ytInfo{}
	y.mu.Unlock()
}

var safeTag = regexp.MustCompile(`^[A-Za-z0-9._-]{1,40}$`)

func latestTag(repo string) (string, error) {
	var r struct {
		Tag string `json:"tag_name"`
	}
	if err := getJSON("https://api.github.com/repos/"+repo+"/releases/latest", &r); err != nil {
		return "", err
	}
	if !safeTag.MatchString(r.Tag) || strings.Contains(r.Tag, "..") {
		return "", errors.New("bad tag")
	}
	return r.Tag, nil
}

func fetchYtdlp(dir, tag string) error {
	sub := "ytdlp-" + tag
	dst := filepath.Join(dir, sub)
	base := "https://github.com/yt-dlp/yt-dlp/releases/download/" + tag + "/"
	err := downloadZip(base+ytdlpZip, dst, func(name string) (string, bool) { return name, true })
	exeDir := ""
	if err == nil {
		filepath.WalkDir(dst, func(p string, d os.DirEntry, _ error) error {
			if exeDir == "" && d != nil && !d.IsDir() && strings.EqualFold(d.Name(), ytdlpExe) {
				exeDir, _ = filepath.Rel(dir, filepath.Dir(p))
			}
			return nil
		})
	}
	if exeDir == "" {
		os.RemoveAll(dst)
		if err2 := download(base+ytdlpExe, filepath.Join(dir, ytdlpExe)); err2 != nil {
			return fmt.Errorf("%v; %v", err, err2)
		}
		os.Remove(filepath.Join(dir, "current"))
		return nil
	}
	if err := os.WriteFile(filepath.Join(dir, "current"), []byte(filepath.ToSlash(exeDir)), 0o644); err != nil {
		return err
	}
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			if e.IsDir() && strings.HasPrefix(e.Name(), "ytdlp-") && e.Name() != sub {
				os.RemoveAll(filepath.Join(dir, e.Name()))
			}
		}
	}
	return nil
}

func fetchDeno(dir string) error {
	if denoZip == "" {
		return nil
	}
	return downloadZip("https://github.com/denoland/deno/releases/latest/download/"+denoZip, dir, func(name string) (string, bool) {
		if strings.EqualFold(filepath.Base(name), denoExe) {
			return denoExe, true
		}
		return "", false
	})
}

func download(u, dst string) error {
	resp, err := dlClient.Get(u)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s: %s", u, resp.Status)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 400<<20))
	f.Close()
	if err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dst)
	return os.Rename(tmp, dst)
}

func downloadZip(u, dst string, pick func(string) (string, bool)) error {
	os.MkdirAll(dst, 0o755)
	tmp := filepath.Join(dst, "dl.zip.part")
	defer os.Remove(tmp)
	if err := download(u, tmp); err != nil {
		return err
	}
	zr, err := zip.OpenReader(tmp)
	if err != nil {
		return err
	}
	defer zr.Close()
	root := filepath.Clean(dst) + string(os.PathSeparator)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name, ok := pick(f.Name)
		if !ok {
			continue
		}
		out := filepath.Join(dst, filepath.FromSlash(name))
		if !strings.HasPrefix(out, root) {
			continue
		}
		os.MkdirAll(filepath.Dir(out), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(out + ".part")
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		w.Close()
		if err != nil {
			return err
		}
		os.Remove(out)
		if err := os.Rename(out+".part", out); err != nil {
			return err
		}
	}
	return nil
}

// ---- ffmpeg (para unir imagen y sonido al descargar, y para los vídeos que la ventana no abre) ----

var ffMu sync.Mutex

func ffmpegPath() string {
	if p := filepath.Join(toolsDir(), "ffmpeg", "bin", ffmpegExe); fileExists(p) {
		return p
	}
	if p, err := exec.LookPath(ffmpegExe); err == nil {
		return p
	}
	return ""
}

func ffprobePath() string {
	if p := filepath.Join(toolsDir(), "ffmpeg", "bin", ffprobeExe); fileExists(p) {
		return p
	}
	if p, err := exec.LookPath(ffprobeExe); err == nil {
		return p
	}
	return ""
}

func ensureFFmpeg() {
	if ffmpegZip == "" || ffmpegPath() != "" {
		return
	}
	ffMu.Lock()
	defer ffMu.Unlock()
	if ffmpegPath() != "" {
		return
	}
	logf("descargando ffmpeg")
	dst := filepath.Join(toolsDir(), "ffmpeg")
	err := downloadZip("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"+ffmpegZip, dst, func(name string) (string, bool) {
		// ffmpeg-…/bin/ffmpeg.exe → bin/ffmpeg.exe
		i := strings.Index(name, "/bin/")
		if i < 0 {
			return "", false
		}
		return name[i+1:], true
	})
	if err != nil {
		logf("ffmpeg: %v", err)
	}
}

// ---- lo que yt-dlp sabe de un vídeo ----

var ytClients = []string{"", "tv", "web_safari", "mweb"}

func (y *ytResolver) get(id string, fresh bool) (*ytInfo, error) {
	y.mu.Lock()
	prev := y.cache[id]
	if in := prev; in != nil && !fresh && time.Until(in.exp) > 10*time.Minute {
		y.mu.Unlock()
		return in, nil
	}
	if f, ok := y.fails[id]; ok && !fresh && time.Since(f.at) < 30*time.Second {
		y.mu.Unlock()
		return nil, f.err
	}
	if c := y.inflight[id]; c != nil {
		y.mu.Unlock()
		<-c.done
		return c.info, c.err
	}
	c := &ytCall{done: make(chan struct{})}
	y.inflight[id] = c
	y.mu.Unlock()

	// primero el camino rápido (ytfast.go); si no, yt-dlp. También al renovar (fresh), salvo que lo que
	// falló fuera justo lo del camino rápido: yt-dlp a veces solo da 360p y eso no puede quedarse para siempre
	if !(fresh && prev != nil && prev.client == -1) && !fastOff() && os.Getenv("MIX4UP_YTDLP") == "" {
		t0 := time.Now()
		if in, err := fastInfo(id); err == nil {
			in.client = -1
			c.info = in
			fastResult(true, nil)
			logf("yt: %s: rápido en %v", id, time.Since(t0).Round(time.Millisecond))
		} else {
			logf("yt: %s: %v (%v) → yt-dlp", id, err, time.Since(t0).Round(time.Millisecond))
			fastResult(false, err)
		}
	}
	if c.info == nil {
		c.info, c.err = y.resolve(id)
	}
	if c.err != nil && ytDownloadTools && ytdlpPath() != "" && clientMayHelp(c.err) {
		// quizá YouTube cambió algo y ya hay un yt-dlp nuevo
		y.toolsMu.Lock()
		if time.Since(y.checked) > 30*time.Minute {
			y.checked = time.Time{}
		}
		y.toolsMu.Unlock()
		before := ytdlpPath() + ytdlpCurrent()
		y.prepare()
		if ytdlpPath()+ytdlpCurrent() != before {
			c.info, c.err = y.resolve(id)
		}
	}
	y.mu.Lock()
	delete(y.inflight, id)
	if c.err != nil {
		y.fails[id] = ytFail{c.err, time.Now()}
	} else {
		delete(y.fails, id)
		y.cache[id] = c.info
		if len(y.cache) > 200 {
			for k, v := range y.cache {
				if time.Until(v.exp) < 20*time.Minute {
					delete(y.cache, k)
				}
			}
		}
	}
	y.mu.Unlock()
	close(c.done)
	return c.info, c.err
}

func (y *ytResolver) resolve(id string) (*ytInfo, error) {
	y.mu.Lock()
	first := y.goodClient
	y.mu.Unlock()
	var lastErr error
	var poor *ytInfo // uno que solo da 360p (imagen y sonido juntos): se usa solo si ningún otro da más
	for i := 0; i < len(ytClients); i++ {
		k := (first + i) % len(ytClients)
		in, err := y.resolveWith(id, ytClients[k])
		if err == nil && !in.hasAdaptive() {
			logf("yt: %s: el cliente %d solo da 360p; pruebo otro", id, k)
			if poor == nil {
				in.client = k
				poor = in
			}
			continue
		}
		if err == nil {
			in.client = k
			y.mu.Lock()
			y.goodClient = k
			y.mu.Unlock()
			return in, nil
		}
		lastErr = err
		if !clientMayHelp(err) {
			return nil, err
		}
		logf("yt: %s: %v; pruebo otro cliente", id, err)
	}
	if poor != nil {
		return poor, nil
	}
	return nil, lastErr
}

// hasAdaptive: ¿hay imagen por separado (más de 360p)?
func (in *ytInfo) hasAdaptive() bool {
	for _, f := range in.Formats {
		if f.Kind == "v" {
			return true
		}
	}
	return false
}

func ytBaseArgs() []string {
	args := []string{"--ignore-config", "--no-warnings", "--no-progress"}
	if d := denoPath(); d != "" {
		args = append(args, "--js-runtimes", "deno:"+d)
	}
	if c := ytCookieFile(); c != "" {
		args = append(args, "--cookies", c)
	}
	return args
}

func ytRun(ctx context.Context, args ...string) ([]byte, error) {
	exe := ytdlpPath()
	if exe == "" && ytdl.busy.Load() {
		return nil, errors.New("Mix4Up está preparando yt-dlp (solo la primera vez), prueba en un momento")
	}
	if exe == "" {
		ytdl.prepare()
		if exe = ytdlpPath(); exe == "" {
			return nil, errors.New("no se pudo descargar yt-dlp (mira tu conexión o el antivirus)")
		}
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	hideConsole(cmd)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "ERROR:"); i >= 0 {
			msg = msg[i:]
		}
		if len(msg) > 400 {
			msg = msg[:400]
		}
		if msg == "" {
			msg = err.Error()
		}
		return out, errors.New("yt-dlp: " + msg)
	}
	return out, nil
}

func (y *ytResolver) resolveWith(id, client string) (*ytInfo, error) {
	args := append(ytBaseArgs(), "--no-playlist", "-J")
	if client != "" {
		args = append(args, "--extractor-args", "youtube:player_client="+client)
	}
	args = append(args, "--", "https://www.youtube.com/watch?v="+id)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := ytRun(ctx, args...)
	if err != nil {
		logf("yt: %s: %v", id, err)
		return nil, err
	}
	return parseYtInfo(out)
}

// parseYtInfo: lo que la página necesita de la respuesta (enorme) de yt-dlp -J.
func parseYtInfo(out []byte) (*ytInfo, error) {
	var j struct {
		ID          string  `json:"id"`
		Title       string  `json:"title"`
		Channel     string  `json:"channel"`
		Uploader    string  `json:"uploader"`
		ChannelID   string  `json:"channel_id"`
		Duration    float64 `json:"duration"`
		Description string  `json:"description"`
		Upload      string  `json:"upload_date"`
		Views       int64   `json:"view_count"`
		Likes       int64   `json:"like_count"`
		Thumb       string  `json:"thumbnail"`
		LiveStatus  string  `json:"live_status"`
		Width       int     `json:"width"`
		Height      int     `json:"height"`
		Chapters    []struct {
			Start float64 `json:"start_time"`
			End   float64 `json:"end_time"`
			Title string  `json:"title"`
		} `json:"chapters"`
		Formats []struct {
			ID       string            `json:"format_id"`
			Ext      string            `json:"ext"`
			VCodec   string            `json:"vcodec"`
			ACodec   string            `json:"acodec"`
			Height   int               `json:"height"`
			Width    int               `json:"width"`
			FPS      float64           `json:"fps"`
			TBR      float64           `json:"tbr"`
			Size     int64             `json:"filesize"`
			SizeAppr int64             `json:"filesize_approx"`
			Proto    string            `json:"protocol"`
			URL      string            `json:"url"`
			Headers  map[string]string `json:"http_headers"`
			Note     string            `json:"format_note"`
			Lang     string            `json:"language"`
			Range    string            `json:"dynamic_range"`
		} `json:"formats"`
		Subtitles map[string][]struct {
			Ext  string `json:"ext"`
			URL  string `json:"url"`
			Name string `json:"name"`
		} `json:"subtitles"`
		Auto map[string][]struct {
			Ext  string `json:"ext"`
			URL  string `json:"url"`
			Name string `json:"name"`
		} `json:"automatic_captions"`
	}
	if err := json.Unmarshal(out, &j); err != nil || j.ID == "" {
		return nil, errors.New("yt-dlp no dio los datos del vídeo")
	}
	in := &ytInfo{ID: j.ID, Title: j.Title, Channel: j.Channel, ChannelID: j.ChannelID, Duration: j.Duration,
		Description: j.Description, Upload: j.Upload, Views: j.Views, Likes: j.Likes, Thumb: j.Thumb,
		Live: j.LiveStatus == "is_live", Width: j.Width, Height: j.Height, exp: time.Now().Add(5 * time.Hour)}
	if in.Channel == "" {
		in.Channel = j.Uploader
	}
	for _, c := range j.Chapters {
		in.Chapters = append(in.Chapters, ytChapter{c.Start, c.End, c.Title})
	}
	for _, f := range j.Formats {
		if f.URL == "" || (f.Proto != "https" && f.Proto != "http") || strings.Contains(f.Note, "storyboard") || f.Ext == "mhtml" {
			continue
		}
		hasV, hasA := f.VCodec != "" && f.VCodec != "none", f.ACodec != "" && f.ACodec != "none"
		if !hasV && !hasA {
			continue
		}
		kind := "av"
		if !hasA {
			kind = "v"
		} else if !hasV {
			kind = "a"
		}
		x := &ytFormat{ID: f.ID, Ext: f.Ext, Kind: kind, Height: f.Height, Width: f.Width, FPS: f.FPS,
			VCodec: f.VCodec, ACodec: f.ACodec, TBR: f.TBR, Size: f.Size, Lang: f.Lang, Note: f.Note,
			HDR: f.Range != "" && f.Range != "SDR", url: f.URL, headers: f.Headers}
		if x.Size == 0 {
			x.Size = f.SizeAppr
		}
		switch {
		case kind == "a" && f.Ext == "m4a":
			x.mime = "audio/mp4"
		case kind == "a" && f.Ext == "webm":
			x.mime = "audio/webm"
		case f.Ext == "webm":
			x.mime = "video/webm"
		default:
			x.mime = "video/mp4"
		}
		if u, err := url.Parse(f.URL); err == nil {
			if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 && time.Unix(e, 0).Before(in.exp) {
				in.exp = time.Unix(e, 0)
			}
		}
		in.Formats = append(in.Formats, x)
	}
	addSubs := func(m map[string][]struct {
		Ext  string `json:"ext"`
		URL  string `json:"url"`
		Name string `json:"name"`
	}, auto bool) {
		for lang, list := range m {
			if lang == "live_chat" {
				continue
			}
			// los automáticos traducidos a todos los idiomas: solo el original y unos pocos
			if auto && !strings.HasSuffix(lang, "-orig") && lang != "es" && lang != "en" && lang != "ca" {
				continue
			}
			for _, s := range list {
				if s.Ext == "vtt" {
					in.Subs = append(in.Subs, ytSubTrack{Lang: lang, Name: s.Name, Auto: auto, url: s.URL})
					break
				}
			}
		}
	}
	addSubs(j.Subtitles, false)
	addSubs(j.Auto, true)
	sort.Slice(in.Subs, func(a, b int) bool {
		if in.Subs[a].Auto != in.Subs[b].Auto {
			return !in.Subs[a].Auto
		}
		return in.Subs[a].Lang < in.Subs[b].Lang
	})
	if len(in.Formats) == 0 {
		if in.Live {
			return nil, errors.New("los directos todavía no se pueden ver con el reproductor de Mix4Up")
		}
		return nil, errors.New("YouTube no dio ninguna calidad que se pueda ver")
	}
	return in, nil
}

func (y *ytResolver) dropClient(in *ytInfo) {
	y.mu.Lock()
	defer y.mu.Unlock()
	if in != nil && in.client == y.goodClient {
		y.goodClient = (y.goodClient + 1) % len(ytClients)
	}
}

// errores que dependen de cómo preguntó yt-dlp (otro cliente puede ir) y no del vídeo
var ytVideoGone = regexp.MustCompile(`(?i)private video|video unavailable|has been removed|no longer available|copyright|not available in your country|members-only|join this channel|sign in to confirm your age|inappropriate|no se pudo descargar yt-dlp|preparando yt-dlp|directos todav`)

func clientMayHelp(err error) bool { return !ytVideoGone.MatchString(err.Error()) }

// friendly: el error de yt-dlp contado para personas
func friendly(err error) string {
	m := err.Error()
	switch {
	case regexp.MustCompile(`(?i)private video`).MatchString(m):
		return "Es un vídeo privado."
	case regexp.MustCompile(`(?i)unavailable|removed|no longer`).MatchString(m):
		return "Este vídeo ya no está disponible."
	case regexp.MustCompile(`(?i)confirm your age|inappropriate`).MatchString(m):
		return "Este vídeo tiene restricción de edad: conecta tu cuenta de YouTube para verlo."
	case regexp.MustCompile(`(?i)members-only|join this channel`).MatchString(m):
		return "Este vídeo es solo para miembros del canal."
	case regexp.MustCompile(`(?i)not a bot|sign in to confirm`).MatchString(m):
		return "YouTube pide comprobar que no eres un robot. Conecta tu cuenta de YouTube (Ajustes) y vuelve a intentarlo."
	case regexp.MustCompile(`(?i)country`).MatchString(m):
		return "Este vídeo no se puede ver en tu país."
	}
	return m
}

func (f *ytFormat) fetch(from, to int64) (*http.Response, error) {
	req, _ := http.NewRequest("GET", f.url, nil)
	for k, v := range f.headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, to))
	resp, err := ytStreamClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 206 && resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("youtube: %s", resp.Status)
	}
	return resp, nil
}

func totalFromRange(cr string) int64 {
	if i := strings.LastIndexByte(cr, '/'); i >= 0 {
		n, _ := strconv.ParseInt(cr[i+1:], 10, 64)
		return n
	}
	return 0
}

func (in *ytInfo) format(id string) *ytFormat {
	for _, f := range in.Formats {
		if f.ID == id {
			return f
		}
	}
	return nil
}

// ---- /api/yt/video?id= ----

func (s *server) ytVideo(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !ytVideoID.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	// ?prep=1: solo prepararlo (el ratón encima, el siguiente): luego empieza al momento
	if r.URL.Query().Get("prep") != "" {
		w.WriteHeader(http.StatusNoContent)
		go func() {
			ytPrepSem <- struct{}{}
			defer func() { <-ytPrepSem }()
			if in, err := ytdl.get(id, false); err == nil {
				in.warm()
			}
		}()
		return
	}
	in, err := ytdl.get(id, r.URL.Query().Get("fresh") != "")
	if err != nil {
		http.Error(w, friendly(err), http.StatusBadGateway)
		return
	}
	jsonOut(w, in)
}

var ytPrepSem = make(chan struct{}, 2)

// ---- /api/yt/sub?id=&lang=&auto= : los subtítulos de YouTube (WebVTT) ----

func (s *server) ytSub(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	in, err := ytdl.get(q.Get("id"), false)
	if err != nil {
		http.Error(w, friendly(err), http.StatusBadGateway)
		return
	}
	for _, t := range in.Subs {
		if t.Lang == q.Get("lang") && t.Auto == (q.Get("auto") == "1") {
			resp, err := netClient.Get(t.url)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			defer resp.Body.Close()
			w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
			io.Copy(w, io.LimitReader(resp.Body, 8<<20))
			return
		}
	}
	http.NotFound(w, r)
}

// ---- /ytstream/<id>/<formato>: la imagen o el sonido (de la caché, que se va
// llenando con varias conexiones a la vez; ver ytcache.go) ----

func (s *server) ytStream(w http.ResponseWriter, r *http.Request) {
	id, fid, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/ytstream/"), "/")
	if !ytVideoID.MatchString(id) || fid == "" || len(fid) > 40 {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	c, err := cacheFor(id, fid)
	if err != nil {
		http.Error(w, friendly(err), http.StatusBadGateway)
		return
	}
	c.serve(w, r)
}

// closest: con otro cliente los números de formato pueden cambiar; el más parecido
func closest(in *ytInfo, want *ytFormat) *ytFormat {
	var best *ytFormat
	for _, f := range in.Formats {
		if f.Kind != want.Kind || f.Ext != want.Ext {
			continue
		}
		if best == nil || abs(f.Height-want.Height) < abs(best.Height-want.Height) {
			best = f
		}
	}
	return best
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// /api/yt/tools: estado de yt-dlp (para Ajustes y para los avisos)
func (s *server) ytTools(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		ytdl.toolsMu.Lock()
		ytdl.checked = time.Time{}
		ytdl.toolsMu.Unlock()
		go ytdl.prepare()
	}
	v := ""
	if p := ytdlpPath(); p != "" && r.URL.Query().Get("v") != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		if b, err := ytRun(ctx, "--version"); err == nil {
			v = strings.TrimSpace(string(b))
		}
		cancel()
	}
	jsonOut(w, map[string]any{"ready": ytdlpPath() != "", "busy": ytdl.busy.Load(), "version": v, "deno": denoPath() != "", "ffmpeg": ffmpegPath() != ""})
}
