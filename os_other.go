//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// Fuera de Windows (solo para desarrollar y probar) yt-dlp, deno y ffmpeg vienen del PATH.
const (
	ytdlpExe        = "yt-dlp"
	ytdlpZip        = ""
	denoExe         = "deno"
	denoZip         = ""
	ytDownloadTools = false
	ffmpegExe       = "ffmpeg"
	ffprobeExe      = "ffprobe"
	ffmpegZip       = ""
)

func hideConsole(*exec.Cmd) {}

func userVideosDir() string {
	if d := os.Getenv("MIX4UP_VIDEOS"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Videos")
}

func userDataDir() string { d, _ := os.UserConfigDir(); return filepath.Join(d, "mix4up") }

func toolsDir() string { return filepath.Join(os.TempDir(), "mix4up-herramientas") }

func revealFile(p string) { exec.Command("xdg-open", filepath.Dir(p)).Start() }

func shutdownPC(cancel bool) error { return errors.New("solo en Windows") }
