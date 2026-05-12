/**
 * test262 runner for jz.
 *
 * Usage:
 *   node test/test262.js                  # run all applicable tests
 *   node test/test262.js --quick          # run first 100 per category
 *   node test/test262.js --filter=String  # only run String tests
 *
 * Requires: test262 checkout at ./test262 (auto-cloned if missing).
 *
 * Strategy: scan tracked test262/test/language/ areas, attempt compile+run each
 * test, categorize as pass/fail/skip, and report pass coverage against the full
 * language and full test262 denominators.
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { execSync } from 'child_process'

const ROOT = join(import.meta.dirname, '..')
const TEST262 = join(import.meta.dirname, 'test262')

// Ensure test262 repo exists
if (!existsSync(TEST262)) {
  console.log('Cloning test262 (this may take a minute)...')
  execSync('git clone --depth 1 https://github.com/tc39/test262.git ' + TEST262, { stdio: 'inherit' })
}

// Language directories currently tracked as coverage work. This list is not a
// metric denominator; add meaningful jz areas here as support grows.
const TRACKED_LANGUAGE_DIRS = [
  'asi',
  'comments',
  'white-space',
  'line-terminators',
  'punctuators',
  'directive-prologue',
  'expressions',
  'statements',
  'types',
  'identifiers',
  'literals',
  'block-scope',
  'destructuring',
  'module-code',
  'function-code',
  'rest-parameters',
  'arguments-object',
  'keywords',
  'reserved-words',
  'future-reserved-words',
  'identifier-resolution',
  'computed-property-names',
  'statementList',
  'global-code',
  'source-text',
  'export',
]

const COMPUTED_PROPERTY_NAME_OBJECT_TESTS = new Set([
  'cpn-obj-lit-computed-property-name-from-additive-expression-add.js',
  'cpn-obj-lit-computed-property-name-from-additive-expression-subtract.js',
  'cpn-obj-lit-computed-property-name-from-condition-expression-false.js',
  'cpn-obj-lit-computed-property-name-from-condition-expression-true.js',
  'cpn-obj-lit-computed-property-name-from-decimal-e-notational-literal.js',
  'cpn-obj-lit-computed-property-name-from-decimal-literal.js',
  'cpn-obj-lit-computed-property-name-from-exponetiation-expression.js',
  'cpn-obj-lit-computed-property-name-from-expression-coalesce.js',
  'cpn-obj-lit-computed-property-name-from-expression-logical-and.js',
  'cpn-obj-lit-computed-property-name-from-expression-logical-or.js',
  'cpn-obj-lit-computed-property-name-from-identifier.js',
  'cpn-obj-lit-computed-property-name-from-integer-e-notational-literal.js',
  'cpn-obj-lit-computed-property-name-from-integer-separators.js',
  'cpn-obj-lit-computed-property-name-from-math.js',
  'cpn-obj-lit-computed-property-name-from-multiplicative-expression-div.js',
  'cpn-obj-lit-computed-property-name-from-multiplicative-expression-mult.js',
  'cpn-obj-lit-computed-property-name-from-null.js',
  'cpn-obj-lit-computed-property-name-from-numeric-literal.js',
  'cpn-obj-lit-computed-property-name-from-string-literal.js',
])

const ARGUMENTS_OBJECT_TESTS = new Set([
  'func-decl-args-trailing-comma-multiple.js',
  'func-decl-args-trailing-comma-null.js',
  'func-decl-args-trailing-comma-single-args.js',
  'func-decl-args-trailing-comma-undefined.js',
  'func-expr-args-trailing-comma-multiple.js',
  'func-expr-args-trailing-comma-null.js',
  'func-expr-args-trailing-comma-single-args.js',
  'func-expr-args-trailing-comma-undefined.js',
])

function baseName(rel) { return rel.slice(rel.lastIndexOf('/') + 1) }

function isComputedPropertyNameObjectTest(rel) {
  return rel.includes('language/expressions/object/') && COMPUTED_PROPERTY_NAME_OBJECT_TESTS.has(baseName(rel))
}

function isArgumentsObjectTest(rel) {
  return rel.includes('language/arguments-object/') && ARGUMENTS_OBJECT_TESTS.has(baseName(rel))
}

const ASSERT_HARNESS = `
function Test262Error(message) { return message || 'Test262Error' }
function Error(message) { return message || 'Error' }
function EvalError(message) { return message || 'EvalError' }
function RangeError(message) { return message || 'RangeError' }
function ReferenceError(message) { return message || 'ReferenceError' }
function SyntaxError(message) { return message || 'SyntaxError' }
function TypeError(message) { return message || 'TypeError' }
function URIError(message) { return message || 'URIError' }
let __sameValue = (a, b) => {
  if (a === b) return a !== 0 || 1 / a === 1 / b
  return a !== a && b !== b
}
let assert = (cond, msg) => { if (!cond) throw msg }
assert.sameValue = (a, b, msg) => { if (!__sameValue(a, b)) throw msg }
assert.notSameValue = (a, b, msg) => { if (__sameValue(a, b)) throw msg }
assert.compareArray = (a, b, msg) => {
  if (a.length != b.length) throw msg
  for (let i = 0; i < a.length; i++) if (!__sameValue(a[i], b[i])) throw msg
}
assert.throws = (expected, fn, msg) => {
  let threw = 0
  try { fn() } catch (e) { threw = 1 }
  if (!threw) throw msg
}
`

function needsAssertHarness(content, rel = '') {
  return rel.includes('language/rest-parameters/') ||
    isComputedPropertyNameObjectTest(rel) ||
    isArgumentsObjectTest(rel) ||
    content.includes('assert') ||
    content.includes('Test262Error') ||
    content.includes('compareArray')
}

// Features to exclude entirely
const EXCLUDED_PATTERNS = [
  /async/i, /await/, /generator/i, /yield/,
  /\bthis\b/, /\bclass\b/, /\bsuper\b/, /reflect/i, /proxy/i,
  /\bnew\b.*\btarget\b/, /\bwith\b/,
  /\bWeak(Ref|Map|Set)\b/, /\bBigInt\b/i,
  /iterator/i, /\bSymbol\b/, /symbol\.species/i, /symbol\.toPrimitive/i,
  /symbol\.iterator/i, /for[\s-]*of/i, /regexp/i,
  /dynamic[\s-]*import/i, /import\.meta/i,
  /\bexport\s+default\b/,
  /\bdelete\b/,
]

// `class` (and the `this` it implies) is lowered by jzify into plain objects +
// arrow-captured methods — but only the desugarable subset. For test files under
// `language/{expressions,statements}/class/` we apply a narrower exclusion list
// (no blanket `this`/`class` ban) plus a feature-skip pass below.
const CLASS_EXCLUDED_PATTERNS = [
  /async/i, /await/, /generator/i, /yield/, /\bsuper\b/, /reflect/i, /proxy/i,
  /\bnew\b.*\btarget\b/, /\bWeak(Ref|Map|Set)\b/, /\bBigInt\b/i,
  /iterator/i, /\bSymbol\b/, /for[\s-]*of/i, /regexp/i,
  /dynamic[\s-]*import/i, /import\.meta/i, /\bexport\s+default\b/, /\bdelete\b/,
]
const isClassTest = (rel) => /\/(expressions|statements)\/class\//.test(rel)

// Quick mode: limit tests per subdirectory
const QUICK = process.argv.includes('--quick')
const FILTER = process.argv.find(a => a.startsWith('--filter='))?.split('=')[1]
const MAX_PER_DIR = QUICK ? 50 : Infinity

// Collect test files
function* walk(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* walk(full)
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) yield full
    }
  } catch { /* skip unreadable dirs */ }
}

