CC=clang-9
CFLAGS=-O3
RUSTC=rustc
RUSTFLAGS=--crate-type=lib

.PHONY: all
all: basic.bc basic.ll \
			loop.bc loop.ll \
			call.bc call.ll \
			functionptr.bc functionptr.ll \
			crossmod.bc crossmod.ll \
			panic.bc panic.ll \

%.ll : %.c
	$(CC) $(CFLAGS) -S -emit-llvm $^ -o $@

%.bc : %.c
	$(CC) $(CFLAGS) -c -emit-llvm $^ -o $@

%.ll : %.cl
	$(CC) $(CFLAGS) -Xclang -finclude-default-header -S -emit-llvm $^ -o $@

%.bc : %.cl
	$(CC) $(CFLAGS) -Xclang -finclude-default-header -c -emit-llvm $^ -o $@

%.ll : %.rs
	$(RUSTC) $(RUSTFLAGS) --emit=llvm-ir $^ -o $@

%.bc : %.rs
	$(RUSTC) $(RUSTFLAGS) --emit=llvm-bc $^ -o $@

# use -O1 on loop.c
loop.ll : loop.c
	$(CC) -O1 -S -emit-llvm $^ -o $@
loop.bc : loop.c
	$(CC) -O1 -c -emit-llvm $^ -o $@

.PHONY: clean
clean:
	find . -name "*.ll" | xargs rm
	find . -name "*.bc" | xargs rm
	find . -name "*~" | xargs rm
