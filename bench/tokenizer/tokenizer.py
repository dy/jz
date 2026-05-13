from time import perf_counter

BASE = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"
N_REPEAT = 512
N_RUNS = 21
N_WARMUP = 5


def mix(h, x):
    return ((h ^ (x & 0xFFFFFFFF)) * 0x01000193) & 0xFFFFFFFF


def median_us(samples):
    sorted_samples = samples[:]
    for i in range(1, len(sorted_samples)):
        v = sorted_samples[i]
        j = i - 1
        while j >= 0 and sorted_samples[j] > v:
            sorted_samples[j + 1] = sorted_samples[j]
            j -= 1
        sorted_samples[j + 1] = v
    return int(sorted_samples[(len(sorted_samples) - 1) >> 1] * 1000)


def is_alpha(c):
    return (65 <= c <= 90) or (97 <= c <= 122) or c == 95


def scan(src):
    h = 0x811C9DC5
    number = 0
    in_number = False
    in_ident = False
    tokens = 0
    for c in src:
        if 48 <= c <= 57:
            number = ((number * 10) + (c - 48)) & 0xFFFFFFFF
            in_number = True
        else:
            if in_number:
                h = mix(h, number)
                tokens += 1
                number = 0
                in_number = False
            if is_alpha(c):
                if not in_ident:
                    h = mix(h, c)
                    tokens += 1
                in_ident = True
            else:
                if c > 32:
                    h = mix(h, c)
                    tokens += 1
                in_ident = False
    if in_number:
        h = mix(h, number)
        tokens += 1
    return mix(h, tokens)


def main():
    src = (BASE * N_REPEAT).encode("ascii")
    # Each run scans a slightly shorter prefix so `scan` gets a different input
    # every call — it can't be hoisted out of the timing loop (matches the .js).
    cs = 0
    for i in range(N_WARMUP):
        cs = scan(src[: len(src) - (i & 7)])
    samples = []
    for i in range(N_RUNS):
        t0 = perf_counter()
        cs = scan(src[: len(src) - (i & 7)])
        samples.append((perf_counter() - t0) * 1000)
    print(f"median_us={median_us(samples)} checksum={cs} samples={len(src)} stages=5 runs={N_RUNS}")


if __name__ == "__main__":
    main()
