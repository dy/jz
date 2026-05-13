from time import perf_counter
import numpy as np

N = 8192
N_ITERS = 24
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ int(x)) * 0x01000193) & 0xFFFFFFFF


def median_us(samples):
    a = list(samples)
    for i in range(1, len(a)):
        v = a[i]
        j = i - 1
        while j >= 0 and a[j] > v:
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = v
    return int(a[(len(a) - 1) >> 1] * 1000)


def checksum_f64(xs):
    words = xs.view(np.uint32)
    h = 0x811C9DC5
    for i in range(0, len(words), 256):
        h = mix(h, int(words[i]))
    return h


def fill():
    out = np.empty(N, dtype=np.float64)
    s = 0x9E3779B9
    for i in range(N):
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        s &= 0xFFFFFFFF
        out[i] = s / 4294967296.0
    return out


def run_kernel(src):
    a = None
    for it in range(N_ITERS):
        a = np.sort(src + it)
    return a


def main():
    src = fill()
    a = None
    for _ in range(N_WARMUP):
        a = run_kernel(src)

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        a = run_kernel(src)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={checksum_f64(a)} samples={N * N_ITERS} stages=2 runs={N_RUNS}")


if __name__ == "__main__":
    main()
