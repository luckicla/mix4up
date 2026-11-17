package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Como YouTube: al abrir un vídeo, Mix4Up se baja la calidad que estás viendo
// ENTERA y lo más rápido posible, en trozos y con varias conexiones a la vez,
// empezando por donde estás mirando. Así saltar a cualquier punto es al
// momento, y al cambiar de calidad la nueva se baja igual (el sonido no se
// vuelve a bajar). Lo bajado se queda en una caché (lo más reciente, hasta
// ~3 GB), y si luego lo descargas, se aprovecha.

const (
	cacheChunk   = 2 << 20 // 2 MB por trozo
	cacheWorkers = 4       // conexiones a la vez por cada calidad
	cacheMax     = 3 << 30 // 3 GB
	cacheIdle    = 2 * time.Minute
)

type ytCacheFile struct {
	key     string // id/formato
	id, fid string
	path    string
	size    int64
	mime    string
	mu      sync.Mutex
	cond    *sync.Cond
	f       *os.File
	have    []bool
	busy    []bool
	got     []int64 // lo que ya ha llegado de cada trozo (se manda al vídeo sin esperar al trozo entero)
	tailAt  int64   // el final del archivo, que se baja aparte nada más empezar:
	tailOK  bool    // Chrome lo lee antes de reproducir nada (y antes se bajaba el último)
	left    int
	prio    int // trozo por el que empezar (donde se está mirando)
	used    time.Time
	err     error
	workers int
	fmt     *ytFormat
}

var ytCache = struct {
	sync.Mutex
	files map[string]*ytCacheFile
}{files: map[string]*ytCacheFile{}}

func ytCacheDir() string { return filepath.Join(toolsDir(), "cache") }

// los archivos de la caché de otras veces: fuera (se rehacen al verlos)
func init() {
	go func() {
		time.Sleep(5 * time.Second)
		os.RemoveAll(ytCacheDir())
	}()
}

// cacheFor: el de esa calidad (lo crea y empieza a bajarlo si no estaba)
func cacheFor(id, fid string) (*ytCacheFile, error) {
	key := id + "/" + fid
	ytCache.Lock()
	c := ytCache.files[key]
	ytCache.Unlock()
	if c != nil {
		c.mu.Lock()
		failed := c.err != nil && c.left > 0
		c.mu.Unlock()
		if !failed {
			c.touch()
			return c, nil
		}
		dropCache(key)
	}
	in, err := ytdl.get(id, false)
	if err != nil {
		return nil, err
	}
	f := in.format(fid)
	if f == nil {
		return nil, errors.New("esa calidad ya no está")
	}
	size := f.Size
	// el tamaño exacto, preguntándolo (el de yt-dlp a veces es aproximado);
	// el del camino rápido es el de YouTube: no hace falta (un viaje menos antes de empezar)
	if in.client == -1 && size > 0 {
	} else if resp, err := f.fetch(0, 0); err == nil {
		resp.Body.Close()
		if n := totalFromRange(resp.Header.Get("Content-Range")); n > 0 {
			size = n
		}
	} else {
		// rechazado: otro cliente de yt-dlp
		ytdl.dropClient(in)
		if in, err = ytdl.get(id, true); err != nil {
			return nil, err
		}
		if f = in.format(fid); f == nil {
			return nil, errors.New("esa calidad ya no está")
		}
		resp, err := f.fetch(0, 0)
		if err != nil {
			return nil, fmt.Errorf("YouTube no dio el vídeo: %v", err)
		}
		resp.Body.Close()
		if n := totalFromRange(resp.Header.Get("Content-Range")); n > 0 {
			size = n
		}
	}
	if size <= 0 {
		return nil, errors.New("tamaño desconocido")
	}
	os.MkdirAll(ytCacheDir(), 0o755)
	pruneCache(size)
	p := filepath.Join(ytCacheDir(), id+"."+strings.ReplaceAll(fid, "/", "_")+"."+f.Ext)
	file, err := os.OpenFile(p, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	n := int((size + cacheChunk - 1) / cacheChunk)
	c = &ytCacheFile{key: key, id: id, fid: fid, path: p, size: size, mime: f.mime, f: file, have: make([]bool, n), busy: make([]bool, n), got: make([]int64, n), left: n, used: time.Now(), fmt: f}
	c.cond = sync.NewCond(&c.mu)
	ytCache.Lock()
	if old := ytCache.files[key]; old != nil { // otro llegó antes
		ytCache.Unlock()
		file.Close()
		os.Remove(p)
		old.touch()
		return old, nil
	}
	ytCache.files[key] = c
	ytCache.Unlock()
	c.tailAt = max(0, size-cacheTail)
	go c.fetchTail()
	c.start()
	return c, nil
}

func dropCache(key string) {
	ytCache.Lock()
	c := ytCache.files[key]
	delete(ytCache.files, key)
	ytCache.Unlock()
	if c != nil {
		c.mu.Lock()
		c.err = errors.New("quitado")
		c.cond.Broadcast()
		c.mu.Unlock()
		go func() { time.Sleep(3 * time.Second); c.f.Close(); os.Remove(c.path) }()
	}
}

func (c *ytCacheFile) touch() {
	c.mu.Lock()
	c.used = time.Now()
	c.mu.Unlock()
	c.start()
}

// start: los que bajan trozos (si no estaban ya)
func (c *ytCacheFile) start() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for c.workers < cacheWorkers && c.left > 0 {
		c.workers++
		go c.work()
	}
}

