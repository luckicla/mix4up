package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
// arrancar), Mix4Up pregunta a YouTube directamente, sin cuenta, como lo hace
// su app para las Apple Vision Pro (lo mismo que MixUp para la música).
// YouTube le da a esa app las direcciones de la imagen y el sonido de todas
// las calidades tal cual: sin acertijos de JavaScript, sin «PO token» y sin
// anuncio delante, así que el vídeo está listo en una fracción de segundo.
// Si YouTube no las da (vídeos con restricción de edad, de miembros…), se usa
// yt-dlp como siempre.
//
// (Antes era la app de las Oculus, ANDROID_VR, pero YouTube la rechaza desde
// agosto de 2026.) Si YouTube cambia lo que pide a esta app, se cambia aquí
// (yt-dlp la llama «visionos»).
const (
	visionName    = "VISIONOS"
	visionVersion = "1.02"
	visionNumber  = "101"
	visionAgent   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
	visionMake    = "Apple"
	visionModel   = "RealityDevice17,1"
	visionOS      = "visionOS"
	visionOSVer   = "26.5.23O471"
)

const visitorTTL = 6 * time.Hour

var fastBase = "https://www.youtube.com" // otro en las pruebas

var fastHTTP = &http.Client{Timeout: 8 * time.Second}

var fast = struct {
	sync.Mutex
	fails     int
	offTil    time.Time
	visitor   string // el «visitante» que YouTube da a la app (solo en memoria)
	visitorAt time.Time
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
		fast.visitor = "" // al volver, con un visitante nuevo
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

type fastFmt struct {
	Itag          int               `json:"itag"`
	URL           string            `json:"url"`
	Mime          string            `json:"mimeType"`
	Width         int               `json:"width"`
	Height        int               `json:"height"`
	FPS           int               `json:"fps"`
	Bitrate       fastNum           `json:"bitrate"`
	AvgBitrate    fastNum           `json:"averageBitrate"`
	Length        fastNum           `json:"contentLength"`
	DurationMs    fastNum           `json:"approxDurationMs"`
	QualityLabel  string            `json:"qualityLabel"`
	AudioChannels int               `json:"audioChannels"`
	IsDrc         bool              `json:"isDrc"`
	Type          string            `json:"type"`
	TargetDur     fastNum           `json:"targetDurationSec"`
	Drm           []json.RawMessage `json:"drmFamilies"`
	Color         struct {
		Transfer string `json:"transferCharacteristics"`
	} `json:"colorInfo"`
	Audio *struct {
		Name    string `json:"displayName"`
		ID      string `json:"id"`
		Default bool   `json:"audioIsDefault"`
	} `json:"audioTrack"`
}

// fastNum: YouTube manda tamaños y duraciones como número o como texto
type fastNum float64

func (n *fastNum) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*n = 0
		return nil
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*n = fastNum(v)
	return nil
}

