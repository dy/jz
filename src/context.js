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
 * @returns {Object} - New compilation context
 */
export function createContext() {
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
    usedMemory: false,
    usedFuncTable: false,    // call_indirect closures
    usedFuncTypes: null,     // Set of arities for fntype

    // Stdlib tracking
    usedStdlib: [],

    // Closures (memory-based)
    funcTableEntries: [],    // Functions in table
    closures: {},            // name -> { envType, envFields, captured }
    closureCounter: 0,
    currentEnv: null,        // Current environment type name
    capturedVars: {},        // name -> field index in env
    hoistedVars: null,       // name -> field index in own env
    ownEnvType: null,        // Own environment type name

    // Exports
    exports: new Set(),      // Names explicitly exported
    exportSignatures: {},    // name -> { arrayParams: number[], returnsArray: boolean }

    // Type inference for params (JS interop)
    inferredArrayParams: new Set(),  // param names used with array methods
    returnsArrayPointer: false,      // set true when function returns array pointer

    // Array aliasing warnings
    knownArrayVars: new Set(),  // variable names known to hold arrays

    // Strings
    strings: {},             // str -> { id, offset, length }
    stringData: [],          // UTF-16 byte array
    stringCounter: 0,

    // Arrays (static allocation)
    staticArrays: {},
    arrayDataOffset: 0,

    // Objects
    objectCounter: 0,
    objectSchemas: {},
    staticObjects: {},       // static object data segments

    // Regex
    regexCounter: 0,
    regexFunctions: [],

    // Static namespaces (objects with only function properties, known at compile-time)
    // name -> { method: { params, body, funcName } }
    namespaces: {},

    // Memory
    staticAllocs: [],
    staticOffset: 0,

    // Loop tracking (loopCounter is alias for uniqueId for backwards compat)
    uniqueId: 0,
    get loopCounter() { return this.uniqueId },
    set loopCounter(v) { this.uniqueId = v },

    // Methods

    /**
     * Add a local variable
     * @param {string} name - Variable name (with or without $ prefix)
     * @param {string} type - Type: 'f64', 'i32', 'array', 'string', 'namespace', etc.
     * @param {Object} schema - Optional object schema
     * @param {string} scopedName - Optional explicit scoped name
     */
    addLocal(name, type = 'f64', schema, scopedName = null) {
      // Strip $ prefix if present - allows passing $varname directly
      const cleanName = name.startsWith('$') ? name.slice(1) : name
      const finalName = scopedName || cleanName
      if (!(finalName in this.locals)) {
        // Store scopedName directly to avoid spread at lookup time
        this.locals[finalName] = { idx: this.localCounter++, type, originalName: name, scopedName: finalName }
        // Namespace type is compile-time only - no WASM local needed
        if (type === 'namespace') return this.locals[finalName]
        // Memory-based: all reference types are f64 pointers
        const wasmType = (type === 'array' || type === 'ref' || type === 'refarray' ||
           type === 'object' || type === 'string' || type === 'closure' ||
           type === 'boxed_string' || type === 'boxed_number' || type === 'boxed_boolean' ||
           type === 'array_props' || type === 'typedarray' || type === 'regex' ||
           type === 'set' || type === 'map') ? 'f64' : type
        this.localDecls.push(`(local $${finalName} ${wasmType})`)
      }
      if (schema !== undefined) this.localSchemas[finalName] = schema
      return this.locals[finalName]
    },

    /**
     * Get a local variable by name (searches scopes)
     */
    getLocal(name) {
      // Internal variables (_prefix) don't have scope
      if (name.startsWith('_')) {
        return this.locals[name] || null
      }
      // Search from innermost scope outward
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const scopedName = i > 0 ? `${name}_s${i}` : name
        if (scopedName in this.locals) return this.locals[scopedName]
      }
      // Fallback: check unscoped name
      return this.locals[name] || null
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
     * Emit a compile-time warning
     * @param {string} code - Warning code (e.g. 'array-alias', 'var')
     * @param {string} msg - Warning message
     */
    warn(code, msg) {
      console.warn(`jz: [${code}] ${msg}`)
    },

    /**
     * Throw a compile-time error
     * @param {string} code - Error code (e.g. 'unknown-id', 'type-error')
     * @param {string} msg - Error message
     */
    error(code, msg) {
      throw new Error(`jz: [${code}] ${msg}`)
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
    },

    /**
     * Create a child context for function compilation.
     * Shares parent's:
     *  - usedStdlib, functions, closures, globals, funcTableEntries
     *  - staticArrays, strings, stringData, objectSchemas, objectPropTypes, namespaces
     * Fresh for child:
     *  - locals, localDecls, localCounter, scopes, constVars, localSchemas
     *  - inFunction, uniqueId
     */
    fork() {
      const child = createContext()
      // Shared state (mutated by child, visible to parent)
      child.usedStdlib = this.usedStdlib
      child.usedArrayType = this.usedArrayType
      child.usedStringType = this.usedStringType
      child.functions = this.functions
      child.closures = this.closures
      child.closureEnvTypes = this.closureEnvTypes
      child.closureCounter = this.closureCounter
      child.globals = this.globals
      child.funcTableEntries = this.funcTableEntries
      child.staticArrays = this.staticArrays
      child.staticObjects = this.staticObjects
      child.strings = this.strings
      child.stringData = this.stringData
      child.stringOffset = this.stringOffset
      child.objectSchemas = this.objectSchemas
      child.objectPropTypes = this.objectPropTypes
      child.namespaces = this.namespaces
      child.inFunction = true
      return child
    }
  }
}