// next: el trozo que falta más cerca de donde se mira (y después, desde el principio)
func (c *ytCacheFile) next() int {
	n := len(c.have)
	for k := 0; k < n; k++ {
		i := (c.prio + k) % n
		if !c.have[i] && !c.busy[i] {
			return i
		}
	}
	return -1
}

func (c *ytCacheFile) work() {
	defer func() { c.mu.Lock(); c.workers--; c.mu.Unlock() }()
	buf := make([]byte, 64<<10)
	for {
		c.mu.Lock()
		if c.left == 0 || c.err != nil || time.Since(c.used) > cacheIdle {
			c.mu.Unlock()
			return
		}
		i := c.next()
		if i < 0 {
			c.mu.Unlock()
			return
		}
		c.busy[i] = true
		f := c.fmt
		c.mu.Unlock()
		err := c.fetchChunk(f, i, buf)
		c.mu.Lock()
		c.busy[i] = false
		if err == nil {
			if !c.have[i] {
				c.have[i] = true
				c.left--
			}
		} else {
			logf("caché %s: trozo %d: %v", c.key, i, err)
		}
		c.cond.Broadcast()
		c.mu.Unlock()
		if err != nil {
			// YouTube se negó: con otro cliente de yt-dlp (una vez para todos)
			if !c.refresh() {
				c.mu.Lock()
				c.err = err
				c.cond.Broadcast()
				c.mu.Unlock()
				return
			}
		}
	}
}

const cacheTail = 256 << 10

// fetchTail: el final del archivo, aparte y enseguida (Chrome lo mira antes de empezar a reproducir)
func (c *ytCacheFile) fetchTail() {
	for try := 0; try < 2; try++ {
		c.mu.Lock()
		f, from := c.fmt, c.tailAt
		c.mu.Unlock()
		resp, err := f.fetch(from, c.size-1)
		if err != nil {
			time.Sleep(300 * time.Millisecond)
			continue
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, c.size-from))
		resp.Body.Close()
		if err != nil || int64(len(b)) != c.size-from {
			continue
		}
		if _, err := c.f.WriteAt(b, from); err != nil {
			return
		}
		c.mu.Lock()
		c.tailOK = true
		c.cond.Broadcast()
		c.mu.Unlock()
		return
	}
}

