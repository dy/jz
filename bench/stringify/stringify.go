// stringify.go – JSON serialization of realistic order records: every record
// on one line, every 16th also pretty-printed. Go's idiomatic answer is
// encoding/json over tagged structs (field order is declaration order, the
// JSON key order). Go formats floats exactly as ECMAScript does (shortest
// round trip, fixed notation in [1e-6, 1e21), `1.5e-7` below) and escapes the
// same characters, so the text matches JSON.stringify byte for byte; the data
// holds no `<`, `>`, `&`, U+2028 or U+2029, which only Go escapes.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the serialized text's UTF-16 code units.
package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
	"unicode/utf16"
)

const (
	n       = 1024 // records per pass
	dump    = 16   // every dump-th record is also pretty-printed
	nRuns   = 21
	nWarmup = 5
)

var names = []string{"Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
	"Ngũgĩ wa Thiong'o", "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov",
	"Ἀριστοτέλης", "Grace Hopper", "Alan Turing"}
var cities = []string{"Montréal", "Zürich", "København", "São Paulo", "東京", "Reykjavík", "Kraków", "Toronto"}
var products = []string{"Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
	"Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Bell\u0007", "Ångström ruler",
	"naïve façade", "Résumé paper", "Pens (12)", "Stand/Arm", "Ruler 30cm"}
var tagNames = []string{"gift", "express", "fragile", "bulk", "return", "priority"}
var notes = []string{"Leave at door", "Call \"front desk\"", "Ring twice\r\nthen wait", "Back\\slash",
	"form\ffeed", "checked ✓", "ctrl\u001fchar", "Merci beaucoup!"}
var discounts = []float64{0, 0.05, 0.1, 0.125, 0.15, 0.2, 1.0 / 3, 0.07}

type Address struct {
	City string `json:"city"`
	Zip  string `json:"zip"`
}

type Customer struct {
	ID      int     `json:"id"`
	Name    string  `json:"name"`
	Email   string  `json:"email"`
	VIP     bool    `json:"vip"`
	Address Address `json:"address"`
}

type Item struct {
	SKU   string  `json:"sku"`
	Name  string  `json:"name"`
	Qty   int     `json:"qty"`
	Price float64 `json:"price"`
}

type Geo struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type Record struct {
	ID       int      `json:"id"`
	Created  int64    `json:"created"`
	Customer Customer `json:"customer"`
	Items    []Item   `json:"items"`
	Total    float64  `json:"total"`
	Discount float64  `json:"discount"`
	Tags     []string `json:"tags"`
	Note     *string  `json:"note"`
	Geo      Geo      `json:"geo"`
	Rate     float64  `json:"rate"`
}

var seed = uint32(0x1234abcd)

func next() uint32 {
	seed ^= seed << 13
	seed ^= seed >> 17
	seed ^= seed << 5
	return seed
}

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func medianUs(samples []float64) int {
	for i := 1; i < len(samples); i++ {
		v := samples[i]
		j := i - 1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return int(samples[(len(samples)-1)>>1] * 1000)
}

func makeRecord(i int) Record {
	nItems := 1 + int(next()%5)
	items := make([]Item, 0, nItems)
	total := 0.0
	for k := 0; k < nItems; k++ {
		qty := 1 + int(next()%9)
		price := float64(99+next()%99901) / 100
		// the conversion rounds the product, as JS does: no fused multiply-add
		total += float64(float64(qty) * price)
		sku := "SKU-" + strconv.Itoa(int(10000+next()%90000))
		items = append(items, Item{SKU: sku, Name: products[next()%uint32(len(products))], Qty: qty, Price: price})
	}
	tags := []string{}
	nTags := int(next() % 4)
	for k := 0; k < nTags; k++ {
		tags = append(tags, tagNames[next()%uint32(len(tagNames))])
	}
	r := next()
	var note *string
	if r&3 == 0 {
		s := notes[(r>>6)%uint32(len(notes))]
		note = &s
	}
	rec := Record{
		ID:      1000000 + i,
		Created: 1767225600000 + int64(i)*61003,
		Customer: Customer{
			ID:    5000 + int(r%3000),
			Name:  names[r%uint32(len(names))],
			Email: "user" + strconv.Itoa(int(r%3000)) + "@example.com",
			VIP:   r&16 != 0,
			Address: Address{
				City: cities[(r>>8)%uint32(len(cities))],
				Zip:  "H" + strconv.Itoa(int((r>>12)%10)) + "X " + strconv.Itoa(int((r>>16)%10)) + "Y" + strconv.Itoa(int((r>>20)%10)),
			},
		},
		Items:    items,
		Total:    total,
		Discount: discounts[(r>>4)%uint32(len(discounts))],
		Tags:     tags,
		Note:     note,
	}
	rec.Geo.Lat = float64(next()%180000000)/1e6 - 90
	rec.Geo.Lon = float64(next()%360000000)/1e6 - 180
	rec.Rate = float64(1+next()%999) * 1.5e-7
	return rec
}

func serialize(records []Record, out [][]byte) int {
	k := 0
	for i := range records {
		out[k], _ = json.Marshal(&records[i])
		k++
		if i%dump == 0 {
			out[k], _ = json.MarshalIndent(&records[i], "", "  ")
			k++
		}
	}
	return k
}

func checksum(out [][]byte, k int) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < k; i++ {
		units := utf16.Encode([]rune(string(out[i])))
		h = mix(h, uint32(len(units)))
		for _, u := range units {
			h = mix(h, uint32(u))
		}
	}
	return h
}

func main() {
	records := make([]Record, n)
	for i := 0; i < n; i++ {
		records[i] = makeRecord(i)
	}
	out := make([][]byte, n+n/dump+1)
	k := 0
	for i := 0; i < nWarmup; i++ {
		k = serialize(records, out)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		k = serialize(records, out)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(out, k), n, 2, nRuns)
}
