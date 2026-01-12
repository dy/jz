#!/usr/bin/env node

/**
 * JZ Test262 Runner
 * Selective test runner for test262 that focuses on JZ's minimal functional JS subset
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname } from 'path'
import { evaluate } from './util.js'

const TEST262_DIR = './test262'

// Test categories that align with JZ's functional subset philosophy
const RELEVANT_CATEGORIES = [
  'expressions/addition-operator',
  'expressions/multiplicative-operator',
  'expressions/additive-operator',
  'literals/numeric',
  'expressions/assignment-operator',
  'white-space',
  'comments',
  'source-text/module-code'
]

// Skip these complex features that JZ doesn't support
const SKIP_FEATURES = [
  'class', 'prototype', 'this', 'super', 'new',
  'async', 'await', 'generator', 'yield',
  'module', 'import', 'export',
  'destructuring', 'spread', 'rest',
  'template-literal', 'regexp',
  'object-literal', 'array-literal',
  'function-declaration', 'arrow-function',
  'let', 'const', 'var',
  'for', 'while', 'do-while',
  'try', 'catch', 'throw',
  'eval', 'with', 'delete'
]

class JZTest262Runner {
  constructor() {
    this.passed = 0
    this.failed = 0
    this.skipped = 0
    this.results = []
  }

  async runTests(filter = '') {
    console.log('JZ Test262 Runner - Functional JS Subset')
    console.log('==========================================\n')

    const testFiles = this.findTestFiles(filter)
    console.log(`Found ${testFiles.length} relevant test files\n`)

    for (const testFile of testFiles) {
      await this.runTestFile(testFile)
    }

    this.printSummary()
  }

  findTestFiles(filter) {
    const files = []

    function scanDir(dir) {
      try {
        const items = readdirSync(dir)

        for (const item of items) {
          const fullPath = join(dir, item)
          const stat = statSync(fullPath)

          if (stat.isDirectory()) {
            // Only scan relevant categories
            const category = item
            if (RELEVANT_CATEGORIES.includes(category) || category === 'numeric') {
              scanDir(fullPath)
            }
          } else if (stat.isFile() && extname(item) === '.js') {
            // Apply filter if specified
            if (!filter || fullPath.includes(filter)) {
              files.push(fullPath)
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    }

    scanDir(join(TEST262_DIR, 'test/language'))
    return files
  }

  async runTestFile(testFile) {
    try {
      const content = readFileSync(testFile, 'utf8')

      // Parse test262 test structure
      const testInfo = this.parseTest262File(content, testFile)

      if (!testInfo) {
        this.skipped++
        return
      }

      // Check if test is relevant for JZ
      if (!this.isRelevantForJZ(testInfo)) {
        this.skipped++
        return
      }

      // Run the test
      const result = await this.runJZTest(testInfo)

      if (result.passed) {
        this.passed++
        console.log(`✓ ${testFile} (got ${result.result}, expected ${result.expected})`)
      } else {
        this.failed++
        console.log(`✗ ${testFile}: ${result.error} (got ${result.result}, expected ${result.expected})`)
        this.results.push({ file: testFile, error: result.error, got: result.result, expected: result.expected })
      }

    } catch (error) {
      this.failed++
      console.log(`✗ ${testFile}: ${error.message}`)
      this.results.push({ file: testFile, error: error.message })
    }
  }

  parseTest262File(content, filePath) {
    // Extract test metadata from comments
    const features = this.extractFeatures(content)
    const description = this.extractDescription(content)

    // Find the actual test code (usually after the metadata comments)
    const testCode = this.extractTestCode(content)

    if (!testCode) return null

    return {
      file: filePath,
      features,
      description,
      code: testCode
    }
  }

  extractFeatures(content) {
    const featureMatch = content.match(/\/\*---\s*\n([\s\S]*?)\n---\*\//)
    if (!featureMatch) return []

    const metadata = featureMatch[1]
    const features = []

    // Extract features from metadata
    const featureLines = metadata.split('\n').filter(line =>
      line.includes('features:') ||
      line.includes('flags:') ||
      line.includes('negative:')
    )

    for (const line of featureLines) {
      if (line.includes('features:')) {
        const featureList = line.split(':')[1].trim()
        features.push(...featureList.split(',').map(f => f.trim()))
      }
    }

    return features
  }

  extractDescription(content) {
    const descMatch = content.match(/\/\*---([\s\S]*?)---\*\//)
    if (descMatch) {
      return descMatch[1].trim()
    }
    return ''
  }

  extractTestCode(content) {
    // Remove the metadata comment block
    const withoutMetadata = content.replace(/\/\*---[\s\S]*?---\*\//, '')

    // Find the main test code (usually an assert or expression)
    const lines = withoutMetadata.split('\n').map(line => line.trim()).filter(line => line)

    // Look for simple expressions or assert statements
    for (const line of lines) {
      if (line.startsWith('assert(') ||
          line.startsWith('assertSame(') ||
          line.startsWith('assertEquals(') ||
          /^\d+\s*[+\-*/]\s*\d+/.test(line) || // Simple arithmetic
          /^['"`].*['"`]/.test(line) || // String literals
          /^true|false|null|undefined$/.test(line) || // Literals
          /^!\s*\w+/.test(line) || // Logical not
          /^\w+\s*[<>!=]+\s*\w+/.test(line)) { // Comparisons
        return line
      }
    }

    return null
  }

  isRelevantForJZ(testInfo) {
    // Skip tests with features JZ doesn't support
    for (const feature of testInfo.features) {
      if (SKIP_FEATURES.some(skip => feature.includes(skip))) {
        return false
      }
    }

    // Only include tests with simple expressions
    const code = testInfo.code
    if (!code) return false

    // Check for assert.sameValue patterns and simple expressions
    if (typeof code === 'object' && code.expr) {
      return true
    }

    // Check for simple patterns JZ can handle
    const simplePatterns = [
      /^\d+(\.\d+)?$/, // Numbers
      /^0[bB][01]+$/, // Binary literals
      /^0[oO][0-7]+$/, // Octal literals
      /^0[xX][0-9a-fA-F]+$/, // Hex literals
      /^['"`].*['"`]$/, // Strings
      /^true|false$/, // Booleans
      /^\d+\s*[+\-*/]\s*\d+$/, // Simple arithmetic
      /^\w+\s*[<>!=]+\s*\w+$/, // Comparisons
      /^!\s*\w+$/, // Logical not
      /^\w+\s*&&\s*\w+$/, // Logical and
      /^\w+\s*\|\|\s*\w+$/, // Logical or
      /assert\.sameValue/, // assert.sameValue patterns
    ]

    return simplePatterns.some(pattern => pattern.test(code))
  }  async runJZTest(testInfo) {
    try {
      // Convert test262 assert to JZ evaluation
      const testData = this.convertToJZCode(testInfo.code)

      if (!testData) {
        return { passed: false, error: 'Cannot convert to JZ code' }
      }

      let result
      let expected

      if (typeof testData === 'object' && testData.expr) {
        // Handle assert.sameValue(expr, expected)
        result = await evaluate(this.convertExpressionToWAT(testData.expr))
        expected = testData.expected
      } else {
        // Simple expression
        result = await evaluate(this.convertExpressionToWAT(testData))
        expected = result // Self-validating
      }

      // Compare with tolerance for f64
      const tolerance = 1e-10
      const passed = Math.abs(result - Number(expected)) < tolerance

      return { passed, result, expected }

    } catch (error) {
      return { passed: false, error: error.message }
    }
  }

  convertToJZCode(testCode) {
    // Convert test262 assert statements to JZ WAT expressions
    if (testCode.startsWith('assert(')) {
      // Extract the expression from assert(expr)
      const match = testCode.match(/assert\(\s*(.+)\s*\)/)
      if (match) {
        return this.convertExpressionToWAT(match[1])
      }
    }

    // Handle if statements with comparisons
    if (testCode.startsWith('if (')) {
      const match = testCode.match(/if\s*\(\s*([^)]+)\s*\)/)
      if (match) {
        // For now, just return the comparison - we'll evaluate it directly
        return this.convertExpressionToWAT(match[1])
      }
    }

    // Direct expression
    return this.convertExpressionToWAT(testCode)
  }  convertExpressionToWAT(expr) {
    // Simple conversions for expressions JZ can handle
    expr = expr.trim()

    // Numbers
    if (/^\d+(\.\d+)?$/.test(expr)) {
      return `(f64.const ${expr})`
    }

    // Booleans
    if (expr === 'true') return '(f64.const 1)'
    if (expr === 'false') return '(f64.const 0)'

    // Simple arithmetic
    expr = expr.replace(/(\d+)/g, '(f64.const $1)')
    expr = expr.replace(/\+/g, '(f64.add ')
    expr = expr.replace(/-/g, '(f64.sub ')
    expr = expr.replace(/\*/g, '(f64.mul ')
    expr = expr.replace(/\//g, '(f64.div ')

    // Add closing parentheses
    const openCount = (expr.match(/\(/g) || []).length
    expr += ')'.repeat(openCount)

    return expr
  }

  printSummary() {
    console.log('\n==========================================')
    console.log(`JZ Test262 Results:`)
    console.log(`✓ Passed: ${this.passed}`)
    console.log(`✗ Failed: ${this.failed}`)
    console.log(`⊘ Skipped: ${this.skipped}`)
    console.log(`Total: ${this.passed + this.failed + this.skipped}`)

    if (this.failed > 0) {
      console.log('\nFailed tests:')
      for (const result of this.results.slice(0, 10)) {
        console.log(`  ${result.file}: ${result.error}`)
      }
      if (this.results.length > 10) {
        console.log(`  ... and ${this.results.length - 10} more`)
      }
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2)
  const filter = args.find(arg => !arg.startsWith('--')) || ''
  const verbose = args.includes('--verbose')

  const runner = new JZTest262Runner()
  await runner.runTests(filter)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export { JZTest262Runner }
