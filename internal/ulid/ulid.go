// Package ulid 实现 ULID（Crockford base32，48-bit 毫秒时间戳 + 80-bit 随机）。
// 契约规定 id 由客户端生成；服务端用本包做格式校验，New 供测试与未来服务端场景使用。
package ulid

import (
	"crypto/rand"
	"time"
)

// Alphabet 是 Crockford base32（剔除 I L O U）。
const Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var decTable = func() [256]byte {
	var t [256]byte
	for i := range t {
		t[i] = 0xFF
	}
	for i := 0; i < len(Alphabet); i++ {
		c := Alphabet[i]
		t[c] = byte(i)
		if c >= 'A' && c <= 'Z' {
			t[c+('a'-'A')] = byte(i)
		}
	}
	return t
}()

func decode(c byte) byte { return decTable[c] }

// New 生成一个 ULID：前 10 位为毫秒时间戳，后 16 位为 crypto/rand 随机。
func New(t time.Time) string {
	ms := uint64(t.UnixMilli())
	var entropy [10]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		panic("ulid: crypto/rand unavailable: " + err.Error())
	}
	var out [26]byte
	for i := 9; i >= 0; i-- {
		out[i] = Alphabet[ms&0x1F]
		ms >>= 5
	}
	acc, nbits, j := 0, 0, 10
	for _, b := range entropy {
		acc = acc<<8 | int(b)
		nbits += 8
		for nbits >= 5 {
			nbits -= 5
			out[j] = Alphabet[(acc>>nbits)&0x1F]
			j++
		}
	}
	return string(out[:])
}

// Valid 校验 ULID 格式：26 位、全部落在 Crockford base32（大小写均可）、
// 首字符不超过 '7'（48-bit 时间戳上界）。
func Valid(s string) bool {
	if len(s) != 26 {
		return false
	}
	for i := 0; i < 26; i++ {
		if decode(s[i]) == 0xFF {
			return false
		}
	}
	return decode(s[0]) <= 7
}
