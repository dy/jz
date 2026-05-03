from time import perf_counter
import numpy as np

N = 8192
N_ITERS = 80
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ (x & 0xFFFFFFFF)) * 0x01000193) & 0xFFFFFFFF


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


def init(f64, i32):
    for i in range(N):
        f64[i] = (i % 251) * 0.25
        i32[i] = (i * 17) & 1023


def run_kernel(f64, i32):
    h = 0x811C9DC5
    for _ in range(N_ITERS):
        a = int(np.sum(f64))
        b = int(np.sum(i32))
        h = mix(h, a)
        h = mix(h, b)
    return h


def main():
    f64 = np.empty(N, dtype=np.float64)
    i32 = np.empty(N, dtype=np.int32)
    init(f64, i32)

    cs = 0
    for _ in range(N_WARMUP):
        cs = run_kernel(f64, i32)

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        cs = run_kernel(f64, i32)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={cs} samples={N * N_ITERS * 2} stages=2 runs={N_RUNS}")


if __name__ == "__main__":
    main()
