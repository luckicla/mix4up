package main

// El registro de cambios (web/journal.js), en journal.json en la carpeta de
// datos. Lo escribe la página de este PC (/api/journal) y el móvil al
// sincronizar (/lan/journal): lo que llega se junta con lo que había (por el
// id de cada cambio), así ninguno puede borrar los cambios del otro con una
// copia vieja. Para cada cosa manda el cambio más reciente.

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"sort"
	"sync"
)

var journalMu sync.Mutex

type journalFile struct {
	Dev    string            `json:"dev"`
	Seq    int64             `json:"seq"`
	Events []json.RawMessage `json:"events"`
}

type jEvent struct {
	I string  `json:"i"`
	T float64 `json:"t"`
	Y string  `json:"y"`
	K string  `json:"k"`
}

func (s *server) journalPath() string { return filepath.Join(s.dataDir, "journal.json") }

// lan: lo que manda el móvil (el aparato y el contador de este PC no cambian)
func (s *server) journalDoc(w http.ResponseWriter, r *http.Request, lan bool) {
	journalMu.Lock()
	defer journalMu.Unlock()
	var cur journalFile
	readJSON(s.journalPath(), &cur)
	switch r.Method {
	case http.MethodPut, http.MethodPost:
		var in journalFile
		if json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&in) != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if !lan {
			if in.Dev != "" {
				cur.Dev = in.Dev
			}
			if in.Seq > cur.Seq {
				cur.Seq = in.Seq
			}
		}
		have := map[string]bool{}
		for _, e := range cur.Events {
			var x jEvent
			if json.Unmarshal(e, &x) == nil {
				have[x.I] = true
			}
		}
		added := 0
		for _, e := range in.Events {
			var x jEvent
			if json.Unmarshal(e, &x) != nil || x.I == "" || x.Y == "" || have[x.I] {
				continue
			}
			have[x.I] = true
			cur.Events = append(cur.Events, e)
			added++
		}
		cur.Events = trimJournal(cur.Events)
		if err := writeJSON(s.journalPath(), cur); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if lan && added > 0 {
			lan_.Lock()
			lan_.ver++
			lan_.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		if cur.Events == nil {
			cur.Events = []json.RawMessage{}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(cur)
	}
}

// solo importa lo último de cada cosa: pasados 30000, el resto se va
func trimJournal(ev []json.RawMessage) []json.RawMessage {
	if len(ev) <= 30000 {
		return ev
	}
	type item struct {
		raw json.RawMessage
		x   jEvent
	}
	last := map[string]item{}
	for _, e := range ev {
		var x jEvent
		if json.Unmarshal(e, &x) != nil {
			continue
		}
		k := x.Y + "\x01" + x.K
		if p, ok := last[k]; !ok || x.T > p.x.T || (x.T == p.x.T && x.I > p.x.I) {
			last[k] = item{e, x}
		}
	}
	out := make([]item, 0, len(last))
	for _, it := range last {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].x.T < out[j].x.T })
	if len(out) > 25000 {
		out = out[len(out)-25000:]
	}
	res := make([]json.RawMessage, len(out))
	for i, it := range out {
		res[i] = it.raw
	}
	return res
}
