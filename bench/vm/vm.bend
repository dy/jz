import Base
import ../_lib/bench.bend as B
# vm.bend: Bend port of vm.js (same program, seed patching, runs and
# checksum): a register-machine interpreter over a flat program of [op, a, b]
# cells, dispatching on the opcode read each step. The opcode becomes a Nat
# to match on. Each step answers the machine and its loop test (pc < NINSTR);
# Bend checks that the loop ends, so it carries a Nat fuel of 2^32 - 1 steps,
# beyond the 81,923 the program takes.

type Vm is Type:
  Vm{code: Array<U32>, reg: Array<U32>, pc: U32}

def steps() -> U32:
  16384

def ninstr() -> U32:
  8

# LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6
def program() -> List<&2, U32>:
  [0, 0, 0, 0, 1, steps(), 1, 0, 1103515245, 2, 0, 12345, 3, 0, 16, 4, 1, 0,
   5, 1, 2, 6, 0, 0]

def load(xs: List<&2, U32>, +i: U32, a: Array<U32>) -> Array<U32>:
  match xs:
    case Nil{}:
      a
    case x <> t:
      load(t, (i + 1 : U32), a[i] <- x)

def muli(+a: U32, b: U32, +pc: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm:
  (reg, x) = r
  Vm{code, reg[a] <- (x * b : U32), (pc + 1 : U32)}

def addi(+a: U32, b: U32, +pc: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm:
  (reg, x) = r
  Vm{code, reg[a] <- (x + b : U32), (pc + 1 : U32)}

def xorshr(+a: U32, b: U32, +pc: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm:
  (reg, +x) = r
  Vm{code, reg[a] <- (x .^. (x >> U32.to_nat(b)) : U32), (pc + 1 : U32)}

def dec(+a: U32, +pc: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm:
  (reg, x) = r
  Vm{code, reg[a] <- (x - 1 : U32), (pc + 1 : U32)}

def jnz.pc(nz: Bool, b: U32, +pc: U32) -> U32:
  match nz:
    case True{}:
      b
    case False{}:
      (pc + 1 : U32)

def jnz(b: U32, +pc: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm:
  (reg, x) = r
  Vm{code, reg, jnz.pc(U32.is_ne(x, 0), b, pc)}

def exec(op: Nat, +a: U32, +b: U32, +pc: U32, code: Array<U32>, reg: Array<U32>) -> Vm:
  match op:
    case 0n:
      Vm{code, reg[a] <- b, (pc + 1 : U32)}
    case 1n:
      muli(a, b, pc, code, reg[a])
    case 2n:
      addi(a, b, pc, code, reg[a])
    case 3n:
      xorshr(a, b, pc, code, reg[a])
    case 4n:
      dec(a, pc, code, reg[a])
    case 5n:
      jnz(b, pc, code, reg[a])
    case 6n+q:
      Vm{code, reg, ninstr()}

# o = pc * 3; op = code[o], a = code[o + 1], b = code[o + 2]
def fetch.f3(+op: U32, +a: U32, +pc: U32, reg: Array<U32>, r: Array<U32> & U32) -> Vm:
  (code, b) = r
  exec(U32.to_nat(op), a, b, pc, code, reg)

def fetch.f2(+op: U32, +pc: U32, reg: Array<U32>, r: Array<U32> & U32) -> Vm:
  (code, a) = r
  fetch.f3(op, a, pc, reg, code[(pc * 3 + 2 : U32)])

def fetch.f1(+pc: U32, reg: Array<U32>, r: Array<U32> & U32) -> Vm:
  (code, op) = r
  fetch.f2(op, pc, reg, code[(pc * 3 + 1 : U32)])

def test(s: Vm) -> Vm & Bool:
  Vm{code, reg, +pc} = s
  (Vm{code, reg, pc}, (pc < ninstr() : U32))

def step(s: Vm) -> Vm & Bool:
  Vm{code, reg, +pc} = s
  test(fetch.f1(pc, reg, code[(pc * 3 : U32)]))

def run(f: Nat, r: Vm & Bool) -> Vm:
  match f:
    case 0n:
      (s, go) = r
      s
    case 1n+p:
      (s, go) = r
      match go:
        case False{}:
          s
        case True{}:
          run(p, step(s))

# run(code, reg): reg[0] once the program halts
def result(h: U32, code: Array<U32>, r: Array<U32> & U32) -> Vm & U32:
  (reg, x) = r
  (Vm{code, reg, 0}, B.mix(h, x))

def halt(h: U32, s: Vm) -> Vm & U32:
  Vm{code, reg, pc} = s
  result(h, code, reg[0])

# code[2] = 0x12345678 + it; h = mix(h, run(code, reg))
def pass(+it: U32, r: Vm & U32) -> Vm & U32:
  (s, h) = r
  Vm{code, reg, pc} = s
  halt(h, run(U32.to_nat(4294967295), (Vm{code[2] <- (305419896 + it : U32), reg, 0}, True{})))

def run_kernel(k: Nat, +it: U32, r: Vm & U32) -> Vm & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Vm & U32) -> Vm & U32:
  (s, h) = r
  run_kernel(64n, 0, (s, 2166136261))

def checksum(r: Vm & U32) -> U32:
  (s, h) = r
  h

def main() -> IO(Unit):
  s = B.warm(~Vm & U32, ~(r => r), ~kernel, 5n,
    (Vm{load(program(), 0, [0 : U32*32n]), [0 : U32*4n], 0}, 0))
  do IO<Unit>:
    r : (Vm & U32) & List<&2, U32> <- B.timed(~Vm & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Vm & U32, ~checksum, (steps() * 64 : U32), 8, 21, r)
