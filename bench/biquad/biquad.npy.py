from time import perf_counter
import numpy as np

N_SAMPLES = 480_000
N_STAGES = 8
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ (x & 0xFFFFFFFF)) * 0x01000193) & 0xFFFFFFFF


def checksum_f64(out):
    u = out.view(np.uint32)
    h = 0x811C9DC5
    for i in range(0, len(u), 256):
        h = mix(h, int(u[i]))
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


def mk_input(n):
    out = np.empty(n, dtype=np.float64)
    s = np.uint32(0x1234ABCD)
    for i in range(n):
        s = np.uint32(s ^ np.uint32(s << np.uint32(13)))
        s = np.uint32(s ^ np.uint32(s >> np.uint32(17)))
        s = np.uint32(s ^ np.uint32(s << np.uint32(5)))
        out[i] = (int(s) / 4294967296) * 2 - 1
    return out


def mk_coeffs(n):
    out = np.empty(n * 5, dtype=np.float64)
    for i in range(n):
        out[i * 5 + 0] = 0.10 + i * 0.001
        out[i * 5 + 1] = 0.20 - i * 0.0005
        out[i * 5 + 2] = 0.10
        out[i * 5 + 3] = -1.50 + i * 0.01
        out[i * 5 + 4] = 0.60 - i * 0.005
    return out


def process_cascade(x, coeffs, state, n_stages, out):
    n = len(x)
    for i in range(n):
        v = x[i]
        for s in range(n_stages):
            c = s * 5
            sb = s * 4
            b0 = coeffs[c + 0]
            b1 = coeffs[c + 1]
            b2 = coeffs[c + 2]
            a1 = coeffs[c + 3]
            a2 = coeffs[c + 4]
            x1 = state[sb + 0]
            x2 = state[sb + 1]
            y1 = state[sb + 2]
            y2 = state[sb + 3]
            y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            state[sb + 0] = v
            state[sb + 1] = x1
            state[sb + 2] = y
            state[sb + 3] = y1
            v = y
        out[i] = v


def main():
    x = mk_input(N_SAMPLES)
    coeffs = mk_coeffs(N_STAGES)
    state = np.zeros(N_STAGES * 4, dtype=np.float64)
    out = np.zeros(N_SAMPLES, dtype=np.float64)

    for _ in range(N_WARMUP):
        state[:] = 0
        process_cascade(x, coeffs, state, N_STAGES, out)

    samples = []
    for _ in range(N_RUNS):
        state[:] = 0
        t0 = perf_counter()
        process_cascade(x, coeffs, state, N_STAGES, out)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={checksum_f64(out)} samples={N_SAMPLES} stages={N_STAGES} runs={N_RUNS}")


if __name__ == "__main__":
    main()
