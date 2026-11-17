package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// El camino rápido: antes de despertar a yt-dlp (que tarda unos segundos en
// arrancar), Mix4Up pregunta a YouTube directamente como lo hace su app de
// realidad virtual, que da las direcciones de la imagen y el sonido sin
// acertijos de JavaScript. Si YouTube no las da (vídeos con restricción de
// edad, «demuestra que no eres un robot»…), se usa yt-dlp como siempre.

const vrVersion = "1.65.10"
const vrUA = "com.google.android.apps.youtube.vr.oculus/" + vrVersion + " (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"

var fast = struct {
	sync.Mutex
	fails  int
	offTil time.Time
}{}

var codecsRe = regexp.MustCompile(`codecs="([^"]+)"`)

func fastOff() bool {
	fast.Lock()
	defer fast.Unlock()
	return time.Now().Before(fast.offTil)
}

func fastResult(ok bool, err error) {
	fast.Lock()
	defer fast.Unlock()
	if ok {
		fast.fails = 0
		return
	}
	// un vídeo con edad, privado, de miembros… no apaga el camino rápido para los demás
	if m := err.Error(); strings.Contains(m, "UNPLAYABLE") || strings.Contains(m, "rápido: ERROR") || (strings.Contains(m, "LOGIN_REQUIRED") && !strings.Contains(strings.ToLower(m), "bot")) {
		return
	}
	if fast.fails++; fast.fails >= 3 {
		fast.offTil = time.Now().Add(5 * time.Minute)
		fast.fails = 0
	}
}

// warm: la conexión con el servidor del vídeo, ya abierta (al darle, empieza sin esperar el saludo de cifrado)
func (in *ytInfo) warm() {
	for _, f := range in.Formats {
		if f.Kind == "a" {
			if r, err := f.fetch(0, 1023); err == nil {
				io.Copy(io.Discard, r.Body)
				r.Body.Close()
			}
			return
		}
	}
}

