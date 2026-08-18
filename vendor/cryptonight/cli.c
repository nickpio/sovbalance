#include <stdio.h>
#include <stddef.h>
#include "hash-ops.h"

int main(void)
{
  unsigned char input[4096];
  const size_t n = fread(input, 1, sizeof input, stdin);
  char hash[32];

  cn_slow_hash(input, n, hash, 0, 0, 0);

  if (fwrite(hash, 1, 32, stdout) != 32) {
    return 1;
  }

  return 0;
}
