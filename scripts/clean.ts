#!/usr/bin/env bun
// clean.ts: clean client TypeScript outfiles from public/

import { file } from "bun";

import { CLIENT_TARGETS } from "./build.ts";

for (const target of CLIENT_TARGETS) if (await file(target.outfile).exists()) file(target.outfile).delete();