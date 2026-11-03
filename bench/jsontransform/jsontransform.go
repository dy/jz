// jsontransform.go – an API gateway's JSON round trip: parse a page of order
// records, keep the paid orders worth at least 20 after their discount, count
// their tags, and serialize the response. Go's idiomatic answer is
// encoding/json over tagged structs in both directions; its float parsing is
// correctly rounded and its float formatting is ECMAScript's, so the response
// text matches JSON.stringify byte for byte.
//
// Reports: median ms across N_RUNS, throughput in orders/µs, FNV-1a checksum
// over the response text's UTF-16 code units.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
	"unicode/utf16"
)

const (
	n       = 1024 // orders in the document
	nRuns   = 21
	nWarmup = 5
)

var names = []string{"Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
	"Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov", "Grace Hopper", "Alan Turing"}
var products = []string{"Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
	"Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Ångström ruler", "Pens (12)", "Ruler 30cm"}
var tagNames = []string{"bulk", "express", "fragile", "gift", "priority", "return"}
var discounts = []float64{0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3}

type Customer struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	VIP  bool   `json:"vip"`
}

type Item struct {
	SKU   string  `json:"sku"`
	Name  string  `json:"name"`
	Qty   int     `json:"qty"`
	Price float64 `json:"price"`
}

type Order struct {
	ID       int      `json:"id"`
	Status   string   `json:"status"`
	Customer Customer `json:"customer"`
	Items    []Item   `json:"items"`
	Discount float64  `json:"discount"`
	Tags     []string `json:"tags"`
}

type Document struct {
	Page   int     `json:"page"`
	Per    int     `json:"per"`
	Orders []Order `json:"orders"`
}

type TagCounts struct {
	Bulk     int `json:"bulk"`
	Express  int `json:"express"`
	Fragile  int `json:"fragile"`
	Gift     int `json:"gift"`
	Priority int `json:"priority"`
	Return   int `json:"return"`
}

func (t *TagCounts) add(tag string) {
	switch tag {
	case "bulk":
		t.Bulk++
	case "express":
		t.Express++
	case "fragile":
		t.Fragile++
	case "gift":
		t.Gift++
	case "priority":
		t.Priority++
	case "return":
		t.Return++
	}
}

type Kept struct {
	ID       int      `json:"id"`
	Customer string   `json:"customer"`
	VIP      bool     `json:"vip"`
	Lines    int      `json:"lines"`
	First    string   `json:"first"`
	Total    float64  `json:"total"`
	Tags     []string `json:"tags"`
}

type Response struct {
	Page      int       `json:"page"`
	Count     int       `json:"count"`
	Revenue   float64   `json:"revenue"`
	TagCounts TagCounts `json:"tagCounts"`
	Orders    []Kept    `json:"orders"`
}

var seed = uint32(0x2545f491)

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

func makeDocument() []byte {
	doc := Document{Page: 1, Per: n, Orders: make([]Order, 0, n)}
	for i := 0; i < n; i++ {
		nItems := 1 + int(next()%6)
		items := make([]Item, 0, nItems)
		for k := 0; k < nItems; k++ {
			sku := "SKU-" + strconv.Itoa(int(10000+next()%90000))
			name := products[next()%uint32(len(products))]
			qty := 1 + int(next()%9)
			price := float64(99+next()%19901) / 100
			items = append(items, Item{SKU: sku, Name: name, Qty: qty, Price: price})
		}
		tags := []string{}
		nTags := int(next() % 4)
		for k := 0; k < nTags; k++ {
			tags = append(tags, tagNames[next()%uint32(len(tagNames))])
		}
		r := next()
		status := "paid"
		if r&7 == 0 {
			status = "cancelled"
		}
		doc.Orders = append(doc.Orders, Order{
			ID:       1000000 + i,
			Status:   status,
			Customer: Customer{ID: 5000 + int(r%3000), Name: names[(r>>4)%uint32(len(names))], VIP: r&64 != 0},
			Items:    items,
			Discount: discounts[(r>>8)%uint32(len(discounts))],
			Tags:     tags,
		})
	}
	text, _ := json.Marshal(&doc)
	return text
}

func transform(text []byte) []byte {
	var doc Document
	_ = json.Unmarshal(text, &doc)
	res := Response{Page: doc.Page, Orders: []Kept{}}
	revenue := 0.0
	for i := range doc.Orders {
		o := &doc.Orders[i]
		if o.Status != "paid" {
			continue
		}
		sub := 0.0
		for _, it := range o.Items {
			// the conversion rounds the product, as JS does: no fused multiply-add
			sub += float64(float64(it.Qty) * it.Price)
		}
		total := math.Round(sub*(1-o.Discount)*100) / 100
		if total < 20 {
			continue
		}
		revenue += total
		for _, t := range o.Tags {
			res.TagCounts.add(t)
		}
		res.Orders = append(res.Orders, Kept{ID: o.ID, Customer: o.Customer.Name, VIP: o.Customer.VIP,
			Lines: len(o.Items), First: o.Items[0].Name, Total: total, Tags: o.Tags})
	}
	res.Count = len(res.Orders)
	res.Revenue = math.Round(revenue*100) / 100
	out, _ := json.Marshal(&res)
	return out
}

func checksum(s []byte) uint32 {
	units := utf16.Encode([]rune(string(s)))
	h := mix(0x811c9dc5, uint32(len(units)))
	for _, u := range units {
		h = mix(h, uint32(u))
	}
	return h
}

func main() {
	text := makeDocument()
	var out []byte
	for i := 0; i < nWarmup; i++ {
		out = transform(text)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		out = transform(text)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(out), n, 3, nRuns)
}
