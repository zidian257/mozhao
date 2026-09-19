package ulid

import (
	"testing"
	"time"
)

func TestNewAndValid(t *testing.T) {
	a := New(time.Now())
	b := New(time.Now())
	if len(a) != 26 {
		t.Fatalf("len(%q) = %d; want 26", a, len(a))
	}
	if a == b {
		t.Fatal("two consecutive ULIDs equal")
	}
	if !Valid(a) {
		t.Fatalf("New() = %q not Valid", a)
	}
	if !Valid("01ARZ3NDEKTSV4RRFFQ69G5FAV") {
		t.Fatal("canonical ULID rejected")
	}
	// 大小写均可（Crockford base32 解码大小写不敏感）
	if !Valid("01arz3ndektsv4rrffq69g5fav") {
		t.Fatal("lowercase ULID rejected")
	}
}

func TestValidRejects(t *testing.T) {
	bad := []string{
		"",                            // 空
		"01ARZ3NDEKTSV4RRFFQ69G5FA",   // 25 位
		"01ARZ3NDEKTSV4RRFFQ69G5FAVX", // 27 位
		"01ARZ3NDEKTSV4RRFFQ69G5FAI",  // 含 I
		"01ARZ3NDEKTSV4RRFFQ69G5FAL",  // 含 L
		"01ARZ3NDEKTSV4RRFFQ69G5FAO",  // 含 O
		"01ARZ3NDEKTSV4RRFFQ69G5FAU",  // 含 U
		"81ARZ3NDEKTSV4RRFFQ69G5FAV",  // 首字符 > 7（超出 48-bit 时间戳）
		"01ARZ3NDEKTSV4RRFFQ69G5FA!",  // 非法字符
		"not-a-ulid",
	}
	for _, s := range bad {
		if Valid(s) {
			t.Fatalf("Valid(%q) = true; want false", s)
		}
	}
}
