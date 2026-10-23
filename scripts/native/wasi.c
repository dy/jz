/*
 * WASI Preview 1 for a jz program translated by `wasm2c -n jz` (symbols w2c_jz_*,
 * header jz.h on the include path). Not a general WASI runtime: it implements
 * exactly the imports jz's `--host wasi` lowerings emit:
 *
 *   fd_read, fd_write        stdin/stdout/stderr and files (fs.readSync/writeSync,
 *                            readStdin, console.*): readv/writev, partial counts
 *                            returned as is, 0 at EOF
 *   path_open, fd_close,     fs.read/fs.write against the first preopen, fd 3,
 *   fd_filestat_get          which is the current directory
 *   clock_time_get           Date.now, performance.now, timers
 *   random_get               Math.random seeding, crypto.getRandomValues
 *
 * Failures return the WASI errno (wasi-libc wasi/wasip1.h numbering); jz turns
 * it into a thrown number. Shared by scripts/native/compile.mjs and the bench's
 * jz-w2c lane.
 *
 * Entry, chosen from the module's exports by the builder: JZ_WASI when it
 * imports wasi_snapshot_preview1, then `_initialize` (JZ_INITIALIZE, idempotent
 * module init), `_start` (JZ_START) and `main` (JZ_MAIN, the bench's entry), in
 * that order. A trap prints its reason and exits with 134, as wasmtime does.
 */

#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE 1  /* glibc: POSIX.1-2008 and getentropy under -std=c11 too */
#endif
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#include "wasm-rt.h"
#include "wasm-rt-exceptions.h"
#include "wasm-rt-impl.h"
#include "jz.h"

#if !defined(__BYTE_ORDER__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "wasi.c reads wasm memory in place and needs a little-endian host"
#endif

struct w2c_wasi__snapshot__preview1 { wasm_rt_memory_t* mem; };
typedef struct w2c_wasi__snapshot__preview1 wasi_t;

enum {
  E_SUCCESS = 0, E_2BIG = 1, E_ACCES = 2, E_AGAIN = 6, E_BADF = 8, E_EXIST = 20,
  E_FAULT = 21, E_FBIG = 22, E_INTR = 27, E_INVAL = 28, E_IO = 29, E_ISDIR = 31,
  E_LOOP = 32, E_MFILE = 33, E_NAMETOOLONG = 37, E_NFILE = 41, E_NOENT = 44,
  E_NOMEM = 48, E_NOSPC = 51, E_NOSYS = 52, E_NOTDIR = 54, E_NOTEMPTY = 55,
  E_NOTSUP = 58, E_NXIO = 60, E_PERM = 63, E_PIPE = 64, E_ROFS = 69,
  E_SPIPE = 70, E_TXTBSY = 74,
};

static u32 errno_wasi(int e) {
  switch (e) {
    case E2BIG: return E_2BIG;
    case EACCES: return E_ACCES;
    case EAGAIN: return E_AGAIN;
    case EBADF: return E_BADF;
    case EEXIST: return E_EXIST;
    case EFAULT: return E_FAULT;
    case EFBIG: return E_FBIG;
    case EINTR: return E_INTR;
    case EINVAL: return E_INVAL;
    case EISDIR: return E_ISDIR;
    case ELOOP: return E_LOOP;
    case EMFILE: return E_MFILE;
    case ENAMETOOLONG: return E_NAMETOOLONG;
    case ENFILE: return E_NFILE;
    case ENOENT: return E_NOENT;
    case ENOMEM: return E_NOMEM;
    case ENOSPC: return E_NOSPC;
    case ENOSYS: return E_NOSYS;
    case ENOTDIR: return E_NOTDIR;
    case ENOTEMPTY: return E_NOTEMPTY;
    case ENOTSUP: return E_NOTSUP;
    case ENXIO: return E_NXIO;
    case EPERM: return E_PERM;
    case EPIPE: return E_PIPE;
    case EROFS: return E_ROFS;
    case ESPIPE: return E_SPIPE;
    case ETXTBSY: return E_TXTBSY;
    default: return E_IO;
  }
}

/* [ptr, ptr+len) of linear memory, or NULL when it runs past the end. */
static u8* span(wasi_t* w, u32 ptr, u64 len) {
  return (u64)ptr + len <= w->mem->size ? w->mem->data + ptr : NULL;
}

