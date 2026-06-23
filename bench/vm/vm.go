// vm.go — a tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
// register program that runs an integer mixing recurrence for many steps. The
// canonical interpreter kernel (the inner loop of every VM, regex engine, and
// scripting runtime): a hot dispatch chain over an opcode plus indirect operand
// fetches from a code array. It stresses branch-chain dispatch and dependent
// loads — a control-flow profile no other case in the suite covers. Pure 32-bit
// integer, so the program output is bit-identical across every engine and native
// target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, if/else
// dispatch (no switch), no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in steps/µs, FNV-1a checksum over
// the per-iteration program results.
package main

import (
	"fmt"
	"time"
)

const (
	steps   = 1 << 14 // inner loop trip count baked into the program
	nInstr  = 8       // instructions in the program
	nIters  = 64      // program runs per kernel pass
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func medianUs(samples []float64) int {
	for i := 1; i < len(samples); i++ {
		v := samples[i]
		j := i - 1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return int(samples[(len(samples)-1)>>1] * 1000)
}

func buildProgram(code []int32) {
	p := []int32{
		0, 0, 0,          // 0 LOADI r0, seed   (b patched per run)
		0, 1, steps,      // 1 LOADI r1, STEPS
		1, 0, 1103515245, // 2 MULI  r0, A
		2, 0, 12345,      // 3 ADDI  r0, C
		3, 0, 16,         // 4 XORSHR r0, 16
		4, 1, 0,          // 5 DEC   r1
		5, 1, 2,          // 6 JNZ   r1, 2
		6, 0, 0,          // 7 HALT
	}
	for i, v := range p {
		code[i] = v
	}
}

func run(code []int32, reg []int32) int32 {
	pc := int32(0)
	for pc < nInstr {
		o := pc * 3
		op, a, b := code[o], code[o+1], code[o+2]
		if op == 0 {
			reg[a] = b
			pc = pc + 1
		} else if op == 1 {
			reg[a] = int32(uint32(reg[a]) * uint32(b))
			pc = pc + 1
		} else if op == 2 {
			reg[a] = reg[a] + b
			pc = pc + 1
		} else if op == 3 {
			reg[a] = reg[a] ^ int32(uint32(reg[a])>>uint32(b))
			pc = pc + 1
		} else if op == 4 {
			reg[a] = reg[a] - 1
			pc = pc + 1
		} else if op == 5 {
			if reg[a] != 0 {
				pc = b
			} else {
				pc = pc + 1
			}
		} else {
			pc = nInstr
		}
	}
	return reg[0]
}

func runKernel(code []int32, reg []int32) uint32 {
	h := uint32(0x811c9dc5)
	for it := int32(0); it < nIters; it++ {
		code[2] = 0x12345678 + it // patch the seed immediate → non-hoistable
		h = mix(h, uint32(run(code, reg)))
	}
	return h
}

func main() {
	code := make([]int32, nInstr*3)
	reg := make([]int32, 4)
	buildProgram(code)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(code, reg)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(code, reg)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, steps*nIters, nInstr, nRuns)
}
