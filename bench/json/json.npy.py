from time import perf_counter
import json

SRC = '{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}'
N_ITERS = 512
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


def walk():
    h = 0x811C9DC5
    for _ in range(N_ITERS):
        o = json.loads(SRC)
        items = o["items"]
        s = o["meta"]["bias"]
        for it in items:
            s += it["id"] * o["meta"]["scale"] + it["kind"] + it["value"]
        h = mix(h, s)
    return h


def main():
    cs = 0
    for _ in range(N_WARMUP):
        cs = walk()

    samples = []
    for _ in range(N_RUNS):
        t0 = perf_counter()
        cs = walk()
        samples.append((perf_counter() - t0) * 1000)

    print(f"median_us={median_us(samples)} checksum={cs} samples={N_ITERS} stages=4 runs={N_RUNS}")


if __name__ == "__main__":
    main()
