from time import perf_counter
import numpy as np

N_ITERS = 200_000
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ int(x)) * 0x01000193) & 0xFFFFFFFF


def checksum_f64(out):
    u = out.view(np.uint32)
    h = 0x811C9DC5
    for i in range(0, len(u), 256):
        h = mix(h, u[i])
    return h


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


def init(a, b):
    a[:] = (np.arange(16, dtype=np.float64) + 1.0) * 0.125
    b[:] = (16.0 - np.arange(16, dtype=np.float64)) * 0.0625


def multiply_many(a, b, out):
    am = a.reshape(4, 4)
    bm = b.reshape(4, 4)
    om = out.reshape(4, 4)
    for n in range(N_ITERS):
        om[:] = am @ bm
        out[:] += n * 0.0000001
        t = a[0]
        a[0] = out[15]
        a[5] = t + out[10] * 0.000001


def main():
    a = np.zeros(16, dtype=np.float64)
    b = np.zeros(16, dtype=np.float64)
    out = np.zeros(16, dtype=np.float64)
    init(a, b)
    for _ in range(N_WARMUP):
        multiply_many(a, b, out)
    samples = []
    for _ in range(N_RUNS):
        init(a, b)
        t0 = perf_counter()
        multiply_many(a, b, out)
        samples.append((perf_counter() - t0) * 1000)
    print(f"median_us={median_us(samples)} checksum={checksum_f64(out)} samples={N_ITERS * 16} stages=4 runs={N_RUNS}")


if __name__ == "__main__":
    main()
