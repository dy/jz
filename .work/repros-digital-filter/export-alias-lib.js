export default function foo(x) { return bar(x) }
function bar(x) { return x * 2 }
export { bar as baz }
