import { compile } from 'watr'
try {
  compile(['module', ['memory', 1], ['func', ['memory.copy', ['i32.const', 0], ['i32.const', 10], ['i32.const', 5]]]])
  console.log('memory.copy supported')
} catch(e) { console.log('NOT supported:', e.message.slice(0,80)) }
