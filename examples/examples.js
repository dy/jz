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
  { name: 'game-of-life', title: 'Game of Life',      blurb: "Conway's Life, straight into shared pixel memory" },
  { name: 'wireworld',    title: 'Wireworld',         blurb: 'a 4-state CA that races electrons along wires' },
  { name: 'rule30',       title: 'Rule 30',           blurb: "Wolfram's elementary CA — one rule, endless aperiodic complexity" },
  { name: 'maze',         title: 'Maze',              blurb: 'recursive-backtracker maze, then BFS solve' },
  { name: 'sand',         title: 'Falling Sand',      blurb: 'falling-sand automaton — pour sand, water & walls' },
  { name: 'lenia',        title: 'Lenia',             blurb: 'continuous cellular automaton — smooth-kernel “digital life”' },
  { name: 'ising',        title: 'Ising Model',       blurb: 'Metropolis spin flips — magnetic domains order & melt through Tc' },
  { name: 'percolation',  title: 'Percolation',       blurb: 'occupy sites at probability p — a spanning cluster snaps in at p_c' },
  { name: 'slime',        title: 'Slime Mold',        blurb: 'Physarum slime mold — agents grow transport networks' },
  { name: 'dla',          title: 'DLA',               blurb: 'diffusion-limited aggregation — a random-walk crystal' },
  { name: 'diffusion',    title: 'Reaction–Diffusion', blurb: 'Gray–Scott — organic coral & labyrinths' },
  { name: 'watercolor',   title: 'Watercolor',        blurb: 'wet-paper pigment diffusion with edge darkening' },
  { name: 'marble',       title: 'Marbling',          blurb: 'paper marbling — drop ink, comb it into swirls' },
  { name: 'interference', title: 'Interference',      blurb: 'two-source wave field, recomputed every frame' },
  { name: 'waves',        title: 'Waves',             blurb: '2D wave equation — ripples that interfere & reflect' },
  { name: 'schrodinger',  title: 'Schrödinger',       blurb: 'a quantum wavepacket diffracts through a double slit and tunnels' },
  { name: 'erosion',      title: 'Erosion',           blurb: 'hydraulic erosion — rain carves a fractal terrain' },
  { name: 'plasma',       title: 'Plasma',            blurb: 'FBM domain-warp — the classic flowing plasma', show: true },
  { name: 'chladni',      title: 'Chladni',           blurb: 'Camerata plate — frequency sweeps the nodal figure', show: true },
  { name: 'harmonograph', title: 'Harmonograph',      blurb: 'two damped pendulums trace precessing Lissajous figures' },
  { name: 'epicycles',    title: 'Fourier Epicycles', blurb: 'a chain of rotating circles redraws a curve — the DFT made visible' },
  { name: 'mandelbrot',   title: 'Mandelbrot',        blurb: 'escape-time fractal with smooth coloring' },
  { name: 'julia',        title: 'Julia',             blurb: 'z² + c — a fractal that morphs as you steer c', show: true },
  { name: 'newton',       title: 'Newton Fractal',    blurb: "Newton's method on z³−1 — basins of attraction meet on a fractal edge" },
  { name: 'burningship',  title: 'Burning Ship',      blurb: 'escape-time on |Re|,|Im| — a galleon ablaze below the Mandelbrot set' },
  { name: 'lyapunov',     title: 'Lyapunov',          blurb: 'Markus–Lyapunov “zircon” — order in gold, chaos in dark' },
  { name: 'buddhabrot',   title: 'Buddhabrot',        blurb: 'density of Mandelbrot escape orbits — a luminous nebula accumulates' },
  { name: 'domain-color', title: 'Domain Coloring',   blurb: 'a complex function as an analytic landscape — zeros sink dark, poles flare bright' },
  { name: 'attractors',   title: 'Attractors',        blurb: 'de Jong map — millions of iters into luminous curves' },
  { name: 'lorenz',       title: 'Lorenz',            blurb: 'the butterfly that launched chaos theory — a strange attractor in 3D', show: true },
  { name: 'bifurcation',  title: 'Bifurcation',       blurb: "the logistic map's period-doubling cascade into chaos" },
  { name: 'pendulum',     title: 'Double Pendulum',   blurb: 'every pixel an initial angle, shaded by time-to-flip — sensitive chaos' },
  { name: 'times-table',  title: 'Times Tables',      blurb: 'chords i→i·k mod N draw cardioids, nephroids and beyond', show: true },
  { name: 'ulam',         title: 'Ulam Spiral',       blurb: 'primes on a square spiral — diagonals of prime-rich quadratics' },
  { name: 'pascal-sierpinski', title: 'Pascal mod p', blurb: "Pascal's triangle mod p — mod 2 is Sierpiński, primes remix it" },
  { name: 'gauss-primes', title: 'Gaussian Primes',   blurb: 'primes of ℤ[i] in the plane — eightfold-symmetric constellations' },
  { name: 'phyllotaxis',  title: 'Phyllotaxis',       blurb: 'seeds at the golden angle — a hair off 137.5° breaks the sunflower', show: true },
  { name: 'fern',         title: 'Barnsley Fern',     blurb: 'the chaos game on four affine maps grows a fern that sways' },
  { name: 'lsystem',      title: 'L-Systems',         blurb: 'string-rewriting grammars draw Koch, the dragon, and growing plants' },
  { name: 'voronoi',      title: 'Voronoi',           blurb: 'brute-force nearest-site cells, drifting', show: true },
  { name: 'apollonian',   title: 'Apollonian Gasket', blurb: "Descartes' circle theorem packs circles within circles, forever" },
  { name: 'truchet',      title: 'Truchet Tiles',     blurb: 'two random arc tiles assemble into endless flowing labyrinths' },
  { name: 'penrose',      title: 'Penrose Tiling',    blurb: 'golden-ratio deflation — aperiodic order with five-fold symmetry' },
  { name: 'hyperbolic',   title: 'Hyperbolic Tiling', blurb: "a tessellation of the Poincaré disk — Escher's Circle Limit" },
  { name: 'raymarcher',   title: 'Raymarcher',        blurb: 'an SDF sphere field — Shadertoy on the CPU', kernels: ['raymarcher.simd'], show: true },
  { name: 'metaballs',    title: 'Metaballs',         blurb: 'organic blobs — 2D implicit surface marching', show: true },
  { name: 'nbody',        title: 'N-body',            blurb: '1024-body gravity — pairwise attraction', show: true },
  { name: 'boids',        title: 'Boids',             blurb: 'Reynolds flocking — cohesion, alignment, separation; the cursor is a hawk', show: true },
  { name: 'swarm',        title: 'Swarm',             blurb: 'flies that chase and circle the cursor' },
  { name: 'cloth',        title: 'Cloth',             blurb: 'Verlet spring-mass cloth — grab and swing it' },
  { name: 'cradle',       title: "Newton's Cradle",   blurb: "Newton's cradle — kinetic energy passing through" },
  { name: 'sph',          title: 'SPH Fluid',         blurb: 'SPH particle fluid — smoothed-particle hydrodynamics' },
  { name: 'lbm',          title: 'Lattice-Boltzmann', blurb: 'lattice-Boltzmann flow — a von Kármán vortex street' },
  { name: 'raytrace',     title: 'Raytrace',          blurb: 'per-pixel ray-sphere intersection' },
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
  'cloth':             W + 'Cloth_modeling',
  'cradle':            W + 'Newton%27s_cradle',
  'sph':               W + 'Smoothed-particle_hydrodynamics',
  'lbm':               W + 'Lattice_Boltzmann_methods',
  'raytrace':          W + 'Ray_tracing_(graphics)',
}