static u32 load_u32(const u8* p) { u32 v; memcpy(&v, p, 4); return v; }
static void store_u32(u8* p, u32 v) { memcpy(p, &v, 4); }
static void store_u64(u8* p, u64 v) { memcpy(p, &v, 8); }

/* Gather a wasm iovec array into host iovecs; *out is malloc'd when large. */
static u32 iovecs(wasi_t* w, u32 iovs, u32 n, struct iovec* small, struct iovec** out) {
  const u8* list = span(w, iovs, (u64)n * 8);
  if (!list) return E_FAULT;
  struct iovec* v = small;
  if (n > 16 && !(v = malloc(n * sizeof *v))) return E_NOMEM;
  for (u32 i = 0; i < n; i++) {
    u32 len = load_u32(list + i * 8 + 4);
    u8* buf = span(w, load_u32(list + i * 8), len);
    if (!buf) { if (v != small) free(v); return E_FAULT; }
    v[i].iov_base = buf;
    v[i].iov_len = len;
  }
  *out = v;
  return E_SUCCESS;
}

/* After EAGAIN, wait until fd is ready: a descriptor another process left
 * non-blocking still blocks, as a WASI descriptor without FDFLAGS_NONBLOCK does. */
static int ready(int fd, int out) {
  if (errno != EAGAIN && errno != EWOULDBLOCK) return 0;
  struct pollfd p = { fd, out ? POLLOUT : POLLIN, 0 };
  return poll(&p, 1, -1) >= 0 || errno == EINTR;
}

/* One readv/writev: a blocking call that may move fewer bytes than asked. */
static u32 rw(wasi_t* w, int out, u32 fd, u32 iovs, u32 n, u32 count_ptr) {
  u8* count = span(w, count_ptr, 4);
  if (!count) return E_FAULT;
  struct iovec small[16], *v;
  u32 e = iovecs(w, iovs, n, small, &v);
  if (e) return e;
  ssize_t r;
  do r = out ? writev((int)fd, v, (int)n) : readv((int)fd, v, (int)n);
  while (r < 0 && (errno == EINTR || ready((int)fd, out)));
  int err = errno;
  if (v != small) free(v);
  if (r < 0) return errno_wasi(err);
  store_u32(count, (u32)r);
  return E_SUCCESS;
}

u32 w2c_wasi__snapshot__preview1_fd_read(wasi_t* w, u32 fd, u32 iovs, u32 n, u32 nread) {
  return rw(w, 0, fd, iovs, n, nread);
}

u32 w2c_wasi__snapshot__preview1_fd_write(wasi_t* w, u32 fd, u32 iovs, u32 n, u32 nwritten) {
  return rw(w, 1, fd, iovs, n, nwritten);
}

u32 w2c_wasi__snapshot__preview1_fd_close(wasi_t* w, u32 fd) {
  (void)w;
  return close((int)fd) ? errno_wasi(errno) : E_SUCCESS;
}

static u64 ns(struct timespec t) { return (u64)t.tv_sec * 1000000000u + (u64)t.tv_nsec; }

u32 w2c_wasi__snapshot__preview1_fd_filestat_get(wasi_t* w, u32 fd, u32 out) {
  u8* p = span(w, out, 64);
  if (!p) return E_FAULT;
  struct stat s;
  if (fstat((int)fd, &s)) return errno_wasi(errno);
  u8 type = S_ISREG(s.st_mode) ? 4 : S_ISDIR(s.st_mode) ? 3 : S_ISCHR(s.st_mode) ? 2
    : S_ISBLK(s.st_mode) ? 1 : S_ISLNK(s.st_mode) ? 7 : S_ISSOCK(s.st_mode) ? 6 : 0;
  memset(p, 0, 64);
  store_u64(p, (u64)s.st_dev);
  store_u64(p + 8, (u64)s.st_ino);
  p[16] = type;
  store_u64(p + 24, (u64)s.st_nlink);
  store_u64(p + 32, (u64)s.st_size);
#ifdef __APPLE__
  store_u64(p + 40, ns(s.st_atimespec));
  store_u64(p + 48, ns(s.st_mtimespec));
  store_u64(p + 56, ns(s.st_ctimespec));
#else
  store_u64(p + 40, ns(s.st_atim));
  store_u64(p + 48, ns(s.st_mtim));
  store_u64(p + 56, ns(s.st_ctim));
#endif
  return E_SUCCESS;
}

