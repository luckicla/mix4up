package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// En el Mac Mix4Up baja sus herramientas como en Windows (yt-dlp, deno y
// ffmpeg), las de macOS. Si ya tienes ffmpeg de Homebrew, usa ese.
const (
	ytdlpExe        = "yt-dlp"
	ytdlpZip        = ""
	ytdlpAsset      = "yt-dlp_macos" // un solo archivo, vale para Intel y Apple Silicon
	denoExe         = "deno"
	ytDownloadTools = true
	ffmpegExe       = "ffmpeg"
	ffprobeExe      = "ffprobe"
)

var denoZip = map[string]string{"arm64": "deno-aarch64-apple-darwin.zip", "amd64": "deno-x86_64-apple-darwin.zip"}[runtime.GOARCH]

// ffmpeg y ffprobe sueltos para macOS (compilados por Martin Riedl, firmados por Apple)
var ffmpegURLs = []string{
	"https://ffmpeg.martin-riedl.de/redirect/latest/macos/" + runtime.GOARCH + "/release/ffmpeg.zip",
	"https://ffmpeg.martin-riedl.de/redirect/latest/macos/" + runtime.GOARCH + "/release/ffprobe.zip",
}

// Una app abierta desde el Finder no ve las carpetas de Homebrew en el PATH
var extraBinDirs = []string{"/opt/homebrew/bin", "/usr/local/bin"}

func hideConsole(*exec.Cmd) {}

func userVideosDir() string {
	if d := os.Getenv("MIX4UP_VIDEOS"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Movies")
}

func appSupportDir() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Library", "Application Support", "Mix4Up")
}

func userDataDir() string { return appSupportDir() }

func toolsDir() string { return filepath.Join(appSupportDir(), "herramientas") }

// mostrar el archivo en el Finder
func revealFile(p string) { exec.Command("open", "-R", p).Start() }

// shutdownPC: como en Windows, apaga en 60 s si no se cancela antes.
var (
	offMu    sync.Mutex
	offTimer *time.Timer
)

func shutdownPC(cancel bool) error {
	offMu.Lock()
	defer offMu.Unlock()
	if offTimer != nil {
		offTimer.Stop()
		offTimer = nil
	}
	if cancel {
		return nil
	}
	offTimer = time.AfterFunc(60*time.Second, func() {
		if err := exec.Command("osascript", "-e", `tell application "System Events" to shut down`).Run(); err != nil {
			logf("apagar: %v", err)
		}
	})
	return nil
}
