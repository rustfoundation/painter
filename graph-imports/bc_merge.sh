#!/bin/bash
BC_ROOT=$1

TMP_MERGED=/tmp/merged.csv

size=$({ find $BC_ROOT -type f -name 'calls.csv' -printf '%s+'; echo 0;} | bc)
fallocate -l "$size" $TMP_MERGED &&
  find $BC_ROOT  -type f -name 'calls.csv' -print0 |
  xargs -r0 cat 1<> $TMP_MERGED
