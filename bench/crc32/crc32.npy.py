from time import perf_counter
import zlib
import numpy as np

N = 16384
N_ITERS = 220
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


def init_buf():
    buf = np.empty(N, dtype=np.uint8)
    x = 0x12345678
    for i in range(N):
        x = (x * 1103515245 + 12345) & 0xFFFFFFFF
        buf[i] = (x >> 16) & 0xFF
    return buf


def run_kernel(buf):
    h = 0
    for it in range(N_ITERS):
        h = mix(h, zlib.crc32(buf.tobytes()) & 0xFFFFFFFF)
        j = it % N
        buf[j] = (int(buf[j]) + 1) & 0xFF
    return h


def main():
    buf = init_buf()
    cs = 0
    for _ in range(N_WARMUP):
        cs = run_kernel(buf)

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        cs = run_kernel(buf)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={cs} samples={N * N_ITERS} stages=1 runs={N_RUNS}")


if __name__ == "__main__":
    main()
