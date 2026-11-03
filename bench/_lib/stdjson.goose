// The standard library's json module for bench/json/json.goose. Imports
// resolve the program's own files before the standard library, so from a root
// file named json.goose, `import json;` finds that file itself; imported from
// here, a module of the bench package, the name reaches the standard library.

import json;
