# Third-party notices and design references

GitHubProxyAPI is an independent TypeScript implementation. Its original code is licensed under the MIT license in [LICENSE](LICENSE). The projects below informed the design; their Go source is not imported, linked, or intentionally copied verbatim. We preserve their license notices here in recognition of that influence and to retain attribution for any adaptation of their solutions.

## bored-engineer design references

- **[bored-engineer/github-api-proxy](https://github.com/bored-engineer/github-api-proxy)** — commit [`4081191d93a09128278fa8f9e96cb42737f45bfe`](https://github.com/bored-engineer/github-api-proxy/tree/4081191d93a09128278fa8f9e96cb42737f45bfe). Its [main.go](https://github.com/bored-engineer/github-api-proxy/blob/4081191d93a09128278fa8f9e96cb42737f45bfe/main.go) informed the Unix-socket listener and shared personal/App credential-pool architecture. Our implementation adds conservative request classification and preserves the caller's identity for unsupported requests. [Upstream license](https://github.com/bored-engineer/github-api-proxy/blob/4081191d93a09128278fa8f9e96cb42737f45bfe/LICENSE).
- **[bored-engineer/github-rate-limit-http-transport](https://github.com/bored-engineer/github-rate-limit-http-transport)** — commit [`2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9`](https://github.com/bored-engineer/github-rate-limit-http-transport/tree/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9). Its [balancing.go](https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/balancing.go) informed quota-aware credential selection. Our scheduler independently implements resource budgets, in-flight reservations and secondary-limit cooldowns. [Upstream license](https://github.com/bored-engineer/github-rate-limit-http-transport/blob/2ca9b28f33fcc48efeafcc5c58d93dfc48d1cdc9/LICENSE).
- **[bored-engineer/github-auth-http-transport](https://github.com/bored-engineer/github-auth-http-transport)** — commit [`0c0f46e19a70033d98a7138ede5c59467ab5c81b`](https://github.com/bored-engineer/github-auth-http-transport/tree/0c0f46e19a70033d98a7138ede5c59467ab5c81b). Its [app.go](https://github.com/bored-engineer/github-auth-http-transport/blob/0c0f46e19a70033d98a7138ede5c59467ab5c81b/app.go) informed the installation-authentication lifecycle. Our provider independently signs RS256 JWTs with Node.js and mints, validates, scopes and refreshes installation tokens. [Upstream license](https://github.com/bored-engineer/github-auth-http-transport/blob/0c0f46e19a70033d98a7138ede5c59467ab5c81b/LICENSE).

### License for github-api-proxy and github-rate-limit-http-transport

The following identical notice was retrieved from both pinned upstream repositories:

```text
MIT License

Copyright (c) 2025 Luke Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License for github-auth-http-transport

```text
MIT License

Copyright (c) 2024 Luke Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Imported runtime dependencies

Unlike the design references above, these packages are actual npm dependencies. Exact installed versions are pinned in `package-lock.json`. Their distributed packages retain their own license files.

### graphql — MIT

[GraphQL.js](https://github.com/graphql/graphql-js) provides GraphQL parsing, schema validation and variable coercion. License from the installed package:

```text
MIT License

Copyright (c) GraphQL Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### yaml — ISC

[yaml](https://github.com/eemeli/yaml) provides YAML configuration parsing and serialization. License from the installed package:

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Runtime and development tools

Node.js is a required external runtime; no Node.js distribution is bundled with this package. Its built-in HTTP, crypto, filesystem and other APIs are used under the [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE).

TypeScript, tsx and @types/node are development dependencies, with their transitive dependencies recorded in `package-lock.json`; their license notices remain in their npm distributions. They are not a source of upstream proxy code.
