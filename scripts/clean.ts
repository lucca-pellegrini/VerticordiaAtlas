#!/usr/bin/env bun

// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: Copyright © 2026 Lucca M. A. Pellegrini <lucca@verticordia.com>

// clean.ts: clean client TypeScript outfiles from public/

import { file } from "bun";

import { CLIENT_TARGETS } from "./build.ts";

for (const target of CLIENT_TARGETS) if (await file(target.outfile).exists()) file(target.outfile).delete();