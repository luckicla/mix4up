package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Descargar vídeos de YouTube (con yt-dlp) a la carpeta Vídeos\Mix4Up, en la
// calidad elegida. Aparecen solos en «Mis vídeos».

type dlJob struct {
	Key    string  `json:"key"`
	ID     string  `json:"id"`
	Title  string  `json:"title"`
	Q      string  `json:"q"`
	State  string  `json:"state"` // queued, running, done, error
	Pct    float64 `json:"pct"`
	File   string  `json:"file,omitempty"`
	Error  string  `json:"error,omitempty"`
	At     int64   `json:"at"`
	cancel context.CancelFunc
}

type downloads struct {
	s    *server
	mu   sync.Mutex
	jobs []*dlJob
	sem  chan struct{}
}

func newDownloads(s *server) *downloads { return &downloads{s: s, sem: make(chan struct{}, 2)} }

var dlFormats = map[string]string{
	"audio": "ba[ext=m4a]/ba",
}

func dlFormat(q string) string {
	if f, ok := dlFormats[q]; ok {
		return f
	}
	h, err := strconv.Atoi(q)
	if err != nil || h <= 0 {
		return "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b"
	}
	hs := strconv.Itoa(h)
	return "bv*[height<=" + hs + "][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=" + hs + "]+ba/b[height<=" + hs + "]/b"
}

func (d *downloads) api(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var v struct{ ID, Q, Title string }
		if json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&v) != nil || !ytVideoID.MatchString(v.ID) {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		j := &dlJob{Key: randomHex(6), ID: v.ID, Title: v.Title, Q: v.Q, State: "queued", At: time.Now().UnixMilli()}
		d.mu.Lock()
		d.jobs = append(d.jobs, j)
		if len(d.jobs) > 60 {
			d.jobs = d.jobs[len(d.jobs)-60:]
		}
		d.mu.Unlock()
		go d.run(j)
	case http.MethodDelete:
		k := r.URL.Query().Get("key")
		d.mu.Lock()
		for i, j := range d.jobs {
			if j.Key == k {
				if j.cancel != nil {
					j.cancel()
				}
				if j.State != "running" {
					d.jobs = append(d.jobs[:i], d.jobs[i+1:]...)
				}
				break
			}
		}
		d.mu.Unlock()
	}
	d.mu.Lock()
	out := make([]dlJob, len(d.jobs))
	for i, j := range d.jobs {
		out[i] = *j
	}
	d.mu.Unlock()
	jsonOut(w, out)
}

var dlProgress = regexp.MustCompile(`M4P\s*([\d.]+)%`)

func (d *downloads) set(j *dlJob, f func()) {
	d.mu.Lock()
	f()
	d.mu.Unlock()
}

