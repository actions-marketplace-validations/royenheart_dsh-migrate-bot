# boot-break fixture

A deliberate counter-example for the boot probe (`verify.boot`). It is a valid
out-of-tree plugin package: `package.json` declares `dsh.bundle.patch`, the
patch inserts its own row, and the module resolves. It fails only when the host
applies it, which is exactly the class of breakage a typecheck cannot see.

Expected probe outcome: `fail`, with the host naming the plugin.