func fastInfo(id string, visitor string) (*ytInfo, error) {
	body := map[string]any{
		"context": map[string]any{"client": map[string]any{
			"clientName": "ANDROID_VR", "clientVersion": vrVersion, "deviceMake": "Oculus", "deviceModel": "Quest 3",
			"androidSdkVersion": 32, "userAgent": vrUA, "osName": "Android", "osVersion": "12L", "hl": "es", "gl": "ES",
			"visitorData": visitor,
		}},
		"videoId": id, "contentCheckOk": true, "racyCheckOk": true,
	}
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", vrUA)
	req.Header.Set("X-Youtube-Client-Name", "28")
	req.Header.Set("X-Youtube-Client-Version", vrVersion)
	req.Header.Set("Origin", ytOrigin)
	if visitor != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitor)
	}
	c := &http.Client{Timeout: 10 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var j struct {
		Playability struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"playabilityStatus"`
		Streaming struct {
			Formats  []fastFmt `json:"formats"`
			Adaptive []fastFmt `json:"adaptiveFormats"`
			Expires  string    `json:"expiresInSeconds"`
		} `json:"streamingData"`
		Details struct {
			ID      string `json:"videoId"`
			Title   string `json:"title"`
			Length  string `json:"lengthSeconds"`
			Channel string `json:"author"`
			ChanID  string `json:"channelId"`
			Desc    string `json:"shortDescription"`
			Views   string `json:"viewCount"`
			Live    bool   `json:"isLiveContent"`
			Thumb   struct {
				Thumbnails []struct {
					URL string `json:"url"`
				} `json:"thumbnails"`
			} `json:"thumbnail"`
		} `json:"videoDetails"`
		Captions struct {
			R struct {
				Tracks []struct {
					URL  string `json:"baseUrl"`
					Lang string `json:"languageCode"`
					Kind string `json:"kind"`
					Name struct {
						Runs []struct {
							Text string `json:"text"`
						} `json:"runs"`
						Simple string `json:"simpleText"`
					} `json:"name"`
				} `json:"captionTracks"`
			} `json:"playerCaptionsTracklistRenderer"`
		} `json:"captions"`
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, err
	}
	if j.Playability.Status != "OK" {
		return nil, errors.New("rápido: " + j.Playability.Status + " " + j.Playability.Reason)
	}
	d := j.Details
	in := &ytInfo{ID: id, Title: d.Title, Channel: d.Channel, ChannelID: d.ChanID, Description: d.Desc, exp: time.Now().Add(5 * time.Hour)}
	in.Duration, _ = strconv.ParseFloat(d.Length, 64)
	in.Views, _ = strconv.ParseInt(d.Views, 10, 64)
	if n := len(d.Thumb.Thumbnails); n > 0 {
		in.Thumb = d.Thumb.Thumbnails[n-1].URL
	}
	if e, err := strconv.Atoi(j.Streaming.Expires); err == nil && e > 0 {
		in.exp = time.Now().Add(time.Duration(e) * time.Second)
	}
	for _, f := range append(j.Streaming.Formats, j.Streaming.Adaptive...) {
		if f.URL == "" {
			continue // cifrado: para eso está yt-dlp
		}
		mime, _, _ := strings.Cut(f.Mime, ";")
		codecs := ""
		if m := codecsRe.FindStringSubmatch(f.Mime); m != nil {
			codecs = m[1]
		}
		x := &ytFormat{ID: strconv.Itoa(f.Itag), Height: f.Height, Width: f.Width, FPS: float64(f.FPS), TBR: float64(f.Bitrate) / 1000,
			url: f.URL, headers: map[string]string{"User-Agent": vrUA}}
		x.Size, _ = strconv.ParseInt(f.Length, 10, 64)
		parts := strings.Split(codecs, ",")
		switch {
		case strings.HasPrefix(mime, "audio/"):
			x.Kind, x.ACodec = "a", strings.TrimSpace(parts[0])
			x.Ext = map[bool]string{true: "m4a", false: "webm"}[mime == "audio/mp4"]
			x.mime = mime
			if f.Audio.Name != "" {
				x.Note = f.Audio.Name
				if f.Audio.Default {
					x.Note += " (original)"
				}
			}
		case len(parts) > 1:
			x.Kind, x.VCodec, x.ACodec = "av", strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			x.Ext, x.mime = "mp4", "video/mp4"
		default:
			x.Kind, x.VCodec = "v", strings.TrimSpace(parts[0])
			x.Ext = map[bool]string{true: "mp4", false: "webm"}[mime == "video/mp4"]
			x.mime = mime
		}
		if u, err := url.Parse(f.URL); err == nil {
			if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 && time.Unix(e, 0).Before(in.exp) {
				in.exp = time.Unix(e, 0)
			}
		}
		in.Formats = append(in.Formats, x)
	}
	for _, t := range j.Captions.R.Tracks {
		name := t.Name.Simple
		for _, r := range t.Name.Runs {
			name += r.Text
		}
		in.Subs = append(in.Subs, ytSubTrack{Lang: t.Lang, Name: name, Auto: t.Kind == "asr", url: t.URL + "&fmt=vtt"})
	}
	hasV, hasA := false, false
	for _, f := range in.Formats {
		hasV = hasV || f.Kind != "a"
		hasA = hasA || f.Kind != "v"
	}
	if !hasV || !hasA {
		return nil, errors.New("rápido: sin direcciones")
	}
	// ¿de verdad da el vídeo? (un trozo pequeño del sonido; si YouTube da direcciones que luego
	// rechaza, mejor pasar a yt-dlp ahora que con el vídeo a medias)
	for _, f := range in.Formats {
		if f.Kind == "a" {
			r, err := f.fetch(0, 1023)
			if err != nil {
				return nil, errors.New("rápido: comprobación: " + err.Error())
			}
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			break
		}
	}
	return in, nil
}

type fastFmt struct {
	Itag    int    `json:"itag"`
	URL     string `json:"url"`
	Mime    string `json:"mimeType"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	FPS     int    `json:"fps"`
	Bitrate int    `json:"bitrate"`
	Length  string `json:"contentLength"`
	Audio   struct {
		Name    string `json:"displayName"`
		Default bool   `json:"audioIsDefault"`
	} `json:"audioTrack"`
}