func (d *downloads) run(j *dlJob) {
	d.sem <- struct{}{}
	defer func() { <-d.sem }()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	d.set(j, func() { j.State, j.cancel = "running", cancel })
	if j.Q != "audio" {
		ensureFFmpeg() // para juntar imagen y sonido
	}
	dir := d.s.lib.downloadDir()
	os.MkdirAll(dir, 0o755)
	// lo que ya está entero en la caché (porque lo estabas viendo): se junta al momento
	if p := d.fromCache(j, dir); p != "" {
		logf("descargado %s (desde la caché)", p)
		d.set(j, func() { j.State, j.Pct, j.File = "done", 100, filepath.Base(p) })
		d.s.lib.rescan()
		return
	}
	exe := ytdlpPath()
	if exe == "" {
		ytdl.prepare()
		exe = ytdlpPath()
	}
	if exe == "" {
		d.set(j, func() { j.State, j.Error = "error", "no se pudo preparar yt-dlp" })
		return
	}
	args := append(ytBaseArgs(), "--no-playlist", "--newline", "-N", "4", "--http-chunk-size", "10M", "--progress", "--progress-template", "download:M4P %(progress._percent_str)s",
		"-f", dlFormat(j.Q), "--no-mtime", "--embed-metadata", "--embed-thumbnail",
		"-o", filepath.Join(dir, "%(title).120B [%(id)s].%(ext)s"), "--print", "after_move:filepath")
	if j.Q != "audio" {
		args = append(args, "--merge-output-format", "mp4", "--remux-video", "mp4")
	}
	if ff := ffmpegPath(); ff != "" {
		args = append(args, "--ffmpeg-location", filepath.Dir(ff))
	} else {
		// sin ffmpeg: un solo archivo con imagen y sonido
		args = append(args[:0:0], append(ytBaseArgs(), "--no-playlist", "--newline", "--progress", "--progress-template", "download:M4P %(progress._percent_str)s",
			"-f", "b[ext=mp4]/b", "-o", filepath.Join(dir, "%(title).120B [%(id)s].%(ext)s"), "--print", "after_move:filepath")...)
	}
	args = append(args, "--", "https://www.youtube.com/watch?v="+j.ID)
	cmd := exec.CommandContext(ctx, exe, args...)
	hideConsole(cmd)
	out, _ := cmd.StdoutPipe()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		d.set(j, func() { j.State, j.Error = "error", err.Error() })
		return
	}
	file := ""
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := sc.Text()
		if m := dlProgress.FindStringSubmatch(line); m != nil {
			p, _ := strconv.ParseFloat(m[1], 64)
			d.set(j, func() { j.Pct = p })
		} else if t := strings.TrimSpace(line); t != "" && fileExists(t) {
			file = t
		}
	}
	err := cmd.Wait()
	if err != nil || file == "" {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "ERROR:"); i >= 0 {
			msg = msg[i:]
		}
		if ctx.Err() != nil {
			msg = "cancelada"
		}
		if msg == "" && err != nil {
			msg = err.Error()
		}
		logf("descarga %s: %s", j.ID, msg)
		d.set(j, func() { j.State, j.Error = "error", friendly(errorString(msg)) })
		return
	}
	logf("descargado %s", file)
	d.set(j, func() { j.State, j.Pct, j.File = "done", 100, filepath.Base(file) })
	d.s.lib.rescan()
}

type errorString string

func (e errorString) Error() string { return string(e) }

// fromCache: imagen y sonido de la calidad pedida ya bajados enteros mientras lo
// veías → un MP4 con ffmpeg (sin volver a bajar nada)
func (d *downloads) fromCache(j *dlJob, dir string) string {
	in, err := ytdl.get(j.ID, false)
	if err != nil || ffmpegPath() == "" {
		return ""
	}
	want, _ := strconv.Atoi(j.Q)
	var v, a string
	best := 0
	for _, f := range in.Formats {
		p := cacheComplete(j.ID, f.ID)
		if p == "" {
			continue
		}
		if f.Kind == "a" && f.Ext == "m4a" {
			a = p
		}
		if f.Kind == "v" && strings.HasPrefix(f.VCodec, "avc1") && (want == 0 || f.Height <= want) && f.Height > best {
			if want == 0 || f.Height == want || best == 0 {
				v, best = p, f.Height
			}
		}
	}
	if j.Q == "audio" {
		if a == "" {
			return ""
		}
		out := filepath.Join(dir, cleanName(in.Title)+" ["+j.ID+"].m4a")
		if copyFile(a, out) != nil {
			return ""
		}
		return out
	}
	if v == "" || a == "" || (want > 0 && best != want) {
		return ""
	}
	out := filepath.Join(dir, cleanName(in.Title)+" ["+j.ID+"].mp4")
	cmd := exec.Command(ffmpegPath(), "-y", "-v", "error", "-i", v, "-i", a, "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", "-movflags", "+faststart", out)
	hideConsole(cmd)
	if err := cmd.Run(); err != nil {
		os.Remove(out)
		return ""
	}
	return out
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return save(in, dst)
}

func save(r io.Reader, dst string) error {
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}
