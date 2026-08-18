#include <stddef.h>
#include <stdint.h>

struct V4_Instruction;

typedef void (*v4_random_math_JIT_func)(uint32_t *r)
#if defined __i386 || defined __x86_64__
__attribute__((sysv_abi))
#endif
;

int v4_generate_JIT_code(const struct V4_Instruction *code, v4_random_math_JIT_func buf, const size_t buf_size)
{
  (void)code;
  (void)buf;
  (void)buf_size;
  return -1;
}
