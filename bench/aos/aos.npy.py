from time import perf_counter
import numpy as np

N = 16_384
N_ITERS = 64
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


def run_kernel(x, y, z, xs, ys, zs):
    for r in range(N_ITERS):
        xs[:] = x + y * 0.25 + r
        ys[:] = y - z * 0.5
        zs[:] = z + x * 0.125


def main():
    i = np.arange(N, dtype=np.float64)
    x = i * 0.5
    y = i + 1.0
    z = (np.arange(N, dtype=np.int32) & 7).astype(np.float64) - 3.0
    xs = np.zeros(N, dtype=np.float64)
    ys = np.zeros(N, dtype=np.float64)
    zs = np.zeros(N, dtype=np.float64)
    for _ in range(N_WARMUP):
        run_kernel(x, y, z, xs, ys, zs)
    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        run_kernel(x, y, z, xs, ys, zs)
        samples.append((perf_counter() - t0) * 1000)
    cs = checksum_f64(xs) ^ checksum_f64(ys) ^ checksum_f64(zs)
    print(f"median_us={median_us(samples)} checksum={cs} samples={N * N_ITERS} stages=3 runs={N_RUNS}")


if __name__ == "__main__":
    main()