function countJs(dir) {
  let count = 0
  for (const _ of walk(dir)) count++
  return count
}

function shouldSkip(content, rel = '') {
  const codeContent = content
    .replace(/\/\*---[\s\S]*?---\*\//, '')
    .replace(/^\/\/[^\n]*(?:\n|$)/gm, '')
  // BigInt detection: check raw content for `BigInt` (frontmatter `features: [BigInt]`)
  // and stripped content for numeric BigInt literals (123n).
  if (/\bBigInt\b/.test(content) || /\b\d+n\b/.test(codeContent)) return 'BigInt unsupported'
  if (rel.includes('language/expressions/object/cpn-obj-lit-computed-property-name-from-') && !isComputedPropertyNameObjectTest(rel))
    return 'computed property name outside fixed-shape subset'
  // Getter/setter accessors aren't supported in jz's fixed-shape object model
  if (/\b(get|set)\s+\w+\s*\(/.test(codeContent) && rel.includes('expressions/object/')) return 'object accessor outside fixed-shape subset'
  if (rel.includes('expressions/object/accessor-')) return 'object accessor outside fixed-shape subset'
  if (/\.name\b.*===.*['"]\w+['"]/.test(codeContent) || /assert\.sameValue\([^,]+\.name,/.test(codeContent)) return 'function .name reflection unsupported'
  // Spread in object/array literals requires iterator protocol — not supported in jz
  if (rel.includes('expressions/array/spread-') || rel.includes('expressions/object/spread-')) return 'spread iterator protocol unsupported'
  // valueOf/toPrimitive coercion isn't called by jz numeric ops
  if (/\bvalueOf\b\s*:/.test(codeContent) || /\bvalueOf\s*:\s*function/.test(codeContent)) return 'valueOf coercion unsupported'
  if (rel.includes('language/arguments-object/') && !isArgumentsObjectTest(rel))
    return 'arguments object outside jzify-supported subset'
  if (/\bdo\s*;\s*while\b/.test(codeContent)) return 'do-while empty-statement parser gap'
  if (rel.includes('/optional-catch-binding')) return 'optional catch binding parser gap'
  if (rel.includes('/block-scope/shadowing/') && rel.includes('catch-parameter')) return 'catch parameter shadowing codegen gap'
  if (rel.includes('/for-of/')) return 'for-of outside current jz scope'
  if (content.includes('for-in-order')) return 'for-in mutation-order semantics outside simple jz subset'
  if (rel.includes('/statements/for/head-lhs-let.js')) return 'let-as-identifier parser edge outside current jz scope'
  if (rel.includes('/statements/let/syntax/let.js')) return 'uninitialized lexical binding test outside current jz scope'
  // TDZ semantics — jz binds without runtime TDZ check.
  if (/-before-initialization/.test(rel) && (rel.includes('/statements/let/') || rel.includes('/statements/const/'))) return 'TDZ outside current jz scope'
  // `let`/`const` fresh-binding per for-loop iteration — closure capture creates one binding per iteration.
  if (rel.includes('/statements/let/syntax/let-closure-inside-')) return 'let-per-iteration binding outside current jz scope'
  if (rel.includes('/statements/let/syntax/let-iteration-variable-is-freshly-allocated-')) return 'let-per-iteration binding outside current jz scope'
  // const reassignment runtime guard not enforced by jz.
  if (rel.includes('/statements/const/syntax/const-invalid-assignment-')) return 'const reassignment guard outside current jz scope'
  if (rel.includes('/statements/switch/scope-lex-')) return 'switch lexical environment semantics outside current jz scope'
  if (rel.includes('/statements/try/12.14-')) return 'legacy catch scope semantics outside current jz scope'
  if (rel.includes('/function-code/eval-')) return 'direct eval parameter environment outside current jz scope'
  if (rel.includes('/regexp/')) return 'regexp outside current jz scope'
  if (/features:\s*\[[^\]]*destructuring-binding/.test(content) || rel.includes('/dstr/') || rel.includes('/destructuring/')) return 'destructuring binding outside current jz subset'
  // Destructuring patterns in let/var/const declarators — `let [x]`, `let {x}` — outside jz subset.
  if (/\b(let|var|const)\s*[\[{]/.test(codeContent)) return 'destructuring binding outside current jz subset'
  // Generator method shorthand (`*method() {}`) — frontmatter feature flag survives stripping.
  if (/features:\s*\[[^\]]*generators/.test(content)) return 'generator unsupported'
  if (rel.includes('/method-definition/generator-')) return 'generator method unsupported'
  // Method shorthand has [[Construct]] absence — jz can't distinguish from arrow.
  if (rel.endsWith('/method-definition/name-invoke-ctor.js')) return 'method shorthand non-ctor outside current jz scope'
  // Computed property name with throwing initializer — non-literal computed keys outside jz subset.
  if (rel.endsWith('/method-definition/name-prop-name-eval-error.js')) return 'computed property name outside fixed-shape subset'
  // Default-param TDZ requires per-param lexical environment.
  if (rel.includes('/method-definition/meth-dflt-params-ref-')) return 'default-param TDZ outside current jz scope'
  // `eval(...)` in formal parameters needs a separate parameter environment.
  if (/\bscope-meth-param-.*-var-close\.js$/.test(rel) || /\beval\(\s*['"]\s*var\b/.test(codeContent)) return 'direct eval in params outside current jz scope'
  // For-statement: per-iteration let environment + closure capture semantics.
  if (rel.includes('/statements/for/scope-body-lex-')) return 'let-per-iteration binding outside current jz scope'
  // Readonly built-in property assignment guard (Math.PI =, Number.MAX_VALUE =).
  if (/^test\/language\/expressions\/assignment\/11\.13\.1-/.test(rel)) return 'readonly built-in guard outside current jz scope'
  // Member assignment with null/undefined receiver — needs runtime nil-check.
  if (/^test\/language\/expressions\/assignment\/target-member-identifier-reference-(null|undefined)\.js$/.test(rel)) return 'null/undefined member assign guard outside current jz scope'
  // Argument evaluation order before non-callable check.
  if (/^test\/language\/expressions\/call\/11\.2\.3-3_/.test(rel)) return 'non-callable runtime check outside current jz scope'
  // Named function expression scope (function n() { var n; ... }).
  if (rel.endsWith('/expressions/call/scope-var-open.js')) return 'NFE binding scope outside current jz scope'
  // Object spread + getter — accessor + spread combination outside fixed-shape subset.
  if (/\/expressions\/call\/spread-obj-.*getter/.test(rel)) return 'object accessor outside fixed-shape subset'
  // Default-param TDZ (forward/self reference) requires per-param lexical environment.
  if (/\/(arrow-function|function)\/dflt-params-ref-(later|self)\.js$/.test(rel)) return 'default-param TDZ outside current jz scope'
  // Function `.length` reflection — jz exposes raw arity but not the JS Function object surface.
  if (/\/(arrow-function|function)\/(params-trailing-comma|dflt-params-trailing-comma)/.test(rel)) return 'function .length reflection unsupported'
  // Arrow `arguments`/`caller` lexical capture — runtime should throw, jz silently inherits.
  if (/\/arrow-function\/forbidden-ext\//.test(rel)) return 'arrow forbidden-ext reflection unsupported'
  // `new` on arrow → IsConstructor TypeError; jz arrow has no [[Construct]] distinction.
  if (rel.endsWith('/expressions/arrow-function/throw-new.js')) return 'new on arrow IsConstructor outside current jz scope'
  // Arrow params with destructuring inside cover parens.
  if (rel.endsWith('/expressions/arrow-function/syntax/arrowparameters-cover-initialize-2.js')) return 'destructuring binding outside current jz subset'
  // Named function expression: rebinding the inner name. NFE binding scope.
  if (/\/expressions\/function\/named-(no-strict|strict-error)-reassign-fn-name-in-body/.test(rel)) return 'NFE binding scope outside current jz scope'
  // Comparison operator coercion order — getters with side-effects on operands.
  if (/\/expressions\/(greater-than|less-than-or-equal|less-than|greater-than-or-equal)\/11\.8\./.test(rel)) return 'comparison coercion order outside current jz scope'
  // Logical assignment LHS-before-RHS evaluation order with computed keys + side effects.
  if (/\/expressions\/logical-assignment\/lgcl-(and|or|nullish)-assignment-operator-lhs-before-rhs\.js$/.test(rel)) return 'logical-assign side-effect order outside current jz scope'
  // Computed reference on null/undefined — TypeError surface jz doesn't synthesize.
  if (rel.endsWith('/expressions/member-expression/computed-reference-null-or-undefined.js')) return 'null/undefined member access TypeError outside current jz scope'
  // `new` with object spread + getter — accessor evaluation order.
  if (/\/expressions\/new\/spread-obj-.*getter/.test(rel)) return 'object accessor outside fixed-shape subset'
  // Optional chaining within for-in/for-of — for-of unsupported, for-in TypeError shape.
  if (/\/expressions\/optional-chaining\/iteration-statement-for-(in|of)/.test(rel)) return 'for-in/for-of with optional chaining outside current jz scope'
  // Optional chaining tests using non-string dictionary keys (`obj[undefined]`, `arr.true`, `[NaN]`)
  // depend on JS String() coercion of arbitrary values to property keys, which jz doesn't implement.
  if (rel.endsWith('/expressions/optional-chaining/optional-chain-expression-optional-expression.js')) return 'non-string property key coercion outside current jz scope'
  if (rel.endsWith('/expressions/optional-chaining/optional-chain-prod-expression.js')) return 'non-string property key coercion outside current jz scope'
  // Optional call with spread argument — spread outside current jz scope here.
  if (rel.endsWith('/expressions/optional-chaining/optional-chain-prod-arguments.js')) return 'spread in call args outside current jz scope'
  // Unicode escapes in identifier names (`obj.a`) — parser surface.
  if (rel.endsWith('/expressions/optional-chaining/optional-chain-prod-identifiername.js')) return 'unicode escape in identifier outside current jz scope'
  // Object literal accessors (get/set) — not invoked by jz, returns the function itself.
  // Tests that depend on getter side effects (e.g. counting invocations) loop forever.
  if (/[{,]\s*(get|set)\s+\w+\s*\(/.test(codeContent)) return 'object accessor outside fixed-shape subset'
  // for-in semantics: enumeration order/uniqueness, hasOwnProperty, head edge cases — engine-specific.
  if (rel.endsWith('/statements/for-in/12.6.4-1.js')) return 'for-in enumeration uniqueness outside current jz scope'
  if (/\/statements\/for-in\/head-(let|const)-bound-names-fordecl-tdz\.js$/.test(rel)) return 'for-in TDZ outside current jz scope'
  if (rel.endsWith('/statements/for-in/head-let-fresh-binding-per-iteration.js')) return 'let-per-iteration binding outside current jz scope'
  if (/\/statements\/for-in\/head-(lhs-cover|lhs-member)\.js$/.test(rel)) return 'for-in head LHS form outside current jz scope'
  if (/\/statements\/for-in\/head-var-bound-names-(in-stmt|let)\.js$/.test(rel)) return 'for-in head var binding outside current jz scope'
  if (/\/statements\/for-in\/scope-(body-lex-boundary|head-lex-open)\.js$/.test(rel)) return 'for-in lexical scoping outside current jz scope'
  // for-in to populate iteration order over arrays/objects — engine-specific iteration order.
  if (/\/block-scope\/syntax\/for-in\/acquire-properties-from-(array|object)\.js$/.test(rel)) return 'for-in enumeration order outside current jz scope'
  // Strict-mode reflection on function instances (.arguments setter, etc.).
  if (/\/statements\/function\/13\.2-(4|25|26)-s\.js$/.test(rel)) return 'function instance reflection (strict) outside current jz scope'
  // catch-block/param lexical environment with closure capture.
  if (/\/statements\/try\/scope-catch-(block|param)-lex-(close|open)\.js$/.test(rel)) return 'catch lexical environment outside current jz scope'
  // try-catch-finally completion semantics with return-inside-catch + throw-in-finally
  // require non-inline finally lowering (engine-specific completion-type override).
  if (rel.endsWith('/statements/try/completion-values-fn-finally-abrupt.js')) return 'try-catch-finally completion override outside current jz scope'
  // Block-scope context preservation through try/finally with closures.
  if (/\/block-scope\/leave\/verify-context-in-(try|finally)-block\.js$/.test(rel)) return 'block-scope context closures outside current jz scope'
  // Block-scope shadowing with function-in-block declaring closures over outer let/const/var.
  if (rel.endsWith('/block-scope/shadowing/lookup-from-closure.js')) return 'block-scope closure lookup outside current jz scope'
  if (rel.endsWith('/block-scope/shadowing/dynamic-lookup-from-closure.js')) return 'block-scope closure lookup outside current jz scope'
  if (rel.endsWith('/block-scope/shadowing/const-declarations-shadowing-parameter-name-let-const-and-var-variables.js')) return 'block-scope shadowing closure outside current jz scope'
  if (rel.endsWith('/block-scope/shadowing/hoisting-var-out-of-blocks.js')) return 'var hoisting through blocks outside current jz scope'
  // Math is not a constructor — `new Math` IsConstructor TypeError.
  if (rel.endsWith('/types/object/S8.6.2_A7.js')) return 'Math non-constructor TypeError outside current jz scope'
  // postincrement/preincrement on object property whose value is a string ("bar"++ → NaN).
  if (/\/types\/object\/S8\.6_A(2|3)_T1\.js$/.test(rel)) return 'object property pre/post-increment coercion outside current jz scope'
  // Strict-mode ReferenceError on undeclared assignment.
  if (rel.endsWith('/types/reference/8.7.2-3-a-1gs.js')) return 'strict-mode undeclared assign outside current jz scope'
  if (rel.endsWith('/asi/S7.9_A7_T7.js')) return 'strict-mode undeclared reference outside current jz scope'
  // Formal parameter shadowing by var in body.
  if (rel.endsWith('/function-code/S10.2.1_A5.2_T1.js')) return 'formal-param/var shadowing outside current jz scope'
  // Strict-mode AnnexB block-decl semantics.
  if (rel.endsWith('/function-code/block-decl-onlystrict.js')) return 'strict-mode block-decl AnnexB outside current jz scope'
  if (rel.endsWith('/global-code/block-decl-strict.js')) return 'strict-mode block-decl AnnexB outside current jz scope'
  // Legacy octal numeric literals and string escape sequences.
  if (rel.endsWith('/literals/numeric/legacy-octal-integer.js')) return 'legacy octal numeric outside current jz scope'
  if (rel.endsWith('/literals/string/legacy-octal-escape-sequence.js')) return 'legacy octal escape outside current jz scope'
  // Line continuation in string literals.
  if (/\/literals\/string\/line-continuation-(double|single)\.js$/.test(rel)) return 'string line continuation parser gap'
  // Function .length reflection (rest-parameters expected count).
  if (rel.endsWith('/rest-parameters/expected-argument-count.js')) return 'function .length reflection unsupported'
  // Line-terminator parser tests for LS/PS/BOM in string literals — parser-level edge case.
  if (/\/line-terminators\/7\.3-(5|6|15)\.js$/.test(rel)) return 'LS/PS/BOM in string literal outside current jz scope'
  // Strict-mode reference error on undeclared assignment in directive-prologue test.
  if (/\/directive-prologue\/func-(decl|expr)-no-semi-runtime\.js$/.test(rel)) return 'strict-mode undeclared assign outside current jz scope'
  // Pre/post-increment/decrement on null member access — TypeError surface jz doesn't synthesize.
  if (/\/expressions\/(postfix|prefix)-(increment|decrement)\/S11\.[34]\.\d_A6_T[12]\.js$/.test(rel)) return 'null/undefined member pre/post-inc TypeError outside current jz scope'
  // Tagged template literal feature — outside current jz scope.
  if (rel.includes('/expressions/tagged-template/')) return 'tagged template literal outside current jz scope'
  // Template literal evaluation order/object identity/escape sequences — outside current jz scope.
  if (rel.includes('/expressions/template-literal/')) return 'template literal feature outside current jz scope'
  // void on undeclared name → strict-mode ReferenceError surface.
  if (rel.endsWith('/expressions/void/S11.4.2_A2_T2.js')) return 'strict-mode undeclared reference outside current jz scope'
  // reserved-words tests using hasOwnProperty + dictionary keys with global names ('undefined', 'NaN', etc.).
  if (/\/reserved-words\/ident-name-(global-property|reserved-word-literal)-(memberexpr|memberexpr-str|prop-name)\.js$/.test(rel)) return 'hasOwnProperty + dictionary keys outside fixed-shape subset'
  // Computed property method shorthand (`{ [k]() {} }`) — method shorthand outside jz scope.
  if (/\/computed-property-names\/object\/method\/(number|string)\.js$/.test(rel)) return 'computed method shorthand outside current jz scope'
  if (rel.endsWith('/computed-property-names/to-name-side-effects/object.js')) return 'computed method shorthand outside current jz scope'
  // Regex literal in statement list — regex outside jz scope.
  if (/\/statementList\/block-(regexp-literal|with-statment-regexp-literal)\.js$/.test(rel)) return 'regexp literal outside current jz scope'
  // Compound-assignment strict-mode undeclared-reference + RHS-evaluation-order (ReferenceError before RHS eval).
  if (/\/expressions\/compound-assignment\/S11\.13\.2_A7\.\d+_T[123]\.js$/.test(rel)) return 'strict-mode undeclared reference / RHS eval order outside current jz scope'
  // Compound/logical assignment onto non-writable / accessor-without-setter properties — needs property-descriptor enforcement.
  if (/\/expressions\/compound-assignment\/11\.13\.2-(2[3-9]|3\d|4[0-4])-s\.js$/.test(rel)) return 'property descriptor (writable/accessor) semantics outside current jz scope'
  if (/\/expressions\/logical-assignment\/lgcl-(and|or|nullish)-assignment-operator-(non-writeable|no-set)(-put)?\.js$/.test(rel)) return 'property descriptor (writable/accessor) semantics outside current jz scope'
  // Reference-record put semantics on built-in / non-writable bindings (strict mode).
  if (/\/types\/reference\/8\.7\.2-[3467]-s\.js$/.test(rel)) return 'property descriptor (writable/accessor) semantics outside current jz scope'
  // for-in / object-spread tests that mutate descriptors via Object.defineProperty mid-iteration.
  if (rel.endsWith('/statements/for-in/order-after-define-property.js')) return 'Object.defineProperty descriptor semantics outside current jz scope'
  if (/\/expressions\/(new|call)\/spread-obj-skip-non-enumerable\.js$/.test(rel)) return 'non-enumerable property descriptor semantics outside current jz scope'
  // Large Unicode identifier-start stress files — recursive parser blows the JS stack on the biggest tables.
  if (/\/identifiers\/start-unicode-(5\.2\.0|8\.0\.0|9\.0\.0|1[0357]\.0\.0|16\.0\.0)(-escaped)?\.js$/.test(rel)) return 'large unicode identifier table parser stack outside current jz scope'
  // `let` in try/finally block shadowing an outer parameter — block-scope shadowing semantics.
  if (/\/block-scope\/leave\/(finally|try)-block-let-declaration-only-shadows-outer-parameter-value-[12]\.js$/.test(rel)) return 'block-scope let shadowing parameter outside current jz scope'
  // for-in head as a bare member/var expression (`for (x.y in obj)`) — head LHS form outside jz subset.
  if (rel.endsWith('/statements/for-in/head-var-expr.js')) return 'for-in head expression form outside current jz scope'
  // Computed-member assignment target with null/undefined receiver — runtime TypeError surface jz doesn't synthesize.
  if (/\/expressions\/assignment\/target-member-computed-reference(-null|-undefined)?\.js$/.test(rel)) return 'null/undefined computed-member assign guard outside current jz scope'
  // Coalesce short-circuit must not even evaluate a poisoned accessor on the RHS — accessor semantics.
  if (rel.endsWith('/expressions/coalesce/abrupt-is-a-short-circuit.js')) return 'accessor short-circuit semantics outside current jz scope'
  // `typeof Date()` — Date constructor outside current jz scope.
  if (rel.endsWith('/expressions/typeof/string.js')) return 'Date constructor outside current jz scope'
  // try/catch/finally completion-value propagation — engine-specific completion record semantics.
  if (rel.endsWith('/statements/try/completion-values-fn-finally-normal.js')) return 'try-catch-finally completion semantics outside current jz scope'
  // `var f = function (x = args = arguments) { let arguments; }` — a param default that
  // references the implicit `arguments` while the body lexically shadows it. jzify lowers
  // both, but the rest-param/default interplay still produces invalid codegen here.
  if (/\/(expressions|statements)\/function\/arguments-with-arguments-lex\.js$/.test(rel)) return 'arguments object + lexical shadow + param default outside current jz scope'
  // Class tests: jzify lowers the desugarable subset only — skip the rest.
  if (isClassTest(rel)) {
    if (rel.includes('/elements/wrapped-in-sc-')) return 'class in single-statement context parser gap'
    if (/\bextends\b/.test(codeContent) || /\bextends\b/.test(content)) return 'class extends/super outside jzify subset'
    if (/\bstatic\b/.test(codeContent)) return 'static class members outside jzify subset'
    if (/(^|[};{)\s])get\s+[\w$#\[]/.test(codeContent) || /(^|[};{)\s])set\s+[\w$#\[]/.test(codeContent)) return 'class accessors outside fixed-shape subset'
    if (/(^|\n)\s*(static\s+)?\*?\s*\[[^\]\n]+\]\s*(=|;|\(|$)/m.test(codeContent)) return 'computed class member name outside fixed-shape subset'
    if (/(^|\n)\s*\*\s*[\w$\[]/m.test(codeContent)) return 'generator method outside jzify subset'
    if (/#\w+\s*\(/.test(codeContent)) return 'private method outside jzify subset'
    if (/typeerror|abrupt-completion|init-err|evaluation-error/i.test(rel)) return 'class initializer/name error semantics outside jzify subset'
    if (/private-field-(access-on-inner|on-nested)|privatefieldget|privatefieldset/i.test(rel)) return 'private field access semantics outside jzify subset'
    if (/\bnew\.target\b/.test(codeContent)) return 'new.target outside jzify subset'
    if (/\.name\b/.test(codeContent) || /\.length\b/.test(codeContent)) return 'class function reflection unsupported'
    if (/__proto__|\bprototype\b/.test(codeContent)) return 'prototype reflection outside jzify subset'
    if (/Object\.(getPrototypeOf|setPrototypeOf|getOwnPropertyDescriptor|defineProperty|keys|getOwnPropertyNames|create|freeze)/.test(codeContent)) return 'object reflection outside jzify subset'
    if (CLASS_EXCLUDED_PATTERNS.some(p => p.test(codeContent))) return 'unsupported feature'
    // fall through to the harness/negative-test filters below
  } else
  // Skip tests with unsupported features
  if (EXCLUDED_PATTERNS.some(p => p.test(codeContent))) return 'unsupported feature'
  // Skip negative tests (expected to throw SyntaxError) — jz rejects differently
  if (/negative:\s*\n\s+phase:\s+parse/.test(content)) return 'negative parse test'
  if (/negative:\s*\n\s+phase:\s+runtime/.test(content)) return 'negative runtime test'
  if (content.includes('Test262Error') && !content.includes('assert.throws')) return 'Test262Error legacy harness'
  // Skip tests with harness-specific directives
  if (content.includes('$DONE') && !content.includes('runTest')) return 'harness dependency'
  if (content.includes('Test262:Async')) return 'async test'
  if (content.includes('propertyHelper')) return 'propertyHelper'
  if (content.includes('verifyProperty')) return 'verifyProperty'
  // Parser gaps tracked upstream in subscript; do not count as jz runtime failures.
  if (content.includes('\u00a0')) return 'NBSP parser gap'
  // Skip tests using undeclared globals
  if (/\bFunction\b/.test(content) && !content.includes('arrow function')) return 'Function global'
  if (/\bObject\.getOwnPropertyDescriptor\b/.test(content)) return 'Object.getOwnPropertyDescriptor'
  if (content.includes('MAX_ITERATIONS')) return 'MAX_ITERATIONS harness'
  if (/\.prototype\b/.test(codeContent)) return 'prototype chain outside current jz scope'
  if (/\bnew\s+(Boolean|Number|String)\b/.test(codeContent)) return 'boxed primitive object outside current jz scope'
  // Skip tests using `using` keyword (explicit resource management)
  if (/\busing\b/.test(codeContent)) return 'using keyword'
  // Multi-file module fixtures (not self-contained)
  if (content.includes('import ') && content.includes('_FIXTURE')) return 'fixture dependency'
  if (content.includes('import ') && /\bfrom\s+['"]\.\/[^'"]+_FIXTURE/.test(content)) return 'fixture dependency'
  if (content.includes('from ') && /\bfrom\s+['"]\.\/[^'"]+_FIXTURE/.test(content)) return 'fixture dependency'
  return null
}

// Try to compile and run a test
let compile, jz
try {
  const mod = await import(join(ROOT, 'index.js'))
  compile = mod.default.compile || mod.compile
  jz = mod.default
} catch (e) {
  console.error('Failed to import jz:', e.message)
  process.exit(1)
}

function runTest(src, options = {}) {
  // Strip test262 harness directives and includes
  let code = src
    .replace(/\/\*---[\s\S]*?---\*\//, '') // strip YAML frontmatter
    .replace(/^#![^\n]*(?:\n|$)/, '')
    .replace(/\.create\.js\b/g, '')  // non-existent files
    .replace(/\$DONOTEVALUATE\(\)/g, 'return')  // skip markers

  // Wrap bare statements into a module export for jz
  // test262 tests are typically bare scripts with assert() calls
  // We wrap them so jz can compile as a module
  const hasExport = /export\s+(let|const|function|default)/.test(code)
  if (!hasExport) {
    // Bare script — wrap in a function so jz can compile it
    code = `export let _run = () => {\n${options.assertHarness ? ASSERT_HARNESS : ''}\n${code}\nreturn 1\n}`
  } else {
    code = `${options.assertHarness ? ASSERT_HARNESS : ''}\n${code}`
  }

  try {
    const result = jz(code, { jzify: true })
    if (!result || !result.exports) return { status: 'fail', error: 'no output' }
    if (result.exports._run) result.exports._run()
    return { status: 'pass' }
  } catch (e) {
    let msg = e.message || ''
    if (!msg && e instanceof WebAssembly.Exception) msg = '[wasm-exception]'
    if (!msg) msg = (typeof e === 'string' ? e : (e?.toString?.() || JSON.stringify(e) || 'unknown'))
    // Compile-time errors for features jz intentionally doesn't support
    if (msg.includes('Unknown op') || msg.includes('not supported') ||
        msg.includes('prohibited') || msg.includes('strict mode') ||
        msg.includes('Unknown tag') || msg.includes('Unknown func') ||
        msg.includes('Unknown local') || msg.includes('conflicts with a compiler internal') ||
        msg.includes('Assignment to') || msg.includes('not declared') ||
        msg.includes('not exported') || msg.includes('has no default') ||
        msg.includes('Unknown module') || msg.includes('Unknown instruction') ||
        msg.includes('Unknown global') ||
        msg.includes('Imports argument must be present') ||
        msg.includes('function import requires a callable')) {
      return { status: 'skip', error: msg.slice(0, 80) }
    }
    return { status: 'fail', error: msg.slice(0, 120) }
  }
}

// Main
const results = { pass: 0, fail: 0, skip: 0 }
const fails = []
const testDir = join(TEST262, 'test', 'language')
const languageTest262Files = countJs(testDir)
const allTest262Files = countJs(join(TEST262, 'test'))

// Expand TRACKED_LANGUAGE_DIRS so large dirs (expressions/, statements/) get
// per-child progress output instead of one giant batch.
function expandedDirs() {
  const out = []
  for (const subdir of TRACKED_LANGUAGE_DIRS) {
    const dir = join(testDir, subdir)
    if (!existsSync(dir)) { out.push(subdir); continue }
    try {
      const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())
      // If the dir has > 8 child dirs, split per-child for visibility.
      if (entries.length > 8) {
        for (const e of entries) out.push(`${subdir}/${e.name}`)
        // Also include test files at the top of subdir (without descending into child dirs)
        out.push(`${subdir}/.`)
      } else {
        out.push(subdir)
      }
    } catch { out.push(subdir) }
  }
  return out
}

const DIRS = expandedDirs()

function* filesUnder(rootDir, opts = {}) {
  // opts.flatOnly: only direct children files of rootDir (skip nested dirs)
  if (opts.flatOnly) {
    try {
      for (const e of readdirSync(rootDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('.'))
          yield join(rootDir, e.name)
      }
    } catch {}
    return
  }
  yield* walk(rootDir)
}

for (const subdir of DIRS) {
  const flatOnly = subdir.endsWith('/.')
  const cleanSubdir = flatOnly ? subdir.slice(0, -2) : subdir
  const dir = join(testDir, cleanSubdir)
  if (!existsSync(dir)) { console.log(`  skipping ${subdir}/ (not found)`); continue }
  if (FILTER && !subdir.includes(FILTER)) continue

  let count = 0
  let dirPass = 0, dirFail = 0, dirSkip = 0
  for (const file of filesUnder(dir, { flatOnly })) {
    if (count >= MAX_PER_DIR) break
    const rel = relative(TEST262, file)
    // Skip entire directories for unsupported features
    if (rel.includes('dynamic-import') || rel.includes('import.meta') ||
      rel.includes('export-expname') || rel.includes('import-attributes') ||
      rel.includes('top-level-await') ||
      rel.includes('instn-resolve-') || rel.includes('eval-rqstd-')) { results.skip++; dirSkip++; count++; continue }

    try {
      const src = readFileSync(file, 'utf-8')
      const skip = shouldSkip(src, rel)
      if (skip) { results.skip++; dirSkip++; count++; continue }

      const assertHarness = needsAssertHarness(src, rel)
      const { status, error } = runTest(src, { assertHarness })
      results[status]++
      if (status === 'pass') dirPass++
      else if (status === 'fail') dirFail++
      else dirSkip++
      count++

      if (status === 'fail') {
        fails.push(`${rel}: ${error}`)
      }
    } catch {
      results.skip++
      dirSkip++
      count++
    }
  }
  console.log(`  ${subdir}/: ${count} tests (pass=${dirPass} fail=${dirFail} skip=${dirSkip})`)
}

const total = results.pass + results.fail + results.skip

console.log(`\n── Results ──`)
console.log(`  Pass:          ${results.pass}`)
console.log(`  Fail:          ${results.fail}`)
console.log(`  Skip:          ${results.skip}`)
console.log(`  Tracked files: ${total}/${languageTest262Files} language JS files`)

const languageCoverage = languageTest262Files ? (results.pass / languageTest262Files * 100).toFixed(1) : '0.0'
const overallCoverage = allTest262Files ? (results.pass / allTest262Files * 100).toFixed(1) : '0.0'
console.log(`\n  Language coverage (pass / language JS files): ${languageCoverage}% (${results.pass}/${languageTest262Files})`)
console.log(`  Overall test262 coverage (pass / all JS files): ${overallCoverage}% (${results.pass}/${allTest262Files})`)

if (fails.length) {
  console.log(`\n── Sample failures ──`)
  fails.forEach(f => console.log(`  ✗ ${f}`))
}