/* rights: FD_READ 1<<1, FD_WRITE 1<<6; oflags: CREAT 1, DIRECTORY 2, EXCL 4,
 * TRUNC 8; fdflags: APPEND 1, DSYNC 2, NONBLOCK 4, SYNC 16 (RSYNC 8 has no
 * macOS flag and is ignored); lookupflags: SYMLINK_FOLLOW 1. */
u32 w2c_wasi__snapshot__preview1_path_open(wasi_t* w, u32 dirfd, u32 lookup, u32 path, u32 path_len,
                                           u32 oflags, u64 rights, u64 inheriting, u32 fdflags, u32 fd_out) {
  (void)inheriting;
  u8* name = span(w, path, path_len);
  u8* out = span(w, fd_out, 4);
  if (!name || !out) return E_FAULT;
  char* p = malloc((size_t)path_len + 1);
  if (!p) return E_NOMEM;
  memcpy(p, name, path_len);
  p[path_len] = 0;
  int r = rights & (1u << 1), wr = rights & (1u << 6);
  int flags = (r && wr ? O_RDWR : wr ? O_WRONLY : O_RDONLY) | O_CLOEXEC
    | (oflags & 1 ? O_CREAT : 0) | (oflags & 2 ? O_DIRECTORY : 0) | (oflags & 4 ? O_EXCL : 0)
    | (oflags & 8 ? O_TRUNC : 0) | (fdflags & 1 ? O_APPEND : 0) | (fdflags & 2 ? O_DSYNC : 0)
    | (fdflags & 4 ? O_NONBLOCK : 0) | (fdflags & 16 ? O_SYNC : 0) | (lookup & 1 ? 0 : O_NOFOLLOW);
  int fd;
  do fd = openat((int)dirfd, p, flags, 0666);
  while (fd < 0 && errno == EINTR);
  int err = errno;
  free(p);
  if (fd < 0) return errno_wasi(err);
  store_u32(out, (u32)fd);
  return E_SUCCESS;
}

u32 w2c_wasi__snapshot__preview1_clock_time_get(wasi_t* w, u32 id, u64 precision, u32 out) {
  (void)precision;
  u8* p = span(w, out, 8);
  if (!p) return E_FAULT;
  static const clockid_t ids[] = { CLOCK_REALTIME, CLOCK_MONOTONIC, CLOCK_PROCESS_CPUTIME_ID, CLOCK_THREAD_CPUTIME_ID };
  if (id >= sizeof ids / sizeof *ids) return E_INVAL;
  struct timespec t;
  if (clock_gettime(ids[id], &t)) return errno_wasi(errno);
  store_u64(p, ns(t));
  return E_SUCCESS;
}

u32 w2c_wasi__snapshot__preview1_random_get(wasi_t* w, u32 buf, u32 len) {
  u8* p = span(w, buf, len);
  if (!p) return E_FAULT;
  for (u32 off = 0; off < len; off += 256) {  /* getentropy's per-call limit */
    u32 n = len - off < 256 ? len - off : 256;
    if (getentropy(p + off, n)) return errno_wasi(errno);
  }
  return E_SUCCESS;
}

int main(void) {
  /* A closed reader gives EPIPE to the program rather than killing the process. */
  signal(SIGPIPE, SIG_IGN);
  /* fd 3 is the first preopen in WASI: the current directory, as `wasmtime --dir .`
   * would map it. Holding it also keeps opened files from landing on 3. */
  int dir = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dir >= 0 && dir != 3) { dup2(dir, 3); close(dir); }

  wasm_rt_init();
  /* On the stack, not static: under LTO a global instance lets every byte store
   * into linear memory alias its fields, which cost the bench's tokenizer 3.4x. */
  w2c_jz inst;
  wasm_rt_trap_t trap = wasm_rt_impl_try();
  if (trap) {
    fprintf(stderr, "wasm trap: %s\n", wasm_rt_strerror(trap));
    return 134;
  }
#ifdef JZ_WASI
  wasi_t wasi = { w2c_jz_memory(&inst) };
  wasm2c_jz_instantiate(&inst, &wasi);
#else
  wasm2c_jz_instantiate(&inst);
#endif
#ifdef JZ_INITIALIZE
  w2c_jz_0x5Finitialize(&inst);
#endif
#ifdef JZ_START
  w2c_jz_0x5Fstart(&inst);
#endif
#ifdef JZ_MAIN
  w2c_jz_main(&inst);
#endif
  wasm2c_jz_free(&inst);
  wasm_rt_free();
  return 0;
}
