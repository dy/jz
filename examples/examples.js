// Single source of truth for the example gallery.
//
// Consumed by:
//   · examples/index.html       — the thumbnail grid
//   · examples/lib/jzdemo.js    — chevron order + nicer labels
//   · examples/build.mjs        — `build-all` loops this (incl. SIMD kernels)
//   · ../index.html (landing)   — the hero showcase + teaser grid
//
// Order here IS the gallery order. `kernels` lists extra kernel files to compile
// beyond `<name>.js` (e.g. a SIMD sibling). `show` marks the curated, fast subset
// the landing hero rotates through.

export const examples = [
  { name: 'blackhole',    title: 'Black Hole',        blurb: 'Schwarzschild geodesics, ray-traced — the far disk arcs over the shadow, Doppler-bright on the approaching side' },
  { name: 'nbody',        title: 'N-body',            blurb: '1024-body gravity — pairwise attraction', show: true },
  { name: 'boids',        title: 'Boids',             blurb: 'Reynolds flocking — cohesion, alignment, separation; the cursor is a hawk', show: true },
  { name: 'fireflies',    title: 'Fireflies',         blurb: 'Kuramoto oscillators — neighbour-coupled fireflies lock into traveling waves of synchrony' },
  { name: 'swarm',        title: 'Swarm',             blurb: 'flies that chase and circle the cursor' },
  { name: 'dwa',          title: 'Dynamic Window',    blurb: 'a robot rolls out every reachable velocity and drives the arc that races to the goal while clearing drifting obstacles — local motion planning' },
  { name: 'chladni',      title: 'Chladni',           blurb: 'sand kicked by the local vibration migrates to the nodal lines — the real experiment', show: true },
  { name: 'mandelbrot',   title: 'Mandelbrot',        blurb: 'escape-time fractal — perturbation theory carries the zoom past 10³⁰×' },
  { name: 'julia',        title: 'Julia',             blurb: 'z² + c — click any point to make it c, or let it morph on its own', show: true },
  { name: 'buddhabrot',   title: 'Buddhabrot',        blurb: 'density of Mandelbrot escape orbits — a luminous nebula accumulates' },
  { name: 'burningship',  title: 'Burning Ship',      blurb: 'escape-time on |Re|,|Im| — a galleon ablaze below the Mandelbrot set' },
  { name: 'newton',       title: 'Newton Fractal',    blurb: "Newton's method on z³−1 — basins of attraction meet on a fractal edge" },
  { name: 'lyapunov',     title: 'Lyapunov',          blurb: 'Markus–Lyapunov “zircon” — order in gold, chaos in dark' },
  { name: 'domain-color', title: 'Domain Coloring',   blurb: 'a complex function as an analytic landscape — zeros sink dark, poles flare bright' },
  { name: 'fern',         title: 'Barnsley Fern',     blurb: 'the chaos game on four affine maps grows a fern that sways' },
  { name: 'sph',          title: 'Particle Fluid',    blurb: 'smoothed-particle-style liquid — pairwise repulsion & viscosity, the classic O(N²) sum' },
  { name: 'lbm',          title: 'Lattice-Boltzmann', blurb: 'lattice-Boltzmann flow — a dye filament wraps into the von Kármán vortex street' },
  { name: 'cloth',        title: 'Cloth',             blurb: 'Verlet cloth with shear bracing — grab, twist, and let the wind billow it' },
  { name: 'waves',        title: 'Waves',             blurb: 'the 2D wave equation, nonlinear — drops burst, slow & interfere; crossings glare' },
  { name: 'ocean',        title: 'Ocean',             blurb: 'Tessendorf FFT ocean — a Phillips-spectrum sea synthesized by inverse FFT, moonlit' },
  { name: 'pendulum',     title: 'Double Pendulum',   blurb: 'every pixel an initial angle, shaded by time-to-flip — sensitive chaos' },
  { name: 'magnet',       title: 'Magnetic Pendulum', blurb: 'a damped bob over three magnets — each pixel shaded by which magnet wins; fractal basin boundaries' },
  { name: 'cradle',       title: "Newton's Cradle",   blurb: "Newton's cradle — kinetic energy passing through" },
  { name: 'interference', title: 'Interference',      blurb: 'Huygens diffraction — drag from two sources to an N-slit grating' },
  { name: 'schrodinger',  title: 'Schrödinger',       blurb: 'a quantum wavepacket diffracts through a double slit and tunnels' },
  { name: 'hydrogen',     title: 'Hydrogen Orbitals', blurb: 'the electron clouds of the hydrogen atom — |ψₙₗₘ|² in phase color, morphing s→p→d→f' },
  { name: 'erosion',      title: 'Erosion',           blurb: 'hydraulic erosion — rain carves the terrain; flux pools into a river network' },
  { name: 'plasma',       title: 'Plasma',            blurb: 'FBM domain-warp — the classic flowing plasma', show: true },
  { name: 'lorenz',       title: 'Lorenz',            blurb: 'the butterfly that launched chaos theory — a 1e-5 nudge tears its twin away', show: true },
  { name: 'attractors',   title: 'Attractors',        blurb: 'de Jong map — millions of iters into luminous curves' },
  { name: 'raymarcher',   title: 'Raymarcher',        blurb: 'a soft-shadowed SDF sphere field — Shadertoy on the CPU', kernels: ['raymarcher.simd'], show: true },
  { name: 'metaballs',    title: 'Metaballs',         blurb: 'organic blobs — 2D implicit surface marching', show: true },
  { name: 'voronoi',      title: 'Voronoi',           blurb: 'brute-force nearest-site cells, drifting', show: true },
  { name: 'phyllotaxis',  title: 'Phyllotaxis',       blurb: 'seeds at the golden angle — a hair off 137.5° breaks the sunflower', show: true },
  { name: 'harmonograph', title: 'Harmonograph',      blurb: 'two damped pendulums trace precessing Lissajous figures' },
  { name: 'epicycles',    title: 'Fourier Epicycles', blurb: 'a chain of rotating circles redraws a curve — the DFT made visible' },
  { name: 'bifurcation',  title: 'Bifurcation',       blurb: "the logistic map's period-doubling cascade into chaos" },
  { name: 'times-table',  title: 'Times Tables',      blurb: 'chords i→i·k mod N draw cardioids, nephroids and beyond', show: true },
  { name: 'apollonian',   title: 'Apollonian Gasket', blurb: "Descartes' circle theorem packs circles within circles, forever" },
  { name: 'truchet',      title: 'Truchet Tiles',     blurb: 'two random arc tiles assemble into endless flowing labyrinths' },
  { name: 'penrose',      title: 'Penrose Tiling',    blurb: 'golden-ratio deflation — aperiodic order with five-fold symmetry' },
  { name: 'hyperbolic',   title: 'Hyperbolic Tiling', blurb: "a tessellation of the Poincaré disk — Escher's Circle Limit" },
  { name: 'lsystem',      title: 'L-Systems',         blurb: 'string-rewriting grammars draw Koch, the dragon, and growing plants' },
  { name: 'ulam',         title: 'Ulam Spiral',       blurb: 'primes on a square spiral — diagonals of prime-rich quadratics' },
  { name: 'pascal-sierpinski', title: 'Pascal mod p', blurb: "Pascal's triangle mod p — mod 2 is Sierpiński, primes remix it" },
  { name: 'gauss-primes', title: 'Gaussian Primes',   blurb: 'primes of ℤ[i] in the plane — eightfold-symmetric constellations' },
  { name: 'diffusion',    title: 'Reaction–Diffusion', blurb: 'Gray–Scott — organic coral & labyrinths' },
  { name: 'bz',           title: 'BZ Reaction',       blurb: 'Barkley excitable medium — meandering spiral waves; drag to cut fronts into new spirals' },
  { name: 'game-of-life', title: 'Game of Life',      blurb: "Conway's Life, straight into shared pixel memory" },
  { name: 'sand',         title: 'Falling Sand',      blurb: 'falling-sand automaton — pour sand, water & walls' },
  { name: 'sandpile',     title: 'Sandpile',          blurb: 'Bak–Tang–Wiesenfeld sandpile — avalanches self-organize grains into a fractal mandala' },
  { name: 'lenia',        title: 'Lenia',             blurb: 'continuous cellular automaton — two-species predator/prey “digital life”' },
  { name: 'slime',        title: 'Slime Mold',        blurb: 'Physarum — two rival colonies contest territory with competing transport networks' },
  { name: 'dla',          title: 'DLA',               blurb: 'diffusion-limited aggregation — click to race competing crystals for the walker supply' },
  { name: 'maze',         title: 'Maze',              blurb: 'recursive-backtracker maze, then BFS solve' },
  { name: 'wireworld',    title: 'Wireworld',         blurb: 'a 4-state CA that races electrons along wires' },
  { name: 'rule30',       title: 'Rule 30',           blurb: "Wolfram's elementary CA — one rule, endless aperiodic complexity" },
  { name: 'ising',        title: 'Ising Model',       blurb: 'Metropolis spin flips — domains order & melt through Tc, M(t) charted live' },
  { name: 'percolation',  title: 'Percolation',       blurb: 'occupy sites at probability p — the spanning cluster snaps in at p_c, P∞(p) charted live' },
  { name: 'watercolor',   title: 'Watercolor',        blurb: 'ink on flowing water — a vortical fluid bath; drops bloom, strokes comb' },
  { name: 'marble',       title: 'Marbling',          blurb: 'paper marbling — stacked drops push into concentric stones, combs draw them to swirls' },
  { name: 'dithering',    title: 'Dithering',         blurb: 'one smooth image, four 1-bit dithers — threshold, ordered, Floyd–Steinberg, Atkinson' },
  { name: 'raytrace',     title: 'Raytrace',          blurb: 'per-pixel ray tracing — soft shadows, a mirror sphere, and a refractive glass ball' },
  { name: 'pathtracer',   title: 'Path Tracer',       blurb: 'path-traced Cornell box — soft shadows, glass, color bleeding; converges live from noise' },
]