type fastAnswer struct {
	Context struct {
		Visitor string `json:"visitorData"`
	} `json:"responseContext"`
	Playability struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	} `json:"playabilityStatus"`
	Streaming struct {
		Formats  []fastFmt `json:"formats"`
		Adaptive []fastFmt `json:"adaptiveFormats"`
		Expires  fastNum   `json:"expiresInSeconds"`
	} `json:"streamingData"`
	Details struct {
		ID      string `json:"videoId"`
		Title   string `json:"title"`
		Length  string `json:"lengthSeconds"`
		Channel string `json:"author"`
		ChanID  string `json:"channelId"`
		Desc    string `json:"shortDescription"`
		Views   string `json:"viewCount"`
		Live    bool   `json:"isLive"`
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

func (a *fastAnswer) botCheck() bool {
	return a.Playability.Status == "LOGIN_REQUIRED" && strings.Contains(strings.ToLower(a.Playability.Reason), "not a bot")
}

// usable: tal cual la da (sin firma ni acertijo en la dirección), sin cifrar,
// no el «volumen estable» de YouTube, no un directo y no cortada a medias.
func (f fastFmt) usable(length float64) bool {
	if f.URL == "" {
		return false
	}
	if u, err := url.Parse(f.URL); err != nil || u.Query().Has("n") {
		return false
	}
	dur := float64(f.DurationMs) / 1000
	return !f.IsDrc && len(f.Drm) == 0 && f.Type != "FORMAT_STREAM_TYPE_OTF" && f.TargetDur == 0 &&
		!(length > 0 && dur > 0 && dur < length/2)
}

// fastInfo: lo que la app de las Vision Pro sabe de un vídeo (todas las calidades)
func fastInfo(id string) (*ytInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	visitor := visitorID(ctx)
	ans, err := fastPlayer(ctx, id, visitor)
	if err == nil && ans.botCheck() {
		// sin un visitante de confianza YouTube pregunta si es un robot; su respuesta trae uno nuevo, que pasa
		fresh := ans.Context.Visitor
		forgetVisitor()
		if fresh == "" || fresh == visitor {
			fresh = visitorID(ctx)
		}
		visitor = fresh
		ans, err = fastPlayer(ctx, id, fresh)
	}
	if err != nil {
		return nil, errors.New("rápido: " + err.Error())
	}
	if !ans.botCheck() {
		v := ans.Context.Visitor
		if v == "" {
			v = visitor
		}
		keepVisitor(v)
	}
	if ans.Playability.Status != "OK" {
		return nil, errors.New("rápido: " + ans.Playability.Status + " " + ans.Playability.Reason)
	}
	d := ans.Details
	if d.ID != "" && d.ID != id {
		return nil, errors.New("rápido: YouTube contestó con otro vídeo")
	}
	if d.Live {
		return nil, errors.New("rápido: un directo")
	}
	in := &ytInfo{ID: id, Title: d.Title, Channel: d.Channel, ChannelID: d.ChanID, Description: d.Desc, exp: time.Now().Add(5 * time.Hour)}
	in.Duration, _ = strconv.ParseFloat(d.Length, 64)
	in.Views, _ = strconv.ParseInt(d.Views, 10, 64)
	if n := len(d.Thumb.Thumbnails); n > 0 {
		in.Thumb = d.Thumb.Thumbnails[n-1].URL
	}
	if e := float64(ans.Streaming.Expires); e > 0 {
		in.exp = time.Now().Add(time.Duration(e) * time.Second)
	}
	for _, f := range append(ans.Streaming.Formats, ans.Streaming.Adaptive...) {
		if !f.usable(in.Duration) {
			continue // para eso está yt-dlp
		}
		mime, _, _ := strings.Cut(f.Mime, ";")
		codecs := ""
		if m := codecsRe.FindStringSubmatch(f.Mime); m != nil {
			codecs = m[1]
		}
		kbps := float64(f.AvgBitrate)
		if kbps == 0 {
			kbps = float64(f.Bitrate)
		}
		x := &ytFormat{ID: strconv.Itoa(f.Itag), Height: f.Height, Width: f.Width, FPS: float64(f.FPS), TBR: kbps / 1000,
			Size: int64(f.Length), url: f.URL, headers: map[string]string{"User-Agent": visionAgent}}
		parts := strings.Split(codecs, ",")
		switch {
		case strings.HasPrefix(mime, "audio/"):
			if f.AudioChannels > 2 {
				continue // 5.1: el navegador no siempre lo baja bien a dos altavoces
			}
			x.Kind, x.ACodec = "a", strings.TrimSpace(parts[0])
			x.Ext = map[bool]string{true: "m4a", false: "webm"}[mime == "audio/mp4"]
			x.mime = mime
			if f.Audio != nil {
				x.Note = f.Audio.Name
				if f.Audio.Default {
					x.Note += " (original)"
				}
				if l, _, ok := strings.Cut(f.Audio.ID, "."); ok {
					x.Lang = l
				}
			}
		case len(parts) > 1:
			x.Kind, x.VCodec, x.ACodec = "av", strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
			x.Ext, x.mime = "mp4", "video/mp4"
		default:
			x.Kind, x.VCodec = "v", strings.TrimSpace(parts[0])
			x.Ext = map[bool]string{true: "mp4", false: "webm"}[mime == "video/mp4"]
			x.mime = mime
			t := f.Color.Transfer
			x.HDR = strings.Contains(f.QualityLabel, "HDR") || strings.Contains(t, "SMPTEST2084") || strings.Contains(t, "ARIB_STD_B67")
		}
		if u, err := url.Parse(f.URL); err == nil {
			if e, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && e > 0 && time.Unix(e, 0).Before(in.exp) {
				in.exp = time.Unix(e, 0)
			}
		}
		in.Formats = append(in.Formats, x)
	}
	for _, t := range ans.Captions.R.Tracks {
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
	// ¿de verdad da el vídeo? Un trozo pequeño del sonido y otro de la imagen más grande (la que
	// pone «La máxima»): si YouTube da direcciones que luego rechaza, mejor pasar a yt-dlp ahora que
	// con el vídeo a medias (sonaba un momento y se quedaba en negro). Las conexiones se quedan abiertas.
	var audio, best *ytFormat
	for _, f := range in.Formats {
		if f.Kind == "a" && audio == nil {
			audio = f
		}
		if f.Kind == "v" && (best == nil || f.Height > best.Height) {
			best = f
		}
	}
	for _, f := range []*ytFormat{audio, best} {
		if f == nil {
			continue
		}
		r, err := f.fetch(0, 1023)
		if err != nil {
			return nil, errors.New("rápido: comprobación (" + f.Kind + " " + f.ID + "): " + err.Error())
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}
	return in, nil
}

func keepVisitor(v string) {
	if v == "" {
		return
	}
	fast.Lock()
	if fast.visitor != v {
		fast.visitor, fast.visitorAt = v, time.Now()
	}
	fast.Unlock()
}

func forgetVisitor() {
	fast.Lock()
	fast.visitor = ""
	fast.Unlock()
}

// visitorID: el que YouTube dio a la app (solo en memoria), o uno nuevo; "" si no da (se pregunta sin)
func visitorID(ctx context.Context) string {
	fast.Lock()
	if fast.visitor != "" && time.Since(fast.visitorAt) < visitorTTL {
		v := fast.visitor
		fast.Unlock()
		return v
	}
	fast.Unlock()
	var ans struct {
		Context struct {
			Visitor string `json:"visitorData"`
		} `json:"responseContext"`
	}
	if err := fastCall(ctx, "visitor_id", nil, "", &ans); err != nil {
		return ""
	}
	keepVisitor(ans.Context.Visitor)
	return ans.Context.Visitor
}

func fastPlayer(ctx context.Context, id, visitor string) (*fastAnswer, error) {
	var ans fastAnswer
	body := map[string]any{
		"videoId":         id,
		"playbackContext": map[string]any{"contentPlaybackContext": map[string]any{"html5Preference": "HTML5_PREF_WANTS"}},
		"contentCheckOk":  true,
		"racyCheckOk":     true,
	}
	err := fastCall(ctx, "player", body, visitor, &ans)
	return &ans, err
}

// fastCall: una pregunta a la API de YouTube como la app de las Vision Pro, sin cookies ni cuenta
func fastCall(ctx context.Context, endpoint string, body map[string]any, visitor string, out any) error {
	client := map[string]any{
		"clientName":       visionName,
		"clientVersion":    visionVersion,
		"deviceMake":       visionMake,
		"deviceModel":      visionModel,
		"osName":           visionOS,
		"osVersion":        visionOSVer,
		"userAgent":        visionAgent,
		"hl":               "es",
		"gl":               "ES",
		"timeZone":         "UTC",
		"utcOffsetMinutes": 0,
	}
	if visitor != "" {
		client["visitorData"] = visitor
	}
	payload := map[string]any{"context": map[string]any{"client": client}}
	for k, v := range body {
		payload[k] = v
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fastBase+"/youtubei/v1/"+endpoint+"?prettyPrint=false", bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", visionAgent)
	req.Header.Set("Origin", "https://www.youtube.com")
	req.Header.Set("X-YouTube-Client-Name", visionNumber)
	req.Header.Set("X-YouTube-Client-Version", visionVersion)
	if visitor != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitor)
	}
	resp, err := fastHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("YouTube contestó %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}
