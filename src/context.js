/**
 * Compilation context for jz compiler
 *
 * Tracks all state during compilation:
 * - Local and global variables
 * - Functions and closures
 * - Type information
 * - Memory allocation
 * - String interning
 */

/**
 * Create a fresh compilation context
 * @param {boolean} gc - Whether GC mode is enabled
 * @returns {Object} - New compilation context
 */
export function createContext(gc = true) {
  return {
    // Variables
    locals: {},           // name -> { idx, type, originalName }
    localDecls: [],       // WAT local declarations
    globals: {},          // name -> { type, init }
    localCounter: 0,

    // Functions
    functions: {},        // name -> { params, body, closure? }
    inFunction: false,

    // Scoping (for let/const block scope)
    scopeDepth: 0,
    scopes: [{}],         // Stack of scope name sets
    constVars: {},        // scopedName -> true for const variables
    localSchemas: {},     // scopedName -> object schema

    // Types used
    usedArrayType: false,
    usedStringType: false,
    usedRefArrayType: false,
    usedMemory: false,
    usedClosureType: false,  // funcref-based closures (gc:true)
    usedFuncTable: false,    // call_indirect closures (gc:false)
    usedFuncTypes: null,     // Set of arities for fntype
    usedClFuncTypes: null,   // Set of arities for closure-returning fntype

    // Stdlib tracking
    usedStdlib: [],

    // Closures
    funcTableEntries: [],    // Functions in table (gc:false)
    refFuncs: new Set(),     // Functions needing elem declare (gc:true)
    closures: {},            // name -> { envType, envFields, captured }
    closureEnvTypes: [],     // Struct type definitions
    closureCounter: 0,
    currentEnv: null,        // Current environment type name
    capturedVars: {},        // name -> field index in env
    hoistedVars: null,       // name -> field index in own env
    ownEnvType: null,        // Own environment type name

    // Strings
    strings: {},             // str -> { id, offset, length }
    stringData: [],          // UTF-16 byte array
    stringCounter: 0,
    internedStringGlobals: {}, // id -> { length }

    // Arrays (gc:false static allocation)
    staticArrays: {},
    arrayDataOffset: 0,

    // Objects
    objectCounter: 0,
    objectSchemas: {},

    // Memory (gc:false)
    staticAllocs: [],
    staticOffset: 0,

    // Loop tracking
    loopCounter: 0,

    // Methods

    /**
     * Add a local variable
     * @param {string} name - Variable name
     * @param {string} type - Type: 'f64', 'i32', 'array', 'string', etc.
     * @param {Object} schema - Optional object schema
     * @param {string} scopedName - Optional explicit scoped name
     */
    addLocal(name, type = 'f64', schema, scopedName = null) {
      const finalName = scopedName || name
      if (!(finalName in this.locals)) {
        this.locals[finalName] = { idx: this.localCounter++, type, originalName: name }
        // WAT type depends on gc mode
        const wasmType = gc
          ? (type === 'refarray' ? '(ref null $anyarray)'
            : type === 'array' || type === 'ref' || type === 'object' ? '(ref null $f64array)'
            : type === 'string' ? '(ref null $string)'
            : type === 'closure' ? '(ref null $closure)'
            : type)
          : (type === 'array' || type === 'ref' || type === 'refarray' ||
             type === 'object' || type === 'string' || type === 'closure' ? 'f64' : type)
        this.localDecls.push(`(local $${finalName} ${wasmType})`)
      }
      if (schema !== undefined) this.localSchemas[finalName] = schema
      return { ...this.locals[finalName], scopedName: finalName }
    },

    /**
     * Get a local variable by name (searches scopes)
     */
    getLocal(name) {
      // Internal variables (_prefix) don't have scope
      if (name.startsWith('_')) {
        return name in this.locals ? { ...this.locals[name], scopedName: name } : null
      }
      // Search from innermost scope outward
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const scopedName = i > 0 ? `${name}_s${i}` : name
        if (scopedName in this.locals) return { ...this.locals[scopedName], scopedName }
      }
      // Fallback: check unscoped name
      if (name in this.locals) return { ...this.locals[name], scopedName: name }
      return null
    },

    pushScope() {
      this.scopeDepth++
      this.scopes.push({})
    },

    popScope() {
      this.scopes.pop()
      this.scopeDepth--
    },

    /**
     * Declare a variable in current scope
     * @returns {string} - Scoped name for the variable
     */
    declareVar(name, isConst = false) {
      const scopedName = this.scopeDepth > 0 ? `${name}_s${this.scopeDepth}` : name
      this.scopes[this.scopes.length - 1][name] = true
      if (isConst) this.constVars[scopedName] = true
      return scopedName
    },

    addGlobal(name, type = 'f64', init = '(f64.const 0)') {
      if (!(name in this.globals)) this.globals[name] = { type, init }
      return this.globals[name]
    },

    getGlobal(name) {
      return this.globals[name]
    },

    /**
     * Intern a string literal, returning id and metadata
     */
    internString(str) {
      if (str in this.strings) return this.strings[str]
      const id = this.stringCounter++
      const offset = this.stringData.length / 2
      for (const char of str) {
        const code = char.charCodeAt(0)
        this.stringData.push(code & 0xFF, (code >> 8) & 0xFF)
      }
      const info = { id, offset, length: str.length }
      this.strings[str] = info
      return info
    },

    /**
     * Allocate static memory (gc:false mode)
     */
    allocStatic(size) {
      const offset = this.staticOffset
      this.staticOffset += size
      return offset
    }
  }
}
