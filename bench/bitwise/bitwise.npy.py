from time import perf_counter
import numpy as np

N = 65_536
N_ROUNDS = 128
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ int(x)) * 0x01000193) & 0xFFFFFFFF


def checksum_u32(out):
    h = 0x811C9DC5
    for i in range(0, len(out), 128):
        h = mix(h, out[i])
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


def init(state):
    s = np.uint32(0x1234ABCD)
    for i in range(N):
        s = np.uint32(s ^ np.uint32(s << np.uint32(13)))
        s = np.uint32(s ^ np.uint32(s >> np.uint32(17)))
        s = np.uint32(s ^ np.uint32(s << np.uint32(5)))
        state[i] = s


def run_kernel(state):
    for _ in range(N_ROUNDS):
        x = state
        x ^= np.left_shift(x, np.uint32(7), dtype=np.uint32)
        x ^= np.right_shift(x, np.uint32(9), dtype=np.uint32)
        x[:] = x * np.uint32(1_103_515_245) + np.uint32(12_345)
        x ^= np.right_shift(x, np.uint32(16), dtype=np.uint32)


def main():
    state = np.zeros(N, dtype=np.uint32)
    init(state)
    for _ in range(N_WARMUP):
        init(state)
        run_kernel(state)
    samples = []
    for _ in range(N_RUNS):
        init(state)
        t0 = perf_counter()
        run_kernel(state)
        samples.append((perf_counter() - t0) * 1000)
    print(f"median_us={median_us(samples)} checksum={checksum_u32(state)} samples={N * N_ROUNDS} stages=3 runs={N_RUNS}")


if __name__ == "__main__":
    main()