func (c *ytCacheFile) fetchChunk(f *ytFormat, i int, buf []byte) error {
	from := int64(i) * cacheChunk
	to := min(c.size, from+cacheChunk) - 1
	var lastErr error
	for try := 0; try < 3; try++ {
		if try > 0 {
			time.Sleep(time.Duration(try) * 400 * time.Millisecond)
		}
		resp, err := f.fetch(from, to)
		if err != nil {
			lastErr = err
			// rechazado (403…): sin esperas, a renovar la dirección
			if strings.HasPrefix(err.Error(), "youtube: ") {
				return err
			}
			continue
		}
		pos := from
		for pos <= to {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if pos+int64(n) > to+1 {
					n = int(to + 1 - pos)
				}
				if _, werr := c.f.WriteAt(buf[:n], pos); werr != nil {
					resp.Body.Close()
					return werr
				}
				pos += int64(n)
				c.mu.Lock()
				if g := pos - int64(i)*cacheChunk; g > c.got[i] {
					c.got[i] = g
					c.cond.Broadcast()
				}
				c.mu.Unlock()
			}
			if rerr != nil {
				break
			}
		}
		resp.Body.Close()
		if pos > to {
			return nil
		}
		// llegó a medias: el resto
		lastErr = io.ErrUnexpectedEOF
		from = pos
	}
	return lastErr
}

var refreshMu sync.Mutex

// refresh: pide otra vez a yt-dlp dónde está el vídeo (las direcciones caducan
// o YouTube las rechaza); devuelve false si no hay manera
func (c *ytCacheFile) refresh() bool {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	c.mu.Lock()
	cur := c.fmt
	c.mu.Unlock()
	in, err := ytdl.get(c.id, false)
	if err == nil {
		if f := in.format(c.fid); f != nil && f != cur {
			c.mu.Lock()
			c.fmt = f
			c.mu.Unlock()
			return true // otro ya lo renovó
		}
		ytdl.dropClient(in)
	}
	in, err = ytdl.get(c.id, true)
	if err != nil {
		return false
	}
	f := in.format(c.fid)
	if f == nil {
		f = closest(in, cur)
	}
	if f == nil {
		return false
	}
	c.mu.Lock()
	c.fmt = f
	c.mu.Unlock()
	return true
}

// serve: lo pedido, de la caché, esperando a los trozos que aún no están
func (c *ytCacheFile) serve(w http.ResponseWriter, r *http.Request) {
	start, end := int64(0), c.size-1
	partial := false
	if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=") {
		a, b, _ := strings.Cut(strings.TrimPrefix(rg, "bytes="), "-")
		if strings.Contains(b, ",") {
			b = ""
		}
		if a == "" {
			if n, err := strconv.ParseInt(b, 10, 64); err == nil && n > 0 {
				start = max(0, c.size-n)
			}
		} else if n, err := strconv.ParseInt(a, 10, 64); err == nil {
			start = n
			if m, err := strconv.ParseInt(b, 10, 64); err == nil && m < end {
				end = m
			}
		}
		partial = true
	}
	if start > end || start >= c.size {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", c.size))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	c.mu.Lock()
	c.prio = int(start / cacheChunk)
	c.used = time.Now()
	c.mu.Unlock()
	c.start()
	// los primeros bytes antes de contestar (si falla, un error de verdad); antes: el trozo entero de 2 MB
	if _, err := c.wait(start, r); err != nil {
		http.Error(w, "YouTube no dio el vídeo: "+friendly(err), http.StatusBadGateway)
		return
	}
	h := w.Header()
	h.Set("Content-Type", c.mime)
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	if partial {
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, c.size))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	if r.Method == http.MethodHead {
		return
	}
	buf := make([]byte, 128<<10)
	pos := start
	fl, _ := w.(http.Flusher)
	for pos <= end {
		avail, err := c.wait(pos, r)
		if err != nil {
			return
		}
		chunkEnd := min(end, avail-1)
		for pos <= chunkEnd {
			n := int(min(int64(len(buf)), chunkEnd-pos+1))
			m, err := c.f.ReadAt(buf[:n], pos)
			if m > 0 {
				if _, werr := w.Write(buf[:m]); werr != nil {
					return
				}
				pos += int64(m)
			}
			if err != nil && m == 0 {
				return
			}
		}
		if fl != nil {
			fl.Flush()
		}
		c.mu.Lock()
		c.used = time.Now()
		c.mu.Unlock()
	}
}

