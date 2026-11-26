package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// un YouTube de mentira: la API como se la da a la app de las Vision Pro, y los archivos
func TestFastInfoVision(t *testing.T) {
	var srv *httptest.Server
	botOnce := true
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/youtubei/v1/visitor_id":
			fmt.Fprint(w, `{"responseContext":{"visitorData":"V1"}}`)
		case "/youtubei/v1/player":
			var body struct {
				Context struct {
					Client map[string]any `json:"client"`
				} `json:"context"`
				VideoID string `json:"videoId"`
			}
			b, _ := io.ReadAll(r.Body)
			json.Unmarshal(b, &body)
			c := body.Context.Client
			if c["clientName"] != "VISIONOS" || r.Header.Get("X-YouTube-Client-Name") != "101" || r.Header.Get("User-Agent") != visionAgent {
				t.Errorf("no pregunta como la app de las Vision Pro: %v", c)
			}
			if botOnce {
				botOnce = false
				fmt.Fprint(w, `{"responseContext":{"visitorData":"V2"},"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you're not a bot"}}`)
				return
			}
			if c["visitorData"] != "V2" {
				t.Errorf("tras «no soy un robot» debía usar el visitante nuevo, usó %v", c["visitorData"])
			}
			u := srv.URL + "/media?expire=9999999999&itag="
			fmt.Fprintf(w, `{"playabilityStatus":{"status":"OK"},
			 "videoDetails":{"videoId":"%s","title":"Prueba","lengthSeconds":"60","author":"Canal"},
			 "streamingData":{"expiresInSeconds":"21540",
			  "formats":[{"itag":18,"url":"%s18","mimeType":"video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"","height":360,"width":640}],
			  "adaptiveFormats":[
			   {"itag":313,"url":"%s313","mimeType":"video/webm; codecs=\"vp9\"","height":2160,"width":3840,"fps":30,"bitrate":"20000000","contentLength":"123456"},
			   {"itag":337,"url":"%s337","mimeType":"video/webm; codecs=\"vp09.02.51.10.01.09.16.09.00\"","height":2160,"width":3840,"qualityLabel":"2160p HDR","colorInfo":{"transferCharacteristics":"COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084"}},
			   {"itag":137,"url":"%s137&n=abc","mimeType":"video/mp4; codecs=\"avc1.640028\"","height":1080},
			   {"itag":140,"url":"%s140","mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","audioChannels":2,"audioTrack":{"displayName":"English","id":"en.4","audioIsDefault":true}},
			   {"itag":141,"url":"%s141","mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","audioChannels":2,"isDrc":true}
			  ]}}`, body.VideoID, u, u, u, u, u, u)
		case "/media":
			if r.Header.Get("User-Agent") != visionAgent {
				t.Errorf("el archivo se pide sin el agente de la app")
			}
			w.Header().Set("Content-Range", "bytes 0-1023/2048")
			w.WriteHeader(206)
			w.Write(make([]byte, 1024))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := fastBase
	fastBase = srv.URL
	defer func() { fastBase = old; forgetVisitor() }()

	in, err := fastInfo("abcdefghijk")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]*ytFormat{}
	for _, f := range in.Formats {
		got[f.ID] = f
	}
	if got["313"] == nil || got["313"].Height != 2160 || got["313"].Kind != "v" || got["313"].HDR {
		t.Errorf("falta el 4K normal: %+v", got["313"])
	}
	if got["337"] == nil || !got["337"].HDR {
		t.Errorf("el 4K HDR debía venir marcado: %+v", got["337"])
	}
	if got["137"] != nil {
		t.Error("una dirección con acertijo (n=) no se puede usar tal cual")
	}
	if got["141"] != nil {
		t.Error("el «volumen estable» no vale")
	}
	if a := got["140"]; a == nil || a.Kind != "a" || a.Note != "English (original)" || a.Lang != "en" {
		t.Errorf("sonido: %+v", a)
	}
	if got["18"] == nil || got["18"].Kind != "av" {
		t.Error("falta el 360p de imagen y sonido juntos")
	}
	if in.Title != "Prueba" || in.Duration != 60 {
		t.Errorf("datos: %+v", in)
	}
}
