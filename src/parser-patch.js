import { idx, seek, skip, expr } from 'subscript/parse'
import { keyword, parens, word } from 'subscript/feature/justin'
import { parse } from 'subscript/feature/jessie'

const STATEMENT = 5, SEMI = 59;
const body = () =>
  parse.space() !== 123 ? expr(STATEMENT + .5) : (skip(), expr(STATEMENT - .5, 125) || null);

const checkElse = () => {
  const from = idx;
  if (parse.space() === SEMI) skip();
  parse.space();
  if (word('else')) return skip(4), true;
  return seek(from), false;
};

// Re-register 'if' with ASI state reset
keyword('if', STATEMENT + 1, () => {
  parse.space();
  const node = ['if', parens(), body()];
  if (checkElse()) {
      parse.semi = parse.newline = false;
      node.push(body());
  }
  return node;
});
