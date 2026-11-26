package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Baja de verdad yt-dlp, deno y ffmpeg para el Mac y comprueba que arrancan.
// Solo en el CI del Mac (necesita red): MIX4UP_PRUEBA_HERRAMIENTAS=1 go test -run Herramientas
func TestHerramientasMac(t *testing.T) {
	if os.Getenv("MIX4UP_PRUEBA_HERRAMIENTAS") == "" {
		t.Skip("sin MIX4UP_PRUEBA_HERRAMIENTAS")
	}
	dir := t.TempDir()
	run := func(name string, args ...string) {
		t.Helper()
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Errorf("%s: %v\n%s", filepath.Base(name), err, out)
			return
		}
		t.Logf("%s: %.120s", filepath.Base(name), out)
	}

	if err := fetchDeno(dir); err != nil {
		t.Errorf("deno: %v", err)
	} else {
		run(filepath.Join(dir, denoExe), "--version")
	}

	tag, err := latestTag("yt-dlp/yt-dlp")
	if err != nil {
		t.Fatalf("yt-dlp: última versión: %v", err)
	}
	if err := fetchYtdlp(dir, tag); err != nil {
		t.Errorf("yt-dlp %s: %v", tag, err)
	} else {
		cur, _ := os.ReadFile(filepath.Join(dir, "current"))
		run(filepath.Join(dir, string(cur), ytdlpExe), "--version")
	}

	ff := filepath.Join(dir, "ffmpeg")
	if err := fetchFFmpeg(ff); err != nil {
		t.Errorf("ffmpeg: %v", err)
	} else {
		run(filepath.Join(ff, "bin", ffmpegExe), "-hide_banner", "-version")
		run(filepath.Join(ff, "bin", ffprobeExe), "-hide_banner", "-version")
	}
}
