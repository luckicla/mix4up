package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	ytdlpExe        = "yt-dlp.exe"
	ytdlpZip        = "yt-dlp_win.zip"
	denoExe         = "deno.exe"
	denoZip         = "deno-x86_64-pc-windows-msvc.zip"
	ytDownloadTools = true
	ffmpegExe       = "ffmpeg.exe"
	ffprobeExe      = "ffprobe.exe"
	ffmpegZip       = "ffmpeg-master-latest-win64-gpl-shared.zip"
)

var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
)

// sin ventanas negras de consola por cada vídeo
func hideConsole(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// userVideosDir: la carpeta Vídeos de Windows (aunque esté en OneDrive o movida).
func userVideosDir() string {
	folderVideos := syscall.GUID{Data1: 0x18989B1D, Data2: 0x99B5, Data3: 0x455B, Data4: [8]byte{0x84, 0x1C, 0xAB, 0x7C, 0x74, 0xE4, 0xDD, 0xFC}}
	var out *uint16
	if r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderVideos)), 0, 0, uintptr(unsafe.Pointer(&out))); r == 0 && out != nil {
		defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(out)))
		if p := syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(out))[:]); p != "" {
			return p
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Videos")
}

func userDataDir() string {
	if a := os.Getenv("APPDATA"); a != "" {
		return filepath.Join(a, "Mix4Up")
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Mix4Up", "data")
}

func toolsDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "Mix4Up", "herramientas")
	}
	return filepath.Join(os.TempDir(), "mix4up-herramientas")
}

func revealFile(p string) {
	c := exec.Command("explorer.exe", "/select,", p)
	c.Start()
}

// shutdownPC: apaga en 60 s (con aviso de Windows), o lo cancela.
func shutdownPC(cancel bool) error {
	args := []string{"/s", "/t", "60", "/c", "Mix4Up: se acabó el temporizador para dormir"}
	if cancel {
		args = []string{"/a"}
	}
	c := exec.Command("shutdown.exe", args...)
	hideConsole(c)
	return c.Run()
}
