#!/bin/bash
BC_ROOT=$1

TMP_MERGED=$2

size=$({ find $BC_ROOT -type f -name 'calls.csv' -printf '%s+'; echo 0;} | bc)
fallocate -l "$size" $TMP_MERGED &&
  find $BC_ROOT  -type f -name 'calls.csv' -print0 |
  xargs -r0 cat 1<> $TMP_MERGED

nl -w2 -s',' $TMP_MERGED > $TMP_MERGED.lined
mv $TMP_MERGED.lined $TMP_MERGED
sed -i 's/^/i/' $TMP_MERGED
