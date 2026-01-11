import {parse as justin} from 'subscript/justin';

function normalize(ast) {
  console.log('normalize called with:', JSON.stringify(ast));

  if (ast === null) return [, 0];
  if (typeof ast === 'number') return [, ast];
  if (typeof ast === 'boolean') return [, ast];
  if (typeof ast === 'string') {
    if (ast === 'null') return [, null];
    if (ast === 'undefined') return [, undefined];
    return ast;
  }

  if (!Array.isArray(ast)) throw new Error('Unsupported AST: ' + JSON.stringify(ast));

  const [op, ...args] = ast;
  console.log('  op:', op, 'args:', JSON.stringify(args));

  if (op === undefined || op === null) {
    return [, args[0]];
  }

  const normOp = (op === '+' || op === '-') && args.length === 1 ? 'u' + op : op;

  if (op === '()' && args.length === 1) return normalize(args[0]);

  if (op === '()') {
    const fn = normalize(args[0]);
    if (args.length === 2 && args[1] === null) {
      return ['()', fn];
    }
    if (args.length === 2 && Array.isArray(args[1]) && args[1][0] === ',') {
      return ['()', fn, ...args[1].slice(1).map(normalize)];
    }
    return ['()', fn, ...args.slice(1).map(normalize)];
  }

  if (op === '[]') {
    console.log('  [] branch: args.length =', args.length, 'args[0] =', args[0]);
    if (args.length === 1) {
      if (args[0] === null) {
        console.log('  returning empty array');
        return ['['];
      }
      const inner = args[0];
      if (Array.isArray(inner) && inner[0] === ',') {
        return ['[', ...inner.slice(1).map(normalize)];
      }
      return ['[', normalize(inner)];
    }
    return ['[]', normalize(args[0]), normalize(args[1])];
  }

  return [normOp, ...args.map(normalize)];
}

const ast = justin('[].length');
console.log('raw AST:', JSON.stringify(ast));
console.log('result:', JSON.stringify(normalize(ast)));
