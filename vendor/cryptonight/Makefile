CC ?= gcc
CFLAGS ?= -O2 -std=gnu11 -maes -msse2 -Wno-unused-function -Wno-deprecated-declarations
PREFIX ?= /usr/local

SRC = \
	cli.c \
	slow-hash.c \
	hash.c \
	keccak.c \
	blake256.c \
	groestl.c \
	jh.c \
	skein.c \
	hash-extra-blake.c \
	hash-extra-groestl.c \
	hash-extra-jh.c \
	hash-extra-skein.c \
	aesb.c \
	oaes_lib.c \
	CryptonightR_JIT.c

.PHONY: all install clean

all: cn-slow-hash

cn-slow-hash: $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC) -I. -lm

install: cn-slow-hash
	install -d $(PREFIX)/bin
	install -m 755 cn-slow-hash $(PREFIX)/bin/cn-slow-hash

clean:
	rm -f cn-slow-hash