// wait: hasta que haya algo a partir de pos; devuelve hasta dónde (sin incluir) se puede leer ya
func (c *ytCacheFile) wait(pos int64, r *http.Request) (int64, error) {
	i := int(pos / cacheChunk)
	base := int64(i) * cacheChunk
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-r.Context().Done():
			c.mu.Lock()
			c.cond.Broadcast()
			c.mu.Unlock()
		case <-done:
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	deadline := time.Now().Add(60 * time.Second)
	for !c.have[i] && base+c.got[i] <= pos && !(c.tailOK && pos >= c.tailAt) {
		// lo que alguien está esperando ya, lo primero (Chrome pide también el final del archivo y lo deja:
		// eso no puede quitarle el turno al principio, que es lo que hace falta para empezar)
		c.prio = i
		if c.err != nil {
			return 0, c.err
		}
		if r.Context().Err() != nil {
			return 0, r.Context().Err()
		}
		if time.Now().After(deadline) {
			return 0, errors.New("YouTube va muy lento")
		}
		if c.workers == 0 {
			c.mu.Unlock()
			c.start()
			c.mu.Lock()
		}
		go func() { time.Sleep(time.Second); c.mu.Lock(); c.cond.Broadcast(); c.mu.Unlock() }()
		c.cond.Wait()
	}
	if c.tailOK && pos >= c.tailAt {
		return c.size, nil
	}
	if c.have[i] {
		return min(c.size, base+cacheChunk), nil
	}
	return base + c.got[i], nil
}

// complete: el archivo entero ya bajado (para descargarlo sin volver a bajarlo)
func cacheComplete(id, fid string) string {
	ytCache.Lock()
	c := ytCache.files[id+"/"+fid]
	ytCache.Unlock()
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.left == 0 {
		return c.path
	}
	return ""
}

// progreso de la caché de un vídeo (para la barra gris del reproductor)
// cacheProgress: cuánto hay bajado de cada calidad. keep: las que está usando el reproductor
// (mientras el vídeo esté abierto, aunque esté en pausa, se siguen bajando enteras, como hace YouTube)
func cacheProgress(id, keep string) map[string]float64 {
	out := map[string]float64{}
	keepSet := map[string]bool{}
	for _, f := range strings.Split(keep, ",") {
		keepSet[f] = f != ""
	}
	var wake []*ytCacheFile
	ytCache.Lock()
	for k, c := range ytCache.files {
		if c.id != id {
			continue
		}
		c.mu.Lock()
		out[strings.TrimPrefix(k, id+"/")] = 1 - float64(c.left)/float64(len(c.have))
		if keepSet[c.fid] && c.err == nil {
			c.used = time.Now()
			if c.workers == 0 && c.left > 0 {
				wake = append(wake, c)
			}
		}
		c.mu.Unlock()
	}
	ytCache.Unlock()
	for _, c := range wake {
		c.start()
	}
	return out
}

// pruneCache: sitio para size bytes más, quitando lo que hace más que no se usa
func pruneCache(size int64) {
	ytCache.Lock()
	var list []*ytCacheFile
	var total int64
	for _, c := range ytCache.files {
		list = append(list, c)
		total += c.size
	}
	ytCache.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].used.Before(list[j].used) })
	for _, c := range list {
		if total+size <= cacheMax {
			break
		}
		if time.Since(c.used) < 30*time.Second {
			continue
		}
		dropCache(c.key)
		total -= c.size
	}
}