export default examples

// Lookups + derived views (so consumers never re-declare the list).
export const EXAMPLES = examples.map(e => e.name)
export const byName = Object.fromEntries(examples.map(e => [e.name, e]))

// Curated hero-showcase order — fast (60fps+ full-screen at half-res), dark-background.
// Excludes light-bg examples (swarm/marble) and compute-bound ones the downscale can't help
// (attractors iterates millions of points/frame regardless of resolution). Default = plasma.
export const SHOWCASE = ['nbody', 'plasma', 'raymarcher', 'julia', 'lorenz', 'voronoi', 'boids', 'metaballs', 'phyllotaxis', 'chladni', 'times-table']

// Educational "learn more" link per example — the shared HUD renders it under the hint so
// every demo points at the real mathematics/physics behind it. Wikipedia unless noted.
const W = 'https://en.wikipedia.org/wiki/'
export const WIKI = {
  'blackhole':         W + 'Gravitational_lensing',
  'pathtracer':        W + 'Path_tracing',
  'ocean':             W + 'Wind_wave',
  'fireflies':         W + 'Kuramoto_model',
  'magnet':            W + 'Attractor#Basins_of_attraction',
  'bz':                W + 'Belousov%E2%80%93Zhabotinsky_reaction',
  'sandpile':          W + 'Abelian_sandpile_model',
  'game-of-life':      W + 'Conway%27s_Game_of_Life',
  'wireworld':         W + 'Wireworld',
  'rule30':            W + 'Rule_30',
  'maze':              W + 'Maze_generation_algorithm',
  'sand':              W + 'Falling-sand_game',
  'lenia':             W + 'Lenia',
  'ising':             W + 'Ising_model',
  'percolation':       W + 'Percolation_theory',
  'slime':             W + 'Slime_mold',
  'dla':               W + 'Diffusion-limited_aggregation',
  'diffusion':         W + 'Reaction%E2%80%93diffusion_system',
  'erosion':           W + 'Erosion',
  'watercolor':        W + 'Watercolor_painting',
  'marble':            W + 'Paper_marbling',
  'interference':      W + 'Wave_interference',
  'waves':             W + 'Wave_equation',
  'schrodinger':       W + 'Schr%C3%B6dinger_equation',
  'hydrogen':          W + 'Hydrogen_atom',
  'dithering':         W + 'Dither',
  'plasma':            W + 'Plasma_effect',
  'chladni':           W + 'Cymatics',
  'harmonograph':      W + 'Harmonograph',
  'epicycles':         W + 'Fourier_series',
  'mandelbrot':        W + 'Mandelbrot_set',
  'julia':             W + 'Julia_set',
  'newton':            W + 'Newton_fractal',
  'burningship':       W + 'Burning_Ship_fractal',
  'lyapunov':          W + 'Lyapunov_fractal',
  'buddhabrot':        W + 'Buddhabrot',
  'domain-color':      W + 'Domain_coloring',
  'attractors':        W + 'Attractor',
  'lorenz':            W + 'Lorenz_system',
  'bifurcation':       W + 'Logistic_map',
  'pendulum':          W + 'Double_pendulum',
  'times-table':       W + 'Cardioid',
  'ulam':              W + 'Ulam_spiral',
  'pascal-sierpinski': W + 'Sierpi%C5%84ski_triangle',
  'gauss-primes':      W + 'Gaussian_integer',
  'phyllotaxis':       W + 'Phyllotaxis',
  'fern':              W + 'Barnsley_fern',
  'lsystem':           W + 'L-system',
  'voronoi':           W + 'Voronoi_diagram',
  'apollonian':        W + 'Apollonian_gasket',
  'truchet':           W + 'Truchet_tiles',
  'penrose':           W + 'Penrose_tiling',
  'hyperbolic':        W + 'Poincar%C3%A9_disk_model',
  'raymarcher':        W + 'Ray_marching',
  'metaballs':         W + 'Metaballs',
  'nbody':             W + 'N-body_simulation',
  'boids':             W + 'Boids',
  'swarm':             W + 'Swarm_behaviour',
  'dwa':               W + 'Dynamic_window_approach',
  'cloth':             W + 'Cloth_modeling',
  'cradle':            W + 'Newton%27s_cradle',
  'sph':               W + 'Smoothed-particle_hydrodynamics',
  'lbm':               W + 'Lattice_Boltzmann_methods',
  'raytrace':          W + 'Ray_tracing_(graphics)',
}
