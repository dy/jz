from time import perf_counter
import numpy as np

N = 4096
N_ITERS = 128
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


def init():
    return np.array([(i % 97) - 48 for i in range(N)], dtype=np.float64)


def run_kernel(a):
    h = 0x811C9DC5
    for i in range(N_ITERS):
        b = a * 2.0 + float(i)
        for j in range(0, N, 64):
            h = mix(h, int(b[j]))
    return h


def main():
    a = init()

    cs = 0
    for _ in range(N_WARMUP):
        cs = run_kernel(a)

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        cs = run_kernel(a)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={cs} samples={N * N_ITERS} stages=1 runs={N_RUNS}")


if __name__ == "__main__":
    main()
