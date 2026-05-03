from time import perf_counter
import numpy as np

BASE = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"
N_REPEAT = 512
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


def make_source():
    return BASE * N_REPEAT


def scan(src):
    h = 0x811C9DC5
    number = 0
    in_number = False
    in_ident = False
    tokens = 0
    for c in src:
        o = ord(c)
        if 48 <= o <= 57:
            number = ((number * 10) + (o - 48)) & 0xFFFFFFFF
            in_number = True
        else:
            if in_number:
                h = mix(h, number)
                tokens += 1
                number = 0
                in_number = False
            if (65 <= o <= 90) or (97 <= o <= 122) or o == 95:
                if not in_ident:
                    h = mix(h, o)
                    tokens += 1
                in_ident = True
            else:
                if o > 32:
                    h = mix(h, o)
                    tokens += 1
                in_ident = False
    if in_number:
        h = mix(h, number)
        tokens += 1
    return mix(h, tokens)


def main():
    src = make_source()
    cs = 0
    for _ in range(N_WARMUP):
        cs = scan(src)

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        cs = scan(src)
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={cs} samples={len(src)} stages=5 runs={N_RUNS}")


if __name__ == "__main__":
    main()
