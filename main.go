// Mix4Up: tus vídeos y YouTube (sin Shorts), hermano de MixUp.
//
// Este programa es el «motor»: lee las carpetas de vídeos, habla con YouTube
// (con yt-dlp y con la API interna de su web) y sirve la interfaz en
// http://127.0.0.1:47823. La ventana la pone la app de escritorio (desktop/,
// Electron), que lo arranca con -shell.
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"flag"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

// Puerto propio (MixUp usa el 47811): las dos pueden estar abiertas a la vez.
const defaultPort = 47823

var addr = "127.0.0.1:" + strconv.Itoa(defaultPort)

// Lo pone la compilación: "1.<m>.<n>.<número de compilación>".
var version = "1.0.0.0"

// buildNum: el último número de la versión (el que decide qué es más nuevo).
func buildNum(v string) int {
	p := strings.Split(strings.TrimSpace(v), ".")
	n, _ := strconv.Atoi(p[len(p)-1])
	return n
}

var shell bool

func main() {
	dataFlag := flag.String("data", "", "carpeta de datos (por defecto: %APPDATA%\\Mix4Up)")
	rootFlag := flag.String("root", "", "portable: la carpeta del .exe (los datos van en su .mix4up)")
	tokenFlag := flag.String("token", "", "clave de la página (la pone la app de escritorio)")
	portFlag := flag.Int("port", 0, "puerto (pruebas)")
	flag.BoolVar(&shell, "shell", false, "arrancado por la app de escritorio")
	flag.Parse()
	if p := os.Getenv("MIX4UP_PORT"); p != "" && *portFlag == 0 {
		*portFlag, _ = strconv.Atoi(p)
	}
	if *portFlag > 0 {
		addr = "127.0.0.1:" + strconv.Itoa(*portFlag)
	}

	portable := *rootFlag != ""
	dataDir := *dataFlag
	if dataDir == "" {
		if portable {
			dataDir = filepath.Join(*rootFlag, ".mix4up")
		} else {
			dataDir = userDataDir()
		}
	}
	dataDir, _ = filepath.Abs(dataDir)
	startLog(dataDir)
	logf("Mix4Up %s (%s), datos en %s", version, map[bool]string{true: "portable", false: "instalada"}[portable], dataDir)

	tok := *tokenFlag
	if tok == "" {
		b := make([]byte, 16)
		rand.Read(b)
		tok = hex.EncodeToString(b)
	}
	s := &server{dataDir: dataDir, portable: portable, root: *rootFlag, token: tok}
	s.lib = newLibrary(s)
	s.yt = newYT(s)
	s.dl = newDownloads(s)

	ln, err := net.Listen("tcp", addr)
	if err != nil && askOldToQuit() {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		logf("el puerto %s está ocupado: %v", addr, err)
		os.Exit(3)
	}
	go s.lib.scanLoop()
	go func() { // yt-dlp listo (y al día) antes del primer vídeo de YouTube
		time.Sleep(3 * time.Second)
		for {
			ytdl.prepare()
			time.Sleep(6 * time.Hour)
		}
	}()
	s.lanInit()
	if !shell {
		log.Printf("Mix4Up en http://%s/", addr)
	}
	srv := &http.Server{Handler: s.localOnly(s.routes())}
	go srv.Serve(ln)
	s.run()
}

// Otro motor de Mix4Up más viejo sigue abierto (tras actualizar): se le pide que se vaya.
func askOldToQuit() bool {
	c := http.Client{Timeout: 2 * time.Second}
	r, err := c.Get("http://" + addr + "/api/version")
	if err != nil {
		return false
	}
	v, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if buildNum(string(v)) > buildNum(version) && !shell {
		return false
	}
	if r, err := c.Post("http://"+addr+"/api/quit?v="+version, "", nil); err == nil {
		r.Body.Close()
	}
	for i := 0; i < 30; i++ {
		time.Sleep(150 * time.Millisecond)
		if ln, err := net.Listen("tcp", addr); err == nil {
			ln.Close()
			return true
		}
	}
	return false
}

func init() {
	mime.AddExtensionType(".ico", "image/x-icon")
	mime.AddExtensionType(".vtt", "text/vtt")
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	log.SetFlags(0)
}
